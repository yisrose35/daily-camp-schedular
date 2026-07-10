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

    // ★ Pull the AUTHORITATIVE league history straight from the cloud right before a
    //   generation, so today's matchups/sports are chosen from the true cross-session
    //   record (not a stale in-memory copy from another device/tab/session). Best-
    //   effort + time-boxed: any failure leaves the existing hydrated copy in place so
    //   generation is never blocked. Writes the fetched value into globalSettings +
    //   the localStorage backup so the engine's sync loadLeagueHistory() reads it.
    Leagues.refreshHistoryFromCloud = async function () {
        try {
            const sb = (typeof window !== 'undefined') && window.supabase;
            const campId = (typeof window !== 'undefined') && window.CampistryDB && window.CampistryDB.getCampId && window.CampistryDB.getCampId();
            if (!sb || !campId) { console.log('[RegularLeagues] cloud refresh skipped (no client/camp)'); return false; }
            const q = sb.from('camp_state_kv').select('value').eq('camp_id', campId).eq('key', 'leagueHistory').maybeSingle();
            const timeout = new Promise(function (res) { setTimeout(function () { res({ _timedOut: true }); }, 6000); });
            const r = await Promise.race([q, timeout]);
            if (r && r._timedOut) { console.warn('[RegularLeagues] cloud history refresh timed out — using existing copy'); return false; }
            if (r && r.error) { console.warn('[RegularLeagues] cloud history refresh error — using existing copy:', r.error); return false; }
            const cloud = r && r.data && r.data.value;
            if (!cloud || typeof cloud !== 'object' || !cloud.gameLog) { console.log('[RegularLeagues] no cloud history to refresh'); return false; }
            // Adopt the cloud copy unless our in-memory/local copy is strictly newer
            // (an unsynced local edit must not be clobbered — mirrors LG-7 recency).
            let localSavedAt = 0;
            try {
                const cur = (window.loadGlobalSettings && window.loadGlobalSettings().leagueHistory) || {};
                localSavedAt = Number(cur._savedAt) || 0;
                const raw = localStorage.getItem(LEAGUE_HISTORY_KEY);
                if (raw) { const l = JSON.parse(raw); localSavedAt = Math.max(localSavedAt, Number(l._savedAt) || 0); }
            } catch (_) {}
            if ((Number(cloud._savedAt) || 0) < localSavedAt) {
                console.log('[RegularLeagues] local league history is newer than cloud — keeping local');
                return false;
            }
            if (typeof window.saveGlobalSettings === 'function') { try { window.saveGlobalSettings('leagueHistory', cloud); } catch (_) {} }
            try { localStorage.setItem(LEAGUE_HISTORY_KEY, JSON.stringify(cloud)); } catch (_) {}
            console.log('[RegularLeagues] ☁️ Refreshed league history from cloud (' +
                Object.keys(cloud.gameLog || {}).length + ' league(s))');
            return true;
        } catch (e) {
            console.warn('[RegularLeagues] cloud history refresh failed — using existing copy:', e);
            return false;
        }
    };

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

    // ★ Date-ordered sport history from the date-keyed gameLog, restricted to
    // dates strictly BEFORE `beforeDate`. The flat teamSports array is appended
    // in GENERATION order, so when an older/middle date is regenerated while later
    // dates already exist, its tail is a FUTURE date — which corrupts the
    // "most-recent sport" and "stuck streak" signals (observed live: regenerating
    // a middle date made the engine read future dates as "recent"). gameLog is
    // keyed by calendar date, so this returns the true through-yesterday history
    // regardless of generation order. Falls back to the flat array only when the
    // league has no gameLog at all (legacy data).
    function getTeamSportHistoryByDate(leagueName, team, history, beforeDate) {
        const gl = history.gameLog && history.gameLog[leagueName];
        if (!gl) return getTeamSportHistory(leagueName, team, history);
        const out = [];
        Object.keys(gl).sort().forEach(function (d) {
            if (beforeDate && d >= beforeDate) return;
            (gl[d] || []).forEach(function (e) {
                if (e && e.sport && (e.t1 === team || e.t2 === team)) out.push(e.sport);
            });
        });
        return out;
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

    // ★ Meeting count derived from the date-keyed gameLog (dates ≤ asOfDate),
    // mirroring getTeamSportHistoryByDate. The flat matchupHistory aggregate is
    // NOT regen-safe: rollbackDayRecords can only subtract games that are IN the
    // gameLog, so any meetings recorded before the gameLog existed (FN-54) are
    // frozen in the aggregate forever while regenerated pairs get decremented —
    // the counts INVERT (the most-played pair looks least-played), and the
    // pairing optimizer then keeps re-selecting it (observed live: a 4-team
    // league pinned to 1v2/3v4 every game). Counting straight from the gameLog
    // is immune: a never-logged pair is simply 0, and today's in-progress games
    // (logged incrementally before the next game is paired) are included so
    // back-to-back games on the same day still rotate. Falls back to the flat
    // aggregate only when the league has no gameLog at all (pure legacy data).
    function getMatchupCountByDate(leagueName, team1, team2, history, asOfDate) {
        const gl = history.gameLog && history.gameLog[leagueName];
        if (!gl) return getMatchupCount(leagueName, team1, team2, history);
        const key = getMatchupKey(team1, team2);
        let n = 0;
        Object.keys(gl).forEach(function (d) {
            if (asOfDate && d > asOfDate) return;          // ignore strictly-future dates
            (gl[d] || []).forEach(function (e) {
                if (e && getMatchupKey(e.t1, e.t2) === key) n++;
            });
        });
        return n;
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

    function rollbackDayRecords(leagueName, date, history, preservedLabels) {
        const entries = history.gameLog?.[leagueName]?.[date];
        if (!entries || !entries.length) return 0;
        // ★ Per-tile regen: games whose period is NOT being re-rolled keep their
        //   log records (else the day's game count drops and the Leagues results
        //   page loses the game). preservedLabels = Set of gameLabels to keep.
        const _keep = (preservedLabels && preservedLabels.size)
            ? entries.filter(function (e) { return e && e.g && preservedLabels.has(e.g); })
            : [];
        const _roll = (_keep.length) ? entries.filter(function (e) { return _keep.indexOf(e) < 0; }) : entries;
        _roll.forEach(function (e) {
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
        const n = _roll.length;
        if (_keep.length) history.gameLog[leagueName][date] = _keep;
        else delete history.gameLog[leagueName][date];
        console.log(`[RegularLeagues] ↩️ Rolled back ${n} logged game record(s) for "${leagueName}" on ${date}` +
            (_keep.length ? ` (kept ${_keep.length} preserved record(s))` : ''));
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

    // =========================================================================
    // ★★★ SPORT CYCLES — a team's sport "need" RESETS once it has played
    // everything ★★★
    // =========================================================================
    // Sport freshness used to be a binary played-ever set (`playedSet.has(s)`),
    // so after one full pass through the league's sports EVERY sport looked
    // stale: the sport term canceled out of every pairing/assignment decision
    // and the two variety modes stopped meaning anything — exactly at the point
    // in the season where "a new opponent AND a new sport" first becomes
    // impossible and the mode is supposed to break the tie. Cycle semantics fix
    // that: a team works through every available sport once (cycle 1), then all
    // sports become needed again and it works through them again (cycle 2), etc.
    //
    //   gap(team, sport) = plays(sport) − min plays across today's available
    //                      sports. 0 → needed THIS cycle (fresh); 1 → would
    //                      start the next cycle early; 2 → two cycles ahead…
    //
    // The min is taken over TODAY'S available sports (not the league's full
    // configured list) so a configured-but-never-available sport can't pin the
    // whole league at "cycle never completes". Counts come from the date-keyed
    // history (getTeamSportHistoryByDate) so they're regeneration/delete-safe.
    function makeSportCycles(leagueName, teams, cycleSports, history, dayId) {
        const counts = {};
        (teams || []).forEach(function (t) {
            const c = {};
            getTeamSportHistoryByDate(leagueName, t, history, dayId)
                .forEach(function (s) { c[s] = (c[s] || 0) + 1; });
            counts[t] = c;
        });
        const mins = {};
        Object.keys(counts).forEach(function (t) {
            let m = Infinity;
            (cycleSports || []).forEach(function (s) {
                const c = counts[t][s] || 0;
                if (c < m) m = c;
            });
            mins[t] = (m === Infinity) ? 0 : m;
        });
        function gap(team, sport) {
            return ((counts[team] || {})[sport] || 0) - (mins[team] || 0);
        }
        function done(team) {
            let n = 0;
            (cycleSports || []).forEach(function (s) { if (gap(team, s) > 0) n++; });
            return n;
        }
        return {
            gap: gap,
            isFresh: function (team, sport) { return gap(team, sport) === 0; },
            // Cross-team starvation rank (lower = more starved, gets first pick).
            // Completed cycles dominate: a team still missing a sport in cycle 1
            // (min 0) always outranks a team starting cycle 2 fresh (min 1) —
            // "never played football" beats "played everything once". Progress
            // within the cycle breaks ties.
            starve: function (team) { return (mins[team] || 0) * 1000 + done(team); }
        };
    }

    // Pair recency in [0,1): 0 = never met, higher = met more recently. Shared
    // by the pairing optimizers — once meeting counts tie (unavoidable in a
    // small league), the pair that met LONGEST ago should meet again first, so
    // consecutive days rotate through the distinct rounds instead of repeating
    // yesterday. Derived from the date-keyed gameLog (regen/delete-safe).
    function makePairRecency(leagueName, history, dayId) {
        const gl = (history.gameLog && history.gameLog[leagueName]) || {};
        const dates = Object.keys(gl).filter(function (d) { return !dayId || d <= dayId; }).sort();
        const denom = dates.length + 1;
        const cache = {};
        return function (a, b) {
            const key = getMatchupKey(a, b);
            if (cache[key] != null) return cache[key];
            let best = 0;
            for (let i = 0; i < dates.length; i++) {
                const entries = gl[dates[i]] || [];
                for (let j = 0; j < entries.length; j++) {
                    const e = entries[j];
                    if (e && getMatchupKey(e.t1, e.t2) === key) { best = (i + 1) / denom; break; }
                }
            }
            return (cache[key] = best);
        };
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

    function choosePairingsForSportVariety(activeTeams, availablePool, leagueName, history, fallbackMatchups, dayId) {
        try {
            if (!Array.isArray(activeTeams) || activeTeams.length < 2 || activeTeams.length > 12) return fallbackMatchups;
            if (!Array.isArray(availablePool) || availablePool.length === 0) return fallbackMatchups;
            const matchings = generatePerfectMatchings(activeTeams);
            if (matchings.length <= 1) return fallbackMatchups;

            // ★ CYCLE-AWARE freshness (see makeSportCycles): a sport is fresh for a
            //   team while its play count sits at the team's current-cycle minimum,
            //   so needs RESET once a team has played everything.
            const _svAvailSports = Array.from(new Set(availablePool.map(function (o) { return o.sport; })));
            const cycles = makeSportCycles(leagueName, activeTeams, _svAvailSports, history, dayId);

            // Score each matching: fresh = how many team-slots can receive a
            // sport that team still needs this cycle (per pair, the best single
            // option: new-to-both = 2, new-to-one = 1). Maximize fresh; tie-break
            // on fewest prior meetings (prefer fresh opponents). Cross-pair field
            // contention is ignored here — the assigner resolves it.
            let best = null, bestFresh = -1, bestMeet = Infinity;
            for (const m of matchings) {
                let fresh = 0, meet = 0;
                for (const pair of m) {
                    if (pair[0] === '__BYE__' || pair[1] === '__BYE__') continue;
                    meet += getMatchupCount(leagueName, pair[0], pair[1], history);
                    let bestPair = 0;
                    for (const o of availablePool) {
                        const s = (cycles.isFresh(pair[0], o.sport) ? 1 : 0) + (cycles.isFresh(pair[1], o.sport) ? 1 : 0);
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
    // ★★★ DAILY PAIRING OPTIMIZER — the matchup creator (BOTH modes) ★★★
    // =========================================================================
    // NO PREDETERMINED ROUND-ROBIN: every game's matchups are computed FRESH from
    // history (opponents met + sports needed). The round-robin round the caller
    // hands in is used ONLY as an error/kill-switch fallback, never as the plan.
    //
    // The rule both modes share: ALWAYS TRY FOR NEW MATCHUPS FIRST. Meetings
    // enter every pair's weight, so among pairings of equal sport value the one
    // with fewer rematches always wins. The MODE only decides the impossible
    // situation — when a new matchup and a new sport can't both happen.
    //
    // Search: EXACT for leagues of ≤12 teams (every possible pairing of the
    // league is enumerated and scored — a zero-rematch pairing can never be
    // missed); greedy max-weight matching + 2-opt refinement (O(n²)) beyond
    // that. Each candidate PAIR is weighted by:
    //   • opponent freshness  (-prior meetings) — keeps opponents rotating
    //   • sport freshness     (can this pair BOTH get a sport they still NEED in
    //                          their current cycle? 2 = both, 1 = one) — so a single
    //                          scarce field serves two needy teams instead of one
    //                          needy + a repeat. CYCLE-AWARE: once a team has played
    //                          every available sport, its needs reset and the next
    //                          cycle begins (see makeSportCycles).
    //   • pair recency        (met longest ago first) — rotates equal-met pairs so
    //                          consecutive days don't restage yesterday's games.
    // The MODE only re-weights these (per the camp's rule that BOTH rotations are
    // kept, and the mode decides the tiebreak when they conflict):
    //   • matchup_variety → opponents dominate (re-pair for sport only among
    //                       equally-met options; never trade an opponent repeat)
    //   • sport_variety   → sports dominate (will trade an opponent repeat to land a
    //                       fresh sport); fewest meetings breaks ties.
    // Always falls back to the round-robin matchups on any error. Kill switch:
    // window.__leagueDailyOptimizer = false  → legacy behavior.
    function chooseDailyMatchups(activeTeams, availablePool, leagueName, history, fallbackMatchups, dayId, mode) {
        try {
            if (typeof window !== 'undefined' && window.__leagueDailyOptimizer === false) {
                return (mode === 'sport_variety')
                    ? choosePairingsForSportVariety(activeTeams, availablePool, leagueName, history, fallbackMatchups, dayId)
                    : fallbackMatchups;
            }
            if (!Array.isArray(activeTeams) || activeTeams.length < 2) return fallbackMatchups;
            if (!Array.isArray(availablePool) || availablePool.length === 0) return fallbackMatchups;

            const teams = activeTeams.slice();
            const availSports = Array.from(new Set(availablePool.map(function (o) { return o.sport; })));
            // ★ CYCLE-AWARE freshness (see makeSportCycles): fresh = the team still
            //   needs this sport in its CURRENT cycle, so the sport signal stays
            //   alive after every team has played everything once — needs reset
            //   and the next cycle begins, instead of the sport term going dead.
            const cycles = makeSportCycles(leagueName, teams, availSports, history, dayId);
            const recency = makePairRecency(leagueName, history, dayId);

            function sportFresh(a, b) {   // 0,1,2 — best fresh-sport count for the pair today
                let best = 0;
                for (let k = 0; k < availSports.length; k++) {
                    const s = availSports[k];
                    const f = (cycles.isFresh(a, s) ? 1 : 0) + (cycles.isFresh(b, s) ? 1 : 0);
                    if (f > best) { best = f; if (best === 2) break; }
                }
                return best;
            }

            // The mode is the TIE-BREAK for the impossible situation (a fresh
            // opponent and a fresh sport can't both happen):
            //   matchup_variety → meetings dominate (1000/meeting), recency (≤100)
            //     rotates equal-met pairs, sport (≤16) breaks what's left.
            //   sport_variety → a fresh sport (300/team-slot) beats an opponent
            //     repeat (25/meeting); recency (≤10) rotates full ties.
            const isMatchup = (mode === 'matchup_variety');
            const W_OPP = isMatchup ? 1000 : 25;
            const W_SPORT = isMatchup ? 8 : 300;
            const W_REC = isMatchup ? 100 : 10;

            const metCache = {};
            function met(a, b) {
                const key = getMatchupKey(a, b);
                if (metCache[key] == null) metCache[key] = getMatchupCountByDate(leagueName, a, b, history, dayId);
                return metCache[key];
            }
            // ★ SAME-DAY OPPONENT GUARD: a pair that already met in an EARLIER
            // game TODAY (each period's games are logged before the next period
            // is paired) is penalized so heavily it acts as a hard tier — a
            // matching containing ANY same-day rematch loses to any matching
            // with none, in BOTH modes, in both the exact-search and greedy
            // branches (they share pairWeight). Without this, sport_variety's
            // tiny opponent weight (25 vs 300 per fresh sport), or a rematch
            // pair simply having met less often HISTORICALLY than every
            // alternative pairing, let the optimizer hand two teams the same
            // opponent twice in one day. When every possible matching repeats
            // a pair (2-team league), the penalty is uniform across matchings
            // and the normal weights decide — the game still runs, never a
            // bye. The off-campus double-header path already hard-excludes
            // game-1 pairs (ocFindRepairings).
            // Killswitch: window.__leagueSameDayOpponentGuard = false.
            const todayMetCache = {};
            function metToday(a, b) {
                const key = getMatchupKey(a, b);
                if (todayMetCache[key] == null) {
                    let n = 0;
                    ((history.gameLog && history.gameLog[leagueName] && history.gameLog[leagueName][dayId]) || [])
                        .forEach(function (e) { if (e && e.t1 && e.t2 && getMatchupKey(e.t1, e.t2) === key) n++; });
                    todayMetCache[key] = n;
                }
                return todayMetCache[key];
            }
            const W_SAMEDAY = (typeof window !== 'undefined' && window.__leagueSameDayOpponentGuard === false) ? 0 : 10000000;
            function pairWeight(a, b) {
                return (-met(a, b)) * W_OPP + sportFresh(a, b) * W_SPORT - recency(a, b) * W_REC - metToday(a, b) * W_SAMEDAY;
            }

            let matching;
            if (teams.length <= 12) {
                // ★ EXACT SEARCH (≤12 teams — the common case): enumerate EVERY way
                //   to pair up the league (12 teams → 10,395 matchings) and take the
                //   best-scoring one. This makes "always try for new matchups first"
                //   a hard guarantee: because meetings carry the dominant weight in
                //   matchup mode (and break sport ties in sport mode), a pairing with
                //   fewer rematches ALWAYS outranks one with more — if a zero-rematch
                //   pairing exists, it is found, never missed by a greedy heuristic.
                //   Odd team counts get a bye pair; the benched team is the one whose
                //   sitting out best serves the rotations (self-correcting: a team
                //   left out keeps its meeting counts low, which raises its pair
                //   weights until it plays).
                const cachedW = {};
                function w(a, b) {
                    const key = getMatchupKey(a, b);
                    if (cachedW[key] == null) cachedW[key] = pairWeight(a, b);
                    return cachedW[key];
                }
                const matchings = generatePerfectMatchings(teams);
                let best = null, bestW = -Infinity, bestMet = Infinity;
                for (const m of matchings) {
                    let totalW = 0, totalMet = 0;
                    for (const p of m) {
                        if (p[0] === '__BYE__' || p[1] === '__BYE__') continue;
                        totalW += w(p[0], p[1]);
                        totalMet += met(p[0], p[1]);
                    }
                    // Fewest total meetings breaks exact weight ties → new matchups
                    // win even when the weighted scores come out equal.
                    if (totalW > bestW || (totalW === bestW && totalMet < bestMet)) {
                        best = m; bestW = totalW; bestMet = totalMet;
                    }
                }
                if (!best) return fallbackMatchups;
                matching = best
                    .filter(function (p) { return p[0] !== '__BYE__' && p[1] !== '__BYE__'; })
                    .map(function (p) { return [p[0], p[1]]; });
            } else {
                // ★ LARGE LEAGUES (>12 teams): greedy max-weight matching + 2-opt
                //   refinement — near-optimal in O(n²), scales to any size.
                const pairs = [];
                for (let i = 0; i < teams.length; i++) {
                    for (let j = i + 1; j < teams.length; j++) {
                        const a = teams[i], b = teams[j];
                        pairs.push({ a, b, met: met(a, b), w: pairWeight(a, b) });
                    }
                }
                // Best pair first, fewest meetings breaks ties.
                pairs.sort(function (x, y) { return (y.w - x.w) || (x.met - y.met); });
                const used = new Set();
                matching = [];
                for (let k = 0; k < pairs.length; k++) {
                    const p = pairs[k];
                    if (used.has(p.a) || used.has(p.b)) continue;
                    matching.push([p.a, p.b]); used.add(p.a); used.add(p.b);
                }

                // ★ 2-OPT REFINEMENT: greedy matching can strand weight — the best
                //   single pair can force two bad leftover pairs when a slightly
                //   worse first pick would let BOTH remaining pairs be good. Swap
                //   partners between pairs while total weight improves (monotonic,
                //   bounded → terminates). O(n²) per sweep.
                let improved = true, guard = 0;
                while (improved && guard < 300) {
                    improved = false; guard++;
                    for (let i = 0; i < matching.length && !improved; i++) {
                        for (let j = i + 1; j < matching.length; j++) {
                            const a = matching[i][0], b = matching[i][1], c = matching[j][0], d = matching[j][1];
                            const base = pairWeight(a, b) + pairWeight(c, d);
                            const s1 = pairWeight(a, c) + pairWeight(b, d);   // [a,c] [b,d]
                            const s2 = pairWeight(a, d) + pairWeight(b, c);   // [a,d] [b,c]
                            if (s1 > base && s1 >= s2) { matching[i] = [a, c]; matching[j] = [b, d]; improved = true; break; }
                            if (s2 > base) { matching[i] = [a, d]; matching[j] = [b, c]; improved = true; break; }
                        }
                    }
                }
            }
            if (!matching || !matching.length) return fallbackMatchups;   // (odd team left over = bye, handled by caller)

            const _key = function (ms) { return ms.map(function (p) { return p.slice().sort().join('v'); }).sort().join(','); };
            if (_key(matching) !== _key(fallbackMatchups)) {
                console.log('   ★ [DailyOptimizer/' + mode + '] pairings chosen from history: '
                    + matching.map(function (p) { return p[0] + ' vs ' + p[1]; }).join(', '));
            }
            return matching;
        } catch (e) {
            console.warn('[RegularLeagues] daily matchup optimizer failed — using round-robin:', e);
            return fallbackMatchups;
        }
    }

    // =========================================================================
    // ★★★ FIELD AVAILABILITY - WITH GLOBAL LOCK CHECK ★★★
    // =========================================================================

    function buildAvailableFieldSportPool(leagueSports, context, divisionNames, timeKey, slots, blockEndMin, awayZoneName, reservedAwayZones) {
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

        // ★ Shut-off: a sport turned OFF for a specific field TODAY in Daily
        //   Adjustments (dailyDisabledSportsByField) blocks SPORT placement via
        //   canBlockFit, but leagues build their OWN field/sport pool and never
        //   consulted it — so a league whose sport was disabled on a court could
        //   still be handed that court. Resolve the per-date map once (same
        //   sources the sport fillers use, keyed to the authoritative gen-date)
        //   and drop the affected (field, sport) pairs in the sport loop below.
        const _leagueDisabledSportsByField = (function () {
            try {
                const dd = window.loadCurrentDailyData ? window.loadCurrentDailyData() : null;
                if (dd && dd.dailyDisabledSportsByField && Object.keys(dd.dailyDisabledSportsByField).length) {
                    return dd.dailyDisabledSportsByField;
                }
            } catch (_e) {}
            try {
                const _dk = window._activeGenDate || window.currentScheduleDate || '';
                if (_dk) {
                    const _s = localStorage.getItem('campResourceOverrides_' + _dk);
                    if (_s) {
                        const _p = JSON.parse(_s);
                        if (_p && _p.dailyDisabledSportsByField) return _p.dailyDisabledSportsByField;
                    }
                }
            } catch (_e) {}
            return {};
        })();

        const _poolDivSlots = window.divisionTimes?.[divisionNames[0]] || [];
        // ★ CROSS-LEAGUE DOUBLE-BOOK FIX: anchor the period window on the
        //   authoritative WALL-CLOCK time, not on indexing the shared `slots`
        //   array into THIS division's grid. `slots` is taken from one division's
        //   block (allBlocks[0]); in manual mode divisions have different
        //   skeletons, so the same slot INDEX maps to a different clock time in
        //   another division's grid. That made a second league's lock check query
        //   the wrong window, miss the first league's live field lock, and hand
        //   out the same field twice. timeKey IS the shared startMin for every
        //   division at this period (blocksByTime groups by it); blockEndMin is
        //   the period end. The per-division grid is only a fallback.
        const _parsePoolMin = window.SchedulerCoreUtils?.parseTimeToMinutes;
        const _toPoolMin = (v) => {
            if (v == null) return null;
            if (typeof v === 'number') return isNaN(v) ? null : v;
            const n = _parsePoolMin ? _parsePoolMin(v) : Number(v);
            return (n == null || isNaN(Number(n))) ? null : Number(n);
        };
        let _poolStartMin = _toPoolMin(timeKey);
        let _poolEndMin = _toPoolMin(blockEndMin);
        if (_poolStartMin == null && slots && slots.length > 0) _poolStartMin = _poolDivSlots[slots[0]]?.startMin;
        if (_poolEndMin == null && slots && slots.length > 0) _poolEndMin = _poolDivSlots[slots[slots.length - 1]]?.endMin;
        if (_poolStartMin != null && (_poolEndMin == null || _poolEndMin <= _poolStartMin)) _poolEndMin = _poolStartMin + 40;

        for (const field of allFields) {
            if (!field || !field.name) continue;
            if (field.available === false) continue;
            if (disabledFields && disabledFields.includes(field.name)) continue;
            if (_leagueSpecialRooms.has(String(field.name).toLowerCase().trim())) {
                console.log(`[RegularLeagues] ⚠️ Field "${field.name}" is a special-activity room — reserved for specials, not available to leagues`);
                continue;
            }

            // ★★★ AWAY-ZONE RESERVATION: a field is reserved for Away games when its
            //   zone is EITHER off-campus OR an away destination this period
            //   (reservedAwayZones). It's admitted ONLY to the league going Away to THAT
            //   zone (awayZoneName); every other league excludes it. Without this, the
            //   non-away leagues — processed in seniority order BEFORE the away league —
            //   consume the zone's courts, so the away game finds its own zone locked and
            //   silently falls back on campus ("...no available fields; keeping full
            //   pool"). Keyed on the away FLAG, not isOffCampus alone, because an Away
            //   zone need not be marked off-campus. Fields in no zone (getZoneForField →
            //   null) are unaffected, so camps without zones/away games see no change.
            if (typeof window.getZoneForField === 'function') {
                const _fldZone = window.getZoneForField(field.name);
                if (_fldZone && _fldZone.name !== awayZoneName &&
                    (_fldZone.isOffCampus === true ||
                     (reservedAwayZones && reservedAwayZones.has && reservedAwayZones.has(_fldZone.name)))) {
                    continue;
                }
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

            // ★★★ CHECK DAILY-ADJUSTMENTS FIELD RESERVATIONS (division-aware) ★★★
            // A reservation tile (a skeleton tile carrying reservedFields — e.g. a pinned
            // "Masmidim" tile reserving "Home Run Stadium" for division מתמדים) is extracted
            // into window.fieldReservations (Utils.getFieldReservationsFromSkeleton) and
            // already blocks SPORT placement via canBlockFit. But leagues only consulted
            // GlobalFieldLocks — never window.fieldReservations — so a reserved field that
            // wasn't ALSO registered as a GlobalFieldLock looked free to a league and got
            // double-booked (CONFIRMED live: מתמדים's Home Run Stadium reservation @3:30-4:30
            // handed to the 6th-grade league).
            // DIVISION-AWARE: only block when the reservation belongs to a DIFFERENT division
            // than the one(s) this league serves. A division reserves its OWN signup-league
            // field pool (e.g. div 8/9 "Signup leagues"), and that division's own league MUST
            // still be able to use it — so a same-division reservation never blocks.
            if (window.fieldReservations && _poolStartMin != null && _poolEndMin != null) {
                const _resvList = window.fieldReservations[field.name] || [];
                const _curDivs = (divisionNames || []).map(d => String(d).toLowerCase().trim());
                const _foreign = _resvList.find(r =>
                    r && r.startMin < _poolEndMin && r.endMin > _poolStartMin &&
                    r.division && !_curDivs.includes(String(r.division).toLowerCase().trim()));
                if (_foreign) {
                    console.log(`[RegularLeagues] ⚠️ Field "${field.name}" reserved by ${_foreign.division} ("${_foreign.event}") ${_foreign.startMin}-${_foreign.endMin} — not available to this league`);
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
                // ★ Shut-off: this sport is turned off on this field for today.
                const _dsList = _leagueDisabledSportsByField[field.name];
                if (_dsList && (Array.isArray(_dsList) ? _dsList.includes(sport)
                        : (typeof _dsList.has === 'function' && _dsList.has(sport)))) {
                    console.log(`[RegularLeagues] ⚠️ Sport "${sport}" disabled on field "${field.name}" today — not offered to leagues`);
                    continue;
                }

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
    // ★ BYE / SKIPPED-GAME REPORT — the user must be TOLD when a matchup gets a
    // forced bye (or a whole league period can't run) because fields ran out,
    // not discover "Team — Bye" / free-filled bunks on the grid. Collected
    // during each processRegularLeagues run, published on
    // window.__leagueByeReport, and dispatched as the
    // 'campistry-league-bye-warnings' event consumed by coverage_warning.js.
    // Killswitch: window.__leagueByeNotify = false (report still collected on
    // window.__leagueByeReport; no event → no panel).
    // Entry shape: { league, kind: 'bye'|'skipped', team1?, team2?, time?, game?, reason }
    // =========================================================================
    let _byeReport = [];
    let _byeCtx = null;   // { time, game } — stamped by the assigner call sites

    function _recordByeEvent(entry) {
        try {
            if (_byeCtx) {
                if (entry.time == null) entry.time = _byeCtx.time;
                if (entry.game == null) entry.game = _byeCtx.game;
            }
            // blocksByTime keys are strings — hand consumers minutes as a number
            if (entry.time != null && entry.time !== '' && !isNaN(Number(entry.time))) entry.time = Number(entry.time);
            _byeReport.push(entry);
        } catch (_) {}
    }

    // Matchup-level forced bye. Every filter between the pool and the pick has
    // a non-empty fallback, so a null pick means the pool itself ran dry:
    // either the league had NO field options at this time, or every open field
    // was already claimed by this period's earlier matchups (incl. combined-
    // field counterparts). Say which, with the numbers.
    function _recordForcedBye(leagueName, t1, t2, availablePool, gamesWanted, gamesPlaced) {
        const fields = new Set();
        (availablePool || []).forEach(function (o) { if (o && o.field) fields.add(o.field); });
        const nf = fields.size;
        let reason;
        if (nf === 0) {
            reason = 'No fields were open for this league\'s sports at this time — every matching field was reserved, locked, or in use by another league or division.';
        } else {
            const names = Array.from(fields);
            const shown = names.slice(0, 4).join(', ') + (names.length > 4 ? ', …' : '');
            reason = 'Not enough fields: ' + gamesWanted + ' simultaneous game' + (gamesWanted === 1 ? '' : 's')
                + ' needed but only ' + nf + ' field' + (nf === 1 ? ' was' : 's were')
                + ' open for this league (' + shown + ') — every open field was already taken by another matchup this period, so '
                + t1 + ' vs ' + t2 + ' got a bye.';
        }
        _recordByeEvent({ league: leagueName, kind: 'bye', team1: t1, team2: t2, reason: reason });
    }

    // Structural bye: an active team that never entered a matchup this period
    // (e.g. an odd number of teams means one rotates to a bye each round). It
    // shows as "Team — Bye" on the grid just like a field-shortage bye, so it
    // must be reported too — with its OWN reason (not a field problem). Teams
    // whose matchup WAS chosen but lost its field are already reported pairwise
    // by _recordForcedBye (they're in `matchups`), so this only covers the
    // never-paired ones — the two sets are disjoint, no double count.
    function _recordUnpairedByes(leagueName, activeTeams, matchups) {
        try {
            const teams = activeTeams || [];
            const paired = new Set();
            (matchups || []).forEach(function (m) {
                const a = Array.isArray(m) ? m[0] : m;
                const b = Array.isArray(m) ? m[1] : null;
                if (a) paired.add(a);
                if (b) paired.add(b);
            });
            const odd = teams.length % 2 === 1;
            teams.forEach(function (t) {
                if (!t || paired.has(t)) return;
                _recordByeEvent({
                    league: leagueName, kind: 'bye', team1: t, team2: null,
                    reason: odd
                        ? ('This league has an odd number of teams playing this period (' + teams.length
                            + '), so one team rotates to a bye each round — this is not a field shortage. '
                            + 'Add or remove a team for full pairings.')
                        : 'This team was not paired into a game this period, so it is on a bye.'
                });
            });
        } catch (_) {}
    }

    function _publishByeReport() {
        try {
            window.__leagueByeReport = _byeReport.slice();
            if (_byeReport.length) {
                console.warn('⚠️ [LeagueByes] ' + _byeReport.length + ' league matchup(s)/period(s) could not be placed:');
                _byeReport.forEach(function (b) {
                    console.warn('   • ' + b.league + (b.game != null ? ' (Game ' + b.game + ')' : '') + ': '
                        + (b.kind === 'skipped' ? 'PERIOD SKIPPED' : (b.team1 + ' vs ' + b.team2 + ' → BYE'))
                        + ' — ' + b.reason);
                });
            }
            if (window.__leagueByeNotify === false) return;
            // Empty dispatch too — a clean regen must CLEAR a stale banner.
            if (typeof window.CustomEvent === 'function' && typeof window.dispatchEvent === 'function') {
                window.dispatchEvent(new window.CustomEvent('campistry-league-bye-warnings', {
                    detail: { count: _byeReport.length, items: _byeReport.slice() }
                }));
            }
        } catch (_) {}
    }

    // =========================================================================
    // FIELD QUALITY — prefer the better-ranked field in a group
    // =========================================================================
    // Builds a {fieldName: qualityRank} map (lower rank = better field). Used to
    // bias league field selection toward the best field in each quality group, so
    // a league claims rank-1 before rank-2, etc. The bonus is kept BELOW the
    // sport-variety swing (±500) so it orders fields without flipping which SPORT a
    // matchup gets. Ungrouped fields get no bonus.
    function _buildFieldQualityRankMap() {
        const m = {};
        try {
            const flds = ((window.loadGlobalSettings && window.loadGlobalSettings().app1) || {}).fields || [];
            flds.forEach(f => { if (f && f.name && f.fieldGroup && f.qualityRank) m[f.name] = parseInt(f.qualityRank) || 999; });
        } catch (_e) {}
        return m;
    }
    function _fieldQualityBonus(rankMap, fieldName) {
        const r = rankMap[fieldName];
        if (r == null) return 0;                 // ungrouped → neutral
        return Math.max(0, 200 - r * 12);        // rank 1 ≈ +188 … rank 15 ≈ +20
    }

    // ★ "Stuck" measure: how many of a team's most-recent games were the SAME
    // sport in a row. A team on a long single-sport streak (e.g. basketball 4
    // days running) is the most urgent to hand something new — so the assigners
    // process the most-stuck matchups FIRST, giving them first pick of the
    // league's limited diverse fields before those fields are taken by others.
    function _trailingSportStreak(hist) {
        if (!hist || !hist.length) return 0;
        const last = hist[hist.length - 1];
        let n = 0;
        for (let i = hist.length - 1; i >= 0 && hist[i] === last; i--) n++;
        return n;
    }

    // ★ FN-57 caveat, CYCLE-AWARE: when a pair meets again, prefer the sport(s)
    // this pair has played TOGETHER the fewest times. Cycle 1 behaves like the
    // old binary filter (never replay a pair sport while an unplayed one
    // exists); once the pair has played every available sport together, the
    // filter used to give up entirely ("allowing a repeat" from the whole
    // pool) — now the pair starts a new cycle: least-replayed sports first.
    function _filterPoolByPairSportCycle(pool, leagueName, t1, t2, history) {
        const pairCounts = {};
        getPairSports(leagueName, t1, t2, history)
            .forEach(function (s) { pairCounts[s] = (pairCounts[s] || 0) + 1; });
        if (Object.keys(pairCounts).length === 0 || pool.length === 0) return pool;
        let minPair = Infinity;
        pool.forEach(function (o) {
            const c = pairCounts[o.sport] || 0;
            if (c < minPair) minPair = c;
        });
        const fresh = pool.filter(function (o) { return (pairCounts[o.sport] || 0) === minPair; });
        if (!fresh.length) return pool;
        if (minPair > 0) {
            console.log(`   ⚠️ ${t1} vs ${t2}: pair has played every available sport together — starting a new pair cycle (least-replayed first)`);
        }
        return fresh;
    }

    // ★ HARD STREAK CAP: a team may play the same sport on two CONSECUTIVE
    // game days, NEVER a third. The soft recent-sport penalty (-1500) usually
    // prevents even two in a row, but it is a preference — in a constrained
    // slot (few open fields, pair caveat narrowing the pool) a repeat can
    // still win, and because the penalty doesn't escalate with streak length,
    // nothing stopped a THIRD day. This filter makes day 3 impossible: any
    // sport equal to BOTH of a team's last two games is excluded outright.
    // Soft fallback: if every remaining option is streak-blocked (pathological
    // — e.g. a single-sport league), keep the pool so the matchup still gets
    // a game rather than being dropped.
    function _applyStreakCapFilter(pool, t1, t2, hist1, hist2) {
        if (!pool.length) return pool;
        const blocked = new Set();
        [hist1, hist2].forEach(function (hist) {
            const n = hist.length;
            if (n >= 2 && hist[n - 1] === hist[n - 2]) blocked.add(hist[n - 1]);
        });
        if (!blocked.size) return pool;
        const ok = pool.filter(function (o) { return !blocked.has(o.sport); });
        if (ok.length) return ok;
        console.log(`   ⚠️ ${t1} vs ${t2}: streak cap would empty the pool — allowing (single-sport league?)`);
        return pool;
    }

    // ★ SAME-DAY SPORT REPEAT GUARD: with 2+ league games on one day, a team
    // must not play the same sport twice THAT DAY unless there is truly no
    // other option. The day-history helpers exclude today by design
    // (getTeamSportHistoryByDate is strictly-before-dayId), so the recent-sport
    // penalty and cycle needs are BLIND to a game played earlier today — only
    // the pair caveat saw it, and only when the SAME two teams met again.
    // A team facing a different opponent in game 2 could freely repeat its
    // game-1 sport. This reads today's already-logged games straight from the
    // date-keyed gameLog and hard-filters the pool, degrading gracefully:
    //   1. options neither team has played today          (preferred)
    //   2. options at most ONE team has played today      (lesser evil)
    //   3. the full pool                                  (truly unavoidable)
    // Per-matchup — it only looks at THIS pair's two teams — so it cannot
    // re-create the league-wide pool collapse that forced byes (the deleted
    // multi-game pre-filter). A matchup is never dropped by this guard.
    // Killswitch: window.__leagueSameDayRepeatGuard = false.
    function _getTeamSportsToday(leagueName, team, history, dayId) {
        const out = new Set();
        if (!dayId) return out;
        const todays = (history.gameLog && history.gameLog[leagueName] && history.gameLog[leagueName][dayId]) || [];
        todays.forEach(function (e) {
            if (e && e.sport && (e.t1 === team || e.t2 === team)) out.add(e.sport);
        });
        return out;
    }
    function _applySameDayRepeatFilter(pool, t1, t2, leagueName, history, dayId) {
        if (window.__leagueSameDayRepeatGuard === false) return pool;
        if (!pool.length) return pool;
        const today1 = _getTeamSportsToday(leagueName, t1, history, dayId);
        const today2 = _getTeamSportsToday(leagueName, t2, history, dayId);
        if (!today1.size && !today2.size) return pool;
        const clean = pool.filter(function (o) { return !today1.has(o.sport) && !today2.has(o.sport); });
        if (clean.length) return clean;
        const oneRepeat = pool.filter(function (o) { return !(today1.has(o.sport) && today2.has(o.sport)); });
        if (oneRepeat.length) {
            console.log(`   ⚠️ ${t1} vs ${t2}: every open sport is a same-day repeat for a team — allowing the least-bad option`);
            return oneRepeat;
        }
        console.log(`   ⚠️ ${t1} vs ${t2}: same-day sport repeat unavoidable (no alternative open) — allowing`);
        return pool;
    }

    // ★ CYCLE RESCUE: a team stuck ≥2 plays behind on a sport (its count for
    // that sport trails its most-played available sport by ≥2) gets that
    // sport as a HARD preference for its matchup. Without this, a team can be
    // starved of one sport indefinitely: its daily partner keeps carrying the
    // -1500 recent-sport guard for exactly that sport, so the pair never
    // takes it (observed in the multi-league sim: a matchup_variety team
    // finished 12 days at BK1/SC5/VB6 because every day's opponent had played
    // basketball the day before). A partner playing 2-in-a-row is the lesser
    // evil; the HARD 3-in-a-row cap still applies because this runs on the
    // streak-filtered pool. Runs AFTER the fair-share cap (rescue stays
    // within the league's share) and BEFORE the pair caveat (rescue wins).
    // Assignments born from a rescue are flagged so the swap pass won't
    // trade the rescued sport away again.
    function _applyCycleRescueFilter(pool, t1, t2, hist1, hist2) {
        if (pool.length < 2) return { pool: pool, rescued: false };
        const poolSports = Array.from(new Set(pool.map(function (o) { return o.sport; })));
        if (poolSports.length < 2) return { pool: pool, rescued: false };
        function counts(hist) { const c = {}; hist.forEach(function (s) { c[s] = (c[s] || 0) + 1; }); return c; }
        const c1 = counts(hist1), c2 = counts(hist2);
        function deficit(c, s) {
            let max = 0;
            poolSports.forEach(function (sp) { const v = c[sp] || 0; if (v > max) max = v; });
            return max - (c[s] || 0);
        }
        let best = null, bestD = 0;
        poolSports.forEach(function (s) {
            const d1 = deficit(c1, s), d2 = deficit(c2, s);
            const d = (d1 >= 2 ? d1 : 0) + (d2 >= 2 ? d2 : 0);
            if (d > bestD) { bestD = d; best = s; }
        });
        if (!best) return { pool: pool, rescued: false };
        const rescuedPool = pool.filter(function (o) { return o.sport === best; });
        if (!rescuedPool.length) return { pool: pool, rescued: false };
        console.log(`   🆘 ${t1} vs ${t2}: cycle rescue → ${best} (a team is ${bestD} play(s) behind on it)`);
        return { pool: rescuedPool, rescued: true };
    }

    // =========================================================================
    // SMART ASSIGNMENT ALGORITHM - SPORT VARIETY MODE (Default)
    // =========================================================================

    function assignMatchupsToFieldsAndSports_SportVariety(matchups, availablePool, leagueName, history, slots, leagueRules, sportCaps, dayId) {
        const assignments = [];
        const _fqRank = _buildFieldQualityRankMap();
        const usedFields = new Set();
        const usedSportsThisSlot = {};
        // ★ Date-correct history (robust to regeneration order) — see getTeamSportHistoryByDate.
        const _teamHist = (t) => getTeamSportHistoryByDate(leagueName, t, history, dayId);
        // ★ CYCLE-AWARE need (see makeSportCycles): a sport is "needed" while its
        //   play count sits at the team's current-cycle minimum. Once a team has
        //   played every available sport, its needs RESET and the next cycle
        //   begins — instead of every need flattening to 0 for the rest of the
        //   season (which left field quality + randomness picking the sport).
        const _cycleTeams = Array.from(new Set(matchups.flat()));
        const _cycleSports = Array.from(new Set(availablePool.map(o => o.sport)));
        const _cycles = makeSportCycles(leagueName, _cycleTeams, _cycleSports, history, dayId);

        // ★ SCARCITY: among the sports available this slot, how few fields does each
        // have? A team that needs both football (4 fields) and basketball (15) must
        // grab the football field — otherwise it picks the nicer basketball field and
        // football, being scarce, keeps getting skipped game after game. We give a
        // needed sport a bonus scaled by how scarce it is, so the scarcest fresh sport
        // wins. Abundant sports get ~0 bonus (no contention to win).
        const _poolFieldsBySport = (function () {
            const m = {}, seen = {};
            availablePool.forEach(o => {
                seen[o.sport] = seen[o.sport] || new Set();
                if (!seen[o.sport].has(o.field)) { seen[o.sport].add(o.field); m[o.sport] = (m[o.sport] || 0) + 1; }
            });
            return m;
        })();
        const _maxPoolFields = Math.max(1, ...Object.values(_poolFieldsBySport).concat([1]));
        const _scarcityBonus = (sport) => ((_maxPoolFields / (_poolFieldsBySport[sport] || 1)) - 1) * 300;

        function getTeamSportNeed(team, sport) {
            // gap 0 → the team still needs this sport in its current cycle (which
            // includes "never played it" AND "starting a fresh cycle") → max need.
            // Each cycle a sport runs ahead of the team's minimum costs 20.
            const gap = _cycles.gap(team, sport);
            if (gap <= 0) return 1000;
            return Math.max(0, 100 - gap * 20);
        }

        // Sort matchups so teams with less sport variety get processed first.
        // When an indoor requirement is active, the neediest team (lowest current
        // indoor count) goes first so it gets first pick at any indoor option.
        const _indoorReq = leagueRules && leagueRules.indoorRequirement;
        const _indoorCounts = (leagueRules && leagueRules.indoorCounts) || {};
        const matchupsWithPriority = matchups.map(([t1, t2]) => {
            const h1 = _teamHist(t1);
            const h2 = _teamHist(t2);
            const starve1 = _cycles.starve(t1);
            const starve2 = _cycles.starve(t2);
            const ic1 = _indoorCounts[t1] || 0;
            const ic2 = _indoorCounts[t2] || 0;
            return {
                t1, t2,
                varietyScore: starve1 + starve2,
                coverMin: Math.min(starve1, starve2),
                stuck: _trailingSportStreak(h1) + _trailingSportStreak(h2),
                indoorMin: Math.min(ic1, ic2)
            };
        });

        // Field-pick order. PRIMARY: the most sport-STARVED matchup first — the one
        // whose neediest team is furthest behind in the sport cycle (starve rank:
        // completed cycles dominate, then progress within the cycle — so "never
        // played football" beats "starting cycle 2 fresh"). A team that still needs
        // a sport must get first claim on that scarce sport's field before a team
        // that already played it, so each sport spreads across all teams before any
        // repeats. SECONDARY: break active same-sport STREAKS. Then total starvation.
        // Indoor need stays primary when an indoor requirement is set.
        if (_indoorReq && _indoorReq.enabled) {
            matchupsWithPriority.sort((a, b) => a.indoorMin - b.indoorMin || a.coverMin - b.coverMin || b.stuck - a.stuck || a.varietyScore - b.varietyScore);
        } else {
            matchupsWithPriority.sort((a, b) => a.coverMin - b.coverMin || b.stuck - a.stuck || a.varietyScore - b.varietyScore);
        }

        for (const { t1, t2 } of matchupsWithPriority) {
            let bestOption = null;
            let bestScore = -Infinity;

            // ★ INDOOR HARD CONSTRAINT: restrict to indoor (or non-indoor) when
            // the rule requires it AND such a field is available; otherwise use
            // the full eligible set so the matchup always gets a sport.
            const _eligible = availablePool.filter(function (o) { return !_isFieldUsedConsideringCombos(usedFields, o.field); });
            let _pool = _applyIndoorHardFilter(_eligible, t1, t2, leagueRules);

            // ★ HARD STREAK CAP: same sport never more than 2 game days in a row.
            _pool = _applyStreakCapFilter(_pool, t1, t2, _teamHist(t1), _teamHist(t2));

            // ★ FAIR-SHARE CAP: prefer sports this league hasn't used up its per-slot
            // share of, so it leaves scarce fields for the other grades playing at the
            // same time. Falls back to the full pool when every remaining option is at
            // cap (a matchup is never dropped for fairness).
            // ★ ORDER MATTERS: the cap must run BEFORE the pair-sport caveat. The
            // caveat can narrow the pool to a single sport (the one this pair hasn't
            // replayed), and the cap's fallback would then let the league exceed its
            // share of exactly that sport — starving a junior league whose only
            // sports those fields are (observed in the multi-league sim: Minis got
            // ZERO games while Seniors took a second football field for pair
            // freshness). A repeated pair sport is a far smaller cost than another
            // league's dropped game, so fairness filters first and the caveat
            // refines within the league's share.
            if (sportCaps) {
                const _underCap = _pool.filter(function (o) {
                    const c = sportCaps[o.sport];
                    return c == null || (usedSportsThisSlot[o.sport] || 0) < c;
                });
                if (_underCap.length > 0) _pool = _underCap;
            }

            // ★ SAME-DAY REPEAT GUARD: on a 2+-game day, neither team plays the
            // same sport twice today unless nothing else is open (see helper).
            // After the fair-share cap (another league's dropped game costs more
            // than a repeat), before cycle rescue (a rescue must not resurrect
            // a same-day repeat).
            _pool = _applySameDayRepeatFilter(_pool, t1, t2, leagueName, history, dayId);

            // ★ CYCLE RESCUE: a team ≥2 plays behind on an available sport gets it
            // as a hard preference (see _applyCycleRescueFilter).
            const _rescue = _applyCycleRescueFilter(_pool, t1, t2, _teamHist(t1), _teamHist(t2));
            _pool = _rescue.pool;

            // ★ FN-57 caveat (cycle-aware): a rematch prefers the sport(s) this
            // pair has played together the FEWEST times — never a replay while an
            // unplayed one exists, least-replayed once the pair exhausted them all.
            _pool = _filterPoolByPairSportCycle(_pool, leagueName, t1, t2, history);

            for (const option of _pool) {
                let score = 0;

                // Heavy weight on sport need (main priority in this mode)
                const need1 = getTeamSportNeed(t1, option.sport);
                const need2 = getTeamSportNeed(t2, option.sport);
                score += need1 + need2;

                // ★ SCARCITY: when a team still NEEDS this sport this cycle, boost it
                // by how scarce the sport is so a scarce fresh sport (football) is
                // taken before an abundant fresh one (basketball) on a nicer field.
                // Only for needed sports → a team that's ahead on football is never
                // pushed onto it. Cycle-aware: fresh again after a completed cycle.
                const _svFresh1 = _cycles.isFresh(t1, option.sport) ? 1 : 0;
                const _svFresh2 = _cycles.isFresh(t2, option.sport) ? 1 : 0;
                score += (_svFresh1 + _svFresh2) * _scarcityBonus(option.sport);

                // ★ Even with cycle-aware need, the start of a new cycle makes every
                // sport max-need at once and the field-quality bonus (up to +188)
                // could otherwise pin a team to the best field's sport. Explicitly
                // forbid repeating a team's most-recent sport.
                const _svH1 = _teamHist(t1);
                const _svH2 = _teamHist(t2);
                const _svR1 = _svH1.length && _svH1[_svH1.length - 1] === option.sport ? 1 : 0;
                const _svR2 = _svH2.length && _svH2[_svH2.length - 1] === option.sport ? 1 : 0;
                score -= (_svR1 + _svR2) * 1500;

                // Prefer sports not yet used this slot
                const sportUsageThisSlot = usedSportsThisSlot[option.sport] || 0;
                if (sportUsageThisSlot === 0) {
                    score += 500;
                } else {
                    score -= sportUsageThisSlot * 100;
                }

                // ★ INDOOR REQUIREMENT: bias toward/away from indoor based on rule + running counts
                score += _scoreIndoorBias(option, t1, t2, leagueRules);

                // ★ FIELD QUALITY: prefer the better-ranked field in its group
                score += _fieldQualityBonus(_fqRank, option.field);

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

                if (_rescue.rescued) assignments[assignments.length - 1]._rescued = true;
                _markFieldUsedWithCombos(usedFields, bestOption.field);
                usedSportsThisSlot[bestOption.sport] = (usedSportsThisSlot[bestOption.sport] || 0) + 1;

                console.log(`   ✅ [SportVariety] ${t1} vs ${t2} → ${bestOption.sport} @ ${bestOption.field}`);
            } else {
                console.log(`   ❌ No field available for ${t1} vs ${t2}`);
                _recordForcedBye(leagueName, t1, t2, availablePool, matchups.length, assignments.length);
            }
        }

        return assignments;
    }

    // =========================================================================
    // SMART ASSIGNMENT ALGORITHM - MATCHUP VARIETY MODE
    // =========================================================================

    function assignMatchupsToFieldsAndSports_MatchupVariety(matchups, availablePool, leagueName, history, slots, leagueRules, sportCaps, dayId) {
        const assignments = [];
        const usedFields = new Set();
        const usedSportsThisSlot = {};
        const _fqRank = _buildFieldQualityRankMap();
        // ★ Date-correct history (robust to regeneration order) — see getTeamSportHistoryByDate.
        const _teamHist = (t) => getTeamSportHistoryByDate(leagueName, t, history, dayId);
        // ★ CYCLE-AWARE need (same as SportVariety — see makeSportCycles): needs
        //   reset once a team has played every available sport, so per-team sport
        //   rotation keeps working deep into the season instead of flattening.
        const _cycleTeams = Array.from(new Set(matchups.flat()));
        const _cycleSports = Array.from(new Set(availablePool.map(o => o.sport)));
        const _cycles = makeSportCycles(leagueName, _cycleTeams, _cycleSports, history, dayId);

        // ★ SCARCITY (same as SportVariety): a needed scarce sport (football, few
        // fields) must beat a needed abundant one (basketball) so it isn't skipped.
        const _poolFieldsBySport = (function () {
            const m = {}, seen = {};
            availablePool.forEach(o => {
                seen[o.sport] = seen[o.sport] || new Set();
                if (!seen[o.sport].has(o.field)) { seen[o.sport].add(o.field); m[o.sport] = (m[o.sport] || 0) + 1; }
            });
            return m;
        })();
        const _maxPoolFields = Math.max(1, ...Object.values(_poolFieldsBySport).concat([1]));
        const _scarcityBonus = (sport) => ((_maxPoolFields / (_poolFieldsBySport[sport] || 1)) - 1) * 300;

        // Sort matchups by how many times they've played (least played first)
        const _indoorReqMV = leagueRules && leagueRules.indoorRequirement;
        const _indoorCountsMV = (leagueRules && leagueRules.indoorCounts) || {};
        const matchupsWithPriority = matchups.map(([t1, t2]) => {
            const h1 = _teamHist(t1);
            const h2 = _teamHist(t2);
            const matchupCount = getMatchupCountByDate(leagueName, t1, t2, history, dayId);
            const indoorMin = Math.min(_indoorCountsMV[t1] || 0, _indoorCountsMV[t2] || 0);
            const starve1 = _cycles.starve(t1);
            const starve2 = _cycles.starve(t2);
            return {
                t1, t2, matchupCount, indoorMin,
                coverMin: Math.min(starve1, starve2),
                stuck: _trailingSportStreak(h1) + _trailingSportStreak(h2),
                variety: starve1 + starve2
            };
        });

        // Field-pick order ONLY — this does NOT change who plays whom (the pairing is
        // fixed by the round-robin upstream, which is matchup variety's guarantee).
        // PRIMARY: the most sport-STARVED matchup first — whose neediest team is
        // furthest behind in the sport cycle (starve rank: completed cycles dominate,
        // then progress within the cycle) — so a team that still needs a sport gets
        // first claim on that scarce field before a team that already played it,
        // spreading each sport across all teams. SECONDARY: break active same-sport
        // STREAKS; then total starvation; then fewest prior meetings (the original
        // order). Indoor need stays primary when required.
        if (_indoorReqMV && _indoorReqMV.enabled) {
            matchupsWithPriority.sort((a, b) => a.indoorMin - b.indoorMin || a.coverMin - b.coverMin || b.stuck - a.stuck || a.variety - b.variety || a.matchupCount - b.matchupCount);
        } else {
            matchupsWithPriority.sort((a, b) => a.coverMin - b.coverMin || b.stuck - a.stuck || a.variety - b.variety || a.matchupCount - b.matchupCount);
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

            // ★ HARD STREAK CAP: same sport never more than 2 game days in a row.
            _pool = _applyStreakCapFilter(_pool, t1, t2, _teamHist(t1), _teamHist(t2));

            // ★ FAIR-SHARE CAP: same as SportVariety — don't let this league claim
            // more than its share of a scarce sport's fields, leaving the rest for the
            // other grades. Soft: falls back to the full pool if all options are capped.
            // Runs BEFORE the pair caveat (see SportVariety) so pair-sport freshness
            // can never push the league past its share and starve a junior league.
            if (sportCaps) {
                const _underCap = _pool.filter(function (o) {
                    const c = sportCaps[o.sport];
                    return c == null || (usedSportsThisSlot[o.sport] || 0) < c;
                });
                if (_underCap.length > 0) _pool = _underCap;
            }

            // ★ SAME-DAY REPEAT GUARD: on a 2+-game day, neither team plays the
            // same sport twice today unless nothing else is open (see helper).
            // After the fair-share cap (another league's dropped game costs more
            // than a repeat), before cycle rescue (a rescue must not resurrect
            // a same-day repeat).
            _pool = _applySameDayRepeatFilter(_pool, t1, t2, leagueName, history, dayId);

            // ★ CYCLE RESCUE: a team ≥2 plays behind on an available sport gets it
            // as a hard preference (see _applyCycleRescueFilter).
            const _rescue = _applyCycleRescueFilter(_pool, t1, t2, _teamHist(t1), _teamHist(t2));
            _pool = _rescue.pool;

            // ★ FN-57 caveat (cycle-aware): a rematch prefers the sport(s) this
            // pair has played together the FEWEST times — never a replay while an
            // unplayed one exists, least-replayed once the pair exhausted them all.
            _pool = _filterPoolByPairSportCycle(_pool, leagueName, t1, t2, history);

            for (const option of _pool) {
                let score = 0;

                // In matchup variety mode the OPPONENT pairing (strict round-
                // robin) is what carries the "matchup variety" guarantee — it is
                // decided before we get here. This scorer only chooses WHICH
                // sport a fixed matchup plays, so it should still rotate sports
                // per team. The old "Math.max(0, 50 - count*5)" signal was far
                // too weak: it maxed at 50 and was swamped by _fieldQualityBonus
                // (up to +188) and Math.random()*20, so a team got pinned to
                // whatever sport sat on the best-ranked field (observed live:
                // hockey 3 days in a row). Use the same magnitudes as
                // sport_variety so per-team rotation actually wins.
                const h1 = _teamHist(t1);
                const h2 = _teamHist(t2);

                // Strong per-team CYCLE need: a still-needed-this-cycle sport
                // hugely outweighs a repeat; field quality / randomness act only
                // as tie-breakers among sports of equal freshness. Needs reset
                // when a team completes a cycle (see makeSportCycles).
                const gap1 = _cycles.gap(t1, option.sport);
                const gap2 = _cycles.gap(t2, option.sport);
                const need1 = gap1 <= 0 ? 1000 : Math.max(0, 100 - gap1 * 20);
                const need2 = gap2 <= 0 ? 1000 : Math.max(0, 100 - gap2 * 20);
                score += need1 + need2;

                // ★ SCARCITY: when a team still needs this sport this cycle, boost it
                // by how scarce the sport is so a scarce fresh sport (football) is
                // claimed before an abundant fresh one (basketball) on a nicer field.
                score += ((gap1 <= 0 ? 1 : 0) + (gap2 <= 0 ? 1 : 0)) * _scarcityBonus(option.sport);

                // ★ Hard guard against repeating a team's MOST-RECENT sport —
                // directly kills the "same sport N days in a row" case. Big
                // enough to dominate the field-quality bonus.
                const recent1 = h1.length && h1[h1.length - 1] === option.sport ? 1 : 0;
                const recent2 = h2.length && h2[h2.length - 1] === option.sport ? 1 : 0;
                score -= (recent1 + recent2) * 1500;

                // ★ INDOOR REQUIREMENT: bias toward/away from indoor based on rule + running counts
                score += _scoreIndoorBias(option, t1, t2, leagueRules);

                // ★ FIELD QUALITY: prefer the better-ranked field in its group
                score += _fieldQualityBonus(_fqRank, option.field);

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

                if (_rescue.rescued) assignments[assignments.length - 1]._rescued = true;
                _markFieldUsedWithCombos(usedFields, bestOption.field);
                usedSportsThisSlot[bestOption.sport] = (usedSportsThisSlot[bestOption.sport] || 0) + 1;

                console.log(`   ✅ [MatchupVariety] ${t1} vs ${t2} → ${bestOption.sport} @ ${bestOption.field}`);
            } else {
                console.log(`   ❌ No field available for ${t1} vs ${t2}`);
                _recordForcedBye(leagueName, t1, t2, availablePool, matchups.length, assignments.length);
            }
        }

        return assignments;
    }

    // =========================================================================
    // ★ WITHIN-SLOT SWAP PASS — fix need-stranding between matchups
    // =========================================================================
    // The per-matchup greedy can strand needs: two matchups both need the
    // single volleyball court; the one processed second eats basketball AGAIN
    // even when the first matchup didn't especially need volleyball (observed
    // in the multi-league sim: one team finished 12 days at BK6/SC4/VB2 while
    // its league-mates sat at 4/4/4). After all matchups are assigned, try
    // trading the (sport, field) choices of every pair of assignments; accept
    // when the summed cycle-need score improves and no team lands a
    // 3-days-in-a-row streak. A swap moves whole options between matchups, so
    // per-slot sport usage, field locks, and fair-share caps all stay valid.
    function _swapReoptimizeAssignments(assignments, leagueName, history, dayId) {
        try {
            if (!Array.isArray(assignments) || assignments.length < 2) return assignments;
            const sportsInPlay = Array.from(new Set(assignments.map(function (a) { return a.sport; })));
            const teams = Array.from(new Set(assignments.reduce(function (acc, a) { acc.push(a.team1, a.team2); return acc; }, [])));
            const cycles = makeSportCycles(leagueName, teams, sportsInPlay, history, dayId);
            const hists = {};
            teams.forEach(function (t) { hists[t] = getTeamSportHistoryByDate(leagueName, t, history, dayId); });
            // ★ SAME-DAY REPEAT GUARD: sports each team already played in an
            // earlier game TODAY (the day-history above is strictly-before-today).
            // A swap must never hand a team a same-day repeat the greedy pass
            // avoided; swapping AWAY from a forced repeat stays allowed.
            const _todaySports = {};
            teams.forEach(function (t) { _todaySports[t] = _getTeamSportsToday(leagueName, t, history, dayId); });
            function teamScore(t, s) {
                const g = cycles.gap(t, s);
                let sc = g <= 0 ? 1000 : Math.max(0, 100 - g * 20);
                const h = hists[t];
                if (h.length && h[h.length - 1] === s) sc -= 1500;
                return sc;
            }
            function illegal(t, s) {   // 3-days-in-a-row streak, or a same-day repeat
                const h = hists[t];
                if (h.length >= 2 && h[h.length - 1] === s && h[h.length - 2] === s) return true;
                if (window.__leagueSameDayRepeatGuard !== false && _todaySports[t] && _todaySports[t].has(s)) return true;
                return false;
            }
            function assnScore(a, s) {
                const pairC = getPairSports(leagueName, a.team1, a.team2, history)
                    .filter(function (x) { return x === s; }).length;
                return teamScore(a.team1, s) + teamScore(a.team2, s) - pairC * 400;
            }
            let improved = true, guard = 0;
            while (improved && guard++ < 100) {
                improved = false;
                for (let i = 0; i < assignments.length && !improved; i++) {
                    for (let j = i + 1; j < assignments.length; j++) {
                        const A = assignments[i], B = assignments[j];
                        if (A.sport === B.sport) continue;
                        if (A._rescued || B._rescued) continue;   // never trade a cycle-rescued sport away
                        if (illegal(A.team1, B.sport) || illegal(A.team2, B.sport)) continue;
                        if (illegal(B.team1, A.sport) || illegal(B.team2, A.sport)) continue;
                        const base = assnScore(A, A.sport) + assnScore(B, B.sport);
                        const swapped = assnScore(A, B.sport) + assnScore(B, A.sport);
                        if (swapped > base) {
                            const tmp = { field: A.field, sport: A.sport };
                            A.field = B.field; A.sport = B.sport;
                            B.field = tmp.field; B.sport = tmp.sport;
                            console.log('   ★ [SlotSwap] ' + (A.matchup || A.team1 + ' vs ' + A.team2) + ' ⇄ ' + (B.matchup || B.team1 + ' vs ' + B.team2) + ' traded sport/field for cycle need');
                            improved = true; break;
                        }
                    }
                }
            }
            return assignments;
        } catch (e) {
            console.warn('[RegularLeagues] slot swap pass failed — keeping greedy assignments:', e);
            return assignments;
        }
    }

    // =========================================================================
    // UNIFIED ASSIGNMENT FUNCTION (Delegates based on priority mode)
    // =========================================================================

    function assignMatchupsToFieldsAndSports(matchups, availablePool, leagueName, history, slots, schedulingPriority, leagueRules, sportCaps, dayId) {
        const mode = schedulingPriority || 'sport_variety';

        console.log(`   🎯 Scheduling Priority: ${mode === 'sport_variety' ? 'Sport Variety' : 'Matchup Variety'}`);

        const assignments = (mode === 'matchup_variety')
            ? assignMatchupsToFieldsAndSports_MatchupVariety(matchups, availablePool, leagueName, history, slots, leagueRules, sportCaps, dayId)
            : assignMatchupsToFieldsAndSports_SportVariety(matchups, availablePool, leagueName, history, slots, leagueRules, sportCaps, dayId);

        // ★ Within-slot swap pass (see _swapReoptimizeAssignments). Skipped when an
        // indoor requirement is active — swaps trade fields between matchups and
        // could hand an indoor field away from a team still below its floor.
        // Instead, run the INDOOR RESCUE pass: lift below-floor teams onto indoor
        // courts (free same-sport court, else trade with a met-floor matchup).
        if (leagueRules && leagueRules.indoorRequirement && leagueRules.indoorRequirement.enabled) {
            return _indoorRescuePass(assignments, availablePool, leagueRules);
        }
        return _swapReoptimizeAssignments(assignments, leagueName, history, dayId);
    }

    // =========================================================================
    // ★★★ INDOOR RESCUE PASS (post-assignment, within one game) ★★★
    // The per-matchup hard filter can leave a below-floor team outdoors when the
    // indoor courts were momentarily contended (taken by earlier matchups in this
    // same game, or freed only by a different-sport choice). After the full game
    // is assigned, rescue those matchups SAME-SPORT-ONLY (so sport-variety picks,
    // pair-repeat rules and fair-share sport caps all stay intact):
    //   (a) relocate onto a FREE indoor court hosting the same sport, else
    //   (b) trade courts with a same-sport matchup that holds an indoor court
    //       whose BOTH teams already met the floor (their indoor game is surplus).
    // Only lifts toward a floor ('>=' / '=' while below target) — never forces
    // indoor under a '<=' ceiling. Killswitch: window.__leagueIndoorRescue=false.
    // =========================================================================
    function _indoorRescuePass(assignments, availablePool, leagueRules) {
        try {
            if (window.__leagueIndoorRescue === false) return assignments;
            const req = leagueRules && leagueRules.indoorRequirement;
            if (!req || !req.enabled) return assignments;
            const op = req.op || '>=';
            if (op === '<=') return assignments;   // ceiling-only rule: nothing to lift
            const target = Number.isFinite(req.count) ? req.count : 1;
            const counts = leagueRules.indoorCounts || {};
            const optByField = {};
            availablePool.forEach(function (o) { if (!optByField[o.field]) optByField[o.field] = o; });
            const isIndoorField = function (f) { return _optIsIndoor(optByField[f]); };
            const used = new Set(assignments.map(function (a) { return a && a.field; }));
            assignments.forEach(function (a) {
                if (!a || !a.field || isIndoorField(a.field)) return;
                if (Math.min(counts[a.team1] || 0, counts[a.team2] || 0) >= target) return; // met floor
                // (a) free indoor court, same sport → pure relocation
                const free = availablePool.find(function (o) {
                    return o.sport === a.sport && !used.has(o.field) && _optIsIndoor(o);
                });
                if (free) {
                    console.log('   🏠 [IndoorRescue] ' + a.team1 + ' vs ' + a.team2 + ' moved indoors: ' + a.field + ' → ' + free.field + ' (' + a.sport + ')');
                    used.delete(a.field); used.add(free.field);
                    a.field = free.field;
                    return;
                }
                // (b) court trade with a met-floor matchup on an indoor court, same sport
                const donor = assignments.find(function (b) {
                    return b && b !== a && b.sport === a.sport && b.field && isIndoorField(b.field)
                        && Math.min(counts[b.team1] || 0, counts[b.team2] || 0) >= target;
                });
                if (donor) {
                    console.log('   🏠 [IndoorRescue] court trade (' + a.sport + '): ' + a.team1 + ' vs ' + a.team2 + ' ⇄ ' + donor.team1 + ' vs ' + donor.team2 + ' (' + a.field + ' ↔ ' + donor.field + ')');
                    const f = a.field; a.field = donor.field; donor.field = f;
                }
            });
        } catch (_eIndR) {}
        return assignments;
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

        // ★ BYE REPORT: fresh collection per run; publish even on the early
        // return so a stale banner from a prior gen clears.
        _byeReport = [];
        _byeCtx = null;

        if (!masterLeagues || Object.keys(masterLeagues).length === 0) {
            console.log("[RegularLeagues] No regular leagues configured.");
            _publishByeReport();
            return;
        }

        const history = loadLeagueHistory();

        // ★★★ GET CURRENT DAY IDENTIFIER ★★★
        // ★ FN-14: prefer the authoritative gen-date snapshotted at generation
        //   entry. window.currentScheduleDate is the global PICKER, which can
        //   transiently revert to the PREVIOUSLY loaded date mid-gen (the
        //   accumulated-async race CB-23 documents). Keying the day-reset +
        //   gameLog off the picker rolled back the WRONG day's records and
        //   logged today's games under the prior date — the regenerated
        //   schedule (saved under the authoritative date) then disagreed with
        //   Play History (observed live: history showed a sport for a date
        //   whose real schedule played a different one). Final fallback is the
        //   LOCAL calendar date — toISOString() is UTC and flips to tomorrow
        //   during evening sessions.
        const dayId = window._activeGenDate || window.currentScheduleDate || new Date().toLocaleDateString('en-CA');
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

        // ★ SPANNED TILE = ONE GAME: a league tile spread across grade columns is
        // stored as one skeleton event per grade, linked by a shared spanGroup.
        // The members normally share a start time (same bucket → same matchups),
        // but if their times drift apart each lands in its own bucket and gets an
        // independent matchup computation + its own game number — two different
        // results for what the user drew as a single game. Re-bucket every league
        // block sharing a spanGroup into the group's earliest time so one period
        // covers them all; _spanTimeKey lets the writeback guards below match the
        // moved blocks back to the merged period.
        (function () {
            const byGroup = {};
            Object.keys(blocksByTime).forEach(key => {
                blocksByTime[key].allBlocks.forEach(b => {
                    if (!b.spanGroup) return;
                    (byGroup[b.spanGroup] = byGroup[b.spanGroup] || []).push({ key, block: b });
                });
            });
            Object.entries(byGroup).forEach(([groupId, entries]) => {
                // (a) One span = one league. Mirrors saved BEFORE the shared-league
                // remap fix were remapped to their own grade's first league, so one
                // spanned tile can still reference two different leagues — each
                // grade then generates an unrelated game. If any named league
                // covers EVERY spanned division, the whole group adopts it so a
                // single league period processes all of them.
                const blocks = entries.map(e => e.block);
                const _ml = Array.isArray(masterLeagues) ? masterLeagues : Object.values(masterLeagues || {});
                const names = [...new Set(blocks.map(b => b.leagueName).filter(Boolean))];
                const divsInGroup = [...new Set(blocks.map(b => b.divName))];
                const shared = names.find(n => {
                    const lg = _ml.find(l => l && l.name === n);
                    return lg && Array.isArray(lg.divisions) && divsInGroup.every(d => lg.divisions.includes(d));
                });
                if (shared && blocks.some(b => b.leagueName !== shared)) {
                    console.log(`[RegularLeagues] ★ Span group ${groupId}: unifying league → "${shared}" (members named [${names.join(', ')}])`);
                    blocks.forEach(b => { b.leagueName = shared; });
                }

                // (b) One span = one time period.
                const keys = [...new Set(entries.map(e => String(e.key)))];
                if (keys.length < 2) return;
                const allNumeric = keys.every(k => !isNaN(Number(k)));
                const canonical = allNumeric
                    ? String(Math.min(...keys.map(Number)))
                    : keys[0];
                console.log(`[RegularLeagues] ★ Span group ${groupId}: merging times [${keys.join(', ')}] → ${canonical} (one tile = one game)`);
                entries.forEach(({ key, block }) => {
                    if (String(key) === canonical) return;
                    const old = blocksByTime[key];
                    old.allBlocks = old.allBlocks.filter(b => b !== block);
                    const divRest = (old.byDivision[block.divName] || []).filter(b => b !== block);
                    if (divRest.length) old.byDivision[block.divName] = divRest;
                    else delete old.byDivision[block.divName];
                    if (old.allBlocks.length === 0) delete blocksByTime[key];
                    if (!blocksByTime[canonical]) blocksByTime[canonical] = { byDivision: {}, allBlocks: [] };
                    if (!blocksByTime[canonical].byDivision[block.divName]) blocksByTime[canonical].byDivision[block.divName] = [];
                    blocksByTime[canonical].byDivision[block.divName].push(block);
                    blocksByTime[canonical].allBlocks.push(block);
                    block._spanTimeKey = canonical;
                });
            });
        })();

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
        // ★ Per-tile regen: distinct preserved games kept on this date per league
        //   (their records survived the rollback). Feeds game numbering + the
        //   games-per-date total so a preserved game still counts as played.
        const _preservedTodayCounts = {};
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
                // Per-tile regen: keep the log records of this league's games whose
                // periods are NOT being re-rolled (labels published by the regen UI).
                let _plbl = null;
                try {
                    const _raw = window.__regenPreservedLeagueLabels && window.__regenPreservedLeagueLabels[league.name];
                    if (_raw && _raw.length) _plbl = new Set(_raw);
                } catch (_e) {}
                rollbackDayRecords(league.name, dayId, history, _plbl);
                const _keptRecs = history.gameLog?.[league.name]?.[dayId] || [];
                const _keptGames = new Set(_keptRecs.map(function (r) { return r && r.g; }).filter(Boolean)).size;
                _preservedTodayCounts[league.name] = _keptGames;
                if (_keptGames > 0) {
                    if (!history.gamesPerDate[league.name]) history.gamesPerDate[league.name] = {};
                    history.gamesPerDate[league.name][dayId] = _keptGames;
                } else if (history.gamesPerDate?.[league.name]?.[dayId] !== undefined) {
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
                var lSports = league.sports || ['General Sport'];
                var priority = league.schedulingPriority || 'sport_variety';
                // ★ NO PREDETERMINED ROUND-ROBIN: game-1 matchups are computed fresh
                //   from history (meetings + sport needs), same as the main path. The
                //   round-robin round is only the error/kill-switch fallback inside
                //   chooseDailyMatchups. (The league-wide sport list stands in for the
                //   field pool here — the real pools are built per time key below.)
                var fullSched = generateRoundRobinSchedule(leagueTeams);
                var rrFallback = fullSched[(gameNum - 1) % fullSched.length] || [];
                var g1Matchups = chooseDailyMatchups(leagueTeams, lSports.map(function (s) { return { sport: s }; }), league.name, history, rrFallback, dayId, priority);
                if (g1Matchups.length === 0) continue;

                var zoneSports = ocGetZoneSports(league.offCampus.zone, lSports, context);
                var dh = ocSelectGroups(g1Matchups, league.offCampus.teamsPerDay, history, league.name, priority, zoneSports);
                if (!dh) continue;

                ocRecordTrips(history, league.name, dh.offCampus.teams);

                var ocDivs = league.divisions.filter(function(d) { return Object.keys(blocksByTime[timeKey1]?.byDivision||{}).includes(d); });
                var s1 = blocksByTime[timeKey1].allBlocks[0]?.slots || [];
                var s2 = blocksByTime[timeKey2].allBlocks[0]?.slots || [];
                var _oc1End = blocksByTime[timeKey1].allBlocks[0]?.endTime;
                var _oc2End = blocksByTime[timeKey2].allBlocks[0]?.endTime;
                var zoneF = window.getFieldsInZone?.(league.offCampus.zone) || [];
                // ★ Pass the off-campus zone so this double-header's own zone fields are
                //   admitted to the pool (they're reserved from every non-away league).
                var fp1 = buildAvailableFieldSportPool(lSports, context, ocDivs, timeKey1, s1, _oc1End, league.offCampus.zone);
                var fp2 = buildAvailableFieldSportPool(lSports, context, ocDivs, timeKey2, s2, _oc2End, league.offCampus.zone);

                // ★ Pass dayId so the assigners read date-correct history (without it
                //   they fell back to the full teamSports/gameLog including future
                //   dates — wrong needs when regenerating a middle date).
                _byeCtx = { time: timeKey1, game: gameNum };       // stamp bye records with this period
                var g1Off = assignMatchupsToFieldsAndSports(dh.offCampus.game1, fp1.filter(function(p){return zoneF.includes(p.field);}), league.name, history, s1, priority, null, null, dayId);
                var g1On = assignMatchupsToFieldsAndSports(dh.onCampus.game1, fp1.filter(function(p){return !zoneF.includes(p.field);}), league.name, history, s1, priority, null, null, dayId);
                var g1All = g1Off.concat(g1On);
                var lbl1 = league.name + ' Game ' + gameNum, lbl2 = league.name + ' Game ' + (gameNum + 1);
                // ★ Record game 1 BEFORE assigning game 2 (mirrors the main path,
                // which logs each period as it goes) — the same-day repeat guard
                // and the pair-sport caveat read today's games from the gameLog,
                // so game 2's sport picks must see what game 1 just played.
                g1All.forEach(function(a) {
                    if (a.sport) { recordTeamSport(league.name, a.team1||a.teamA, a.sport, history); recordTeamSport(league.name, a.team2||a.teamB, a.sport, history); }
                    recordMatchup(league.name, a.team1||a.teamA, a.team2||a.teamB, history);
                    // ★ FN-54: date-keyed log so regen/delete can subtract this game
                    logGameRecord(league.name, dayId, a.team1||a.teamA, a.team2||a.teamB, a.sport, history, lbl1);
                });
                _byeCtx = { time: timeKey2, game: gameNum + 1 };
                var g2Off = assignMatchupsToFieldsAndSports(dh.offCampus.game2, fp2.filter(function(p){return zoneF.includes(p.field);}), league.name, history, s2, priority, null, null, dayId);
                var g2On = assignMatchupsToFieldsAndSports(dh.onCampus.game2, fp2.filter(function(p){return !zoneF.includes(p.field);}), league.name, history, s2, priority, null, null, dayId);
                _byeCtx = null;
                var g2All = g2Off.concat(g2On);

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

                // (game 1 was recorded above, before game 2's assignment)
                g2All.forEach(function(a) {
                    if (a.sport) { recordTeamSport(league.name, a.team1||a.teamA, a.sport, history); recordTeamSport(league.name, a.team2||a.teamB, a.sport, history); }
                    recordMatchup(league.name, a.team1||a.teamA, a.team2||a.teamB, history);
                    // ★ FN-54: date-keyed log so regen/delete can subtract this game
                    logGameRecord(league.name, dayId, a.team1||a.teamA, a.team2||a.teamB, a.sport, history, lbl2);
                });

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

            // ★ FIELD QUALITY: process leagues in DIVISION-SENIORITY order (most
            //   senior first). Each league assigns + globally LOCKS its fields before
            //   the next runs, so the senior division's league claims the best-ranked
            //   fields in each sport group first — and because leagues lock before the
            //   solver/smart-tiles, it beats junior regular activities too. Seniority
            //   per league = the most senior division it serves (index 0 = oldest in
            //   getDivisionAgeOrder). No-op if the helper is unavailable.
            try {
                const _ageOrder = (typeof window.getDivisionAgeOrder === 'function')
                    ? window.getDivisionAgeOrder(Object.keys(window.divisions || {})) : [];
                if (_ageOrder.length) {
                    const _senIdx = {}; _ageOrder.forEach((n, i) => { _senIdx[n] = i; });
                    const _leagueSen = l => {
                        let best = Infinity;
                        (l.divisions || []).forEach(d => { const v = _senIdx[d]; if (v != null && v < best) best = v; });
                        return best;
                    };
                    applicableLeagues.sort((a, b) => _leagueSen(a) - _leagueSen(b));
                }
            } catch (_eSen) {}

            console.log(`   Applicable leagues (senior→junior): [${applicableLeagues.map(l => l.name).join(', ')}]`);
            if (specifiedLeagueNames.size > 0) {
                console.log(`   ★ Filtered by block leagueName: [${[...specifiedLeagueNames].join(', ')}]`);
            }

            // ★★★ FAIR-SHARE SPORT CAPS — stop a senior league from hogging the scarce
            // fields from the other grades playing leagues at this same time. Leagues are
            // processed in seniority order and each LOCKS its fields before the next runs,
            // so without this the most-senior league grabs every baseball/hockey/football
            // field and the juniors inherit only the plentiful sport (e.g. basketball).
            // We bound each league's claim on a sport to its share of that sport's fields,
            // weighted by its game count: abundant sports get a high (non-binding) cap,
            // scarce sports get a low one. The assigner treats the cap as a soft
            // preference with a fallback, so a matchup is never left unscheduled. No-op
            // when only one league plays this slot (no contention to be fair about).
            const _sportCapsByLeague = (function () {
                try {
                    const _here = applicableLeagues.filter(l => !(offCampusScheduled[l.name] && offCampusScheduled[l.name].handled));
                    if (_here.length <= 1) return {};   // no contention → nothing to share
                    const _allSports = new Set();
                    _here.forEach(l => (l.sports || ['General Sport']).forEach(s => _allSports.add(s)));
                    // Field inventory per sport for this slot (before any league locks).
                    const _pool = buildAvailableFieldSportPool([..._allSports], context, divisionsAtTime, timeKey, slots, sampleBlock && sampleBlock.endTime);
                    const _fieldsBySport = {}, _seen = {};
                    _pool.forEach(p => {
                        _seen[p.sport] = _seen[p.sport] || new Set();
                        if (!_seen[p.sport].has(p.field)) { _seen[p.sport].add(p.field); _fieldsBySport[p.sport] = (_fieldsBySport[p.sport] || 0) + 1; }
                    });
                    const _games = {};
                    _here.forEach(l => { _games[l.name] = Math.max(1, Math.floor((l.teams || []).length / 2)); });
                    // Date seed → rotates who wins a tie for the "extra" scarce field, so no
                    // league is permanently the one that loses out on an odd leftover field.
                    let _seed = 0; const _ds = String(dayId || '');
                    for (let i = 0; i < _ds.length; i++) _seed = (_seed * 31 + _ds.charCodeAt(i)) & 0x7fffffff;

                    // ★ NEED = how STARVED a league's teams are of a sport, measured as the
                    // gap between how often each team has played its MOST-played sport and
                    // how often it has played THIS sport. A team that's never played football
                    // (while it has played other sports) contributes a big deficit; a team
                    // that's caught up on football contributes 0. So a whole league that has
                    // caught up on a sport has need 0 → cap 0 → it surrenders all of that
                    // sport's fields to the league that still needs it. Date-correct history.
                    const _teamCounts = {};   // leagueName → team → {sport: count}
                    const _sportNeed = (l, sport) => {
                        const lc = _teamCounts[l.name] || (_teamCounts[l.name] = {});
                        let total = 0;
                        (l.teams || []).forEach(t => {
                            let counts = lc[t];
                            if (!counts) {
                                counts = {};
                                getTeamSportHistoryByDate(l.name, t, history, dayId)
                                    .forEach(s => { counts[s] = (counts[s] || 0) + 1; });
                                lc[t] = counts;
                            }
                            let mostPlayed = 0;
                            for (const s in counts) if (counts[s] > mostPlayed) mostPlayed = counts[s];
                            total += Math.max(0, mostPlayed - (counts[sport] || 0));
                        });
                        return total;
                    };

                    const _caps = {}; _here.forEach(l => { _caps[l.name] = {}; });
                    const _byNeedSports = [];
                    _allSports.forEach(sport => {
                        const fc = _fieldsBySport[sport] || 0;
                        if (fc <= 0) return;
                        const parts = _here.filter(l => (l.sports || []).includes(sport));
                        // Weight each league by how much its teams NEED this sport. Only when
                        // nobody has a specific need (e.g. season start, all sports even) do
                        // we fall back to game-count weighting — that's the case where the
                        // user's "time priority breaks the tie" applies (seniority order +
                        // date-seeded leftover rotation below decide who gets the odd field).
                        let weights = parts.map(l => _sportNeed(l, sport));
                        const totalNeed = weights.reduce((s, w) => s + w, 0);
                        const byNeed = totalNeed > 0;
                        if (!byNeed) weights = parts.map(l => _games[l.name]);
                        if (byNeed) _byNeedSports.push(sport);
                        const totalW = weights.reduce((s, w) => s + w, 0) || 1;
                        // Largest-remainder apportionment of this sport's fc fields across the
                        // leagues that play it. floor() gives the base share; leftover field(s)
                        // go to the largest fractional shares — a league weighted 0 (no need)
                        // gets base 0 + frac 0, so it never claims a leftover over a needy one.
                        const rows = parts.map((l, idx) => {
                            const exact = fc * weights[idx] / totalW;
                            const base = Math.floor(exact);
                            return { name: l.name, base, frac: exact - base, idx };
                        });
                        let rem = fc - rows.reduce((s, r) => s + r.base, 0);
                        rows.sort((a, b) => (b.frac - a.frac)
                            || (((a.idx + _seed) % rows.length) - ((b.idx + _seed) % rows.length)));
                        for (let i = 0; i < rows.length; i++) rows[i].base += (i < rem ? 1 : 0);
                        rows.forEach(r => { _caps[r.name][sport] = r.base; });
                    });

                    // ★ PARTICIPATION FLOOR — every league must be able to SEAT its
                    // games. Need-weighted apportionment can hand a league ZERO caps
                    // on every one of its sports: a perfectly caught-up league has
                    // deficit 0 everywhere while any other league still shows need,
                    // so all its weights are 0. With every option at cap 0, the
                    // seniors (processed first) take the extra fields and the junior
                    // league's matchups find nothing (observed in the multi-league
                    // sim: a 2-sport league dropped to 1 of 2 games — and the field
                    // squeeze then forced a 3-days-in-a-row sport on its teams —
                    // while two hockey fields sat unused). While some league's total
                    // cap across its sports can't seat its game count, transfer one
                    // cap unit per round from the most-surplus league on a shared
                    // sport, preferring the sport where the starved league currently
                    // holds the least (spreads its floor across its sports).
                    const _capTotal = (l) => (l.sports || []).reduce((s, sp) => s + (_caps[l.name][sp] || 0), 0);
                    const _maxSeats = (l) => (l.sports || []).reduce((s, sp) => s + (_fieldsBySport[sp] || 0), 0);
                    let _floorGuard = 0;
                    while (_floorGuard++ < 64) {
                        let _moved = false;
                        for (const l of _here) {
                            const _wanted = Math.min(_games[l.name], _maxSeats(l));
                            if (_capTotal(l) >= _wanted) continue;
                            let best = null;
                            for (const sp of (l.sports || [])) {
                                const _lcap = _caps[l.name][sp] || 0;
                                if (_lcap >= (_fieldsBySport[sp] || 0)) continue;   // sport already saturated for this league
                                for (const d of _here) {
                                    if (d === l || !(d.sports || []).includes(sp)) continue;
                                    if ((_caps[d.name][sp] || 0) <= 0) continue;
                                    const _surplus = _capTotal(d) - _games[d.name];
                                    if (_surplus <= 0) continue;
                                    if (!best || _lcap < best.lcap || (_lcap === best.lcap && _surplus > best.surplus)) {
                                        best = { donor: d, sp, surplus: _surplus, lcap: _lcap };
                                    }
                                }
                            }
                            if (!best) continue;
                            _caps[best.donor.name][best.sp]--;
                            _caps[l.name][best.sp] = (_caps[l.name][best.sp] || 0) + 1;
                            console.log('   ⚖️ Participation floor: 1 ' + best.sp + ' cap ' + best.donor.name + ' → ' + l.name + ' (seat its games)');
                            _moved = true;
                        }
                        if (!_moved) break;
                    }

                    console.log('   ⚖️ Need-first sport caps' + (_byNeedSports.length ? ' (need-weighted: ' + _byNeedSports.join(', ') + ')' : ' (no specific need → by size)') + ': ' + _here.map(l => l.name + '=' + JSON.stringify(_caps[l.name])).join('  '));
                    return _caps;
                } catch (_e) {
                    console.warn('[RegularLeagues] fair-share cap computation failed (continuing uncapped):', _e);
                    return {};
                }
            })();

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
                                const _bk = (block._spanTimeKey != null) ? block._spanTimeKey
                                    : (typeof block.startTime === 'number')
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
                
                // Get the starting game number based on chronological date order.
                // ★ Per-tile regen: number AFTER any preserved (not re-rolled) games
                //   already kept on this date, so labels never collide with them.
                const baseGameNumber = calculateStartingGameNumber(league.name, dayId, history);
                const todayGameIndex = leagueGameCounters[league.name];
                const gameNumber = baseGameNumber + (_preservedTodayCounts[league.name] || 0) + todayGameIndex + 1;
                
                const leagueSports = league.sports || ["General Sport"];
                // ★ Away (off-campus) league tile: resolve the chosen zone + mode BEFORE
                //   the pool is built. Off-campus fields are reserved (excluded from every
                //   non-away league) inside buildAvailableFieldSportPool, so the away zone
                //   must be passed in for THIS league to see its own zone's fields at all.
                //   Resolve for BOTH modes: 'exclusive' (all away) later intersects the
                //   pool down to just the zone; 'mixed' (either/or) leaves the pool as
                //   on-campus + this zone's off-campus fields so games can land either way.
                var _awayZoneForPeriod = null;
                var _awayModeForPeriod = null;
                filteredLeagueDivisions.forEach(function (divName) {
                    (timeData.byDivision[divName] || []).forEach(function (b) {
                        if (!b || b._isAway !== true || !b._awayZone) return;
                        if (b.leagueName && b.leagueName !== league.name) return;
                        var _bk = (b._spanTimeKey != null) ? b._spanTimeKey
                            : (typeof b.startTime === 'number')
                            ? b.startTime
                            : (window.SchedulerCoreUtils?.parseTimeToMinutes?.(b.startTime) ?? b.startTime);
                        if (Number(_bk) !== Number(timeKey)) return;
                        _awayZoneForPeriod = b._awayZone;
                        _awayModeForPeriod = (b._awayMode === 'mixed') ? 'mixed' : 'exclusive';
                    });
                });

                // ★ Reserve EVERY zone that is an away destination THIS period (any
                //   league's away block, across all divisions present), so one league's
                //   away-zone fields can't be poached by another league sharing the
                //   period. Keyed on the away FLAG, NOT the zone's isOffCampus setting —
                //   an "Away" zone need not be marked off-campus (the reported camp's
                //   "TABC" zone is on-campus), which is why the earlier isOffCampus-only
                //   guard didn't fire and the seniors kept draining the zone.
                var _reservedAwayZonesThisPeriod = new Set();
                Object.keys(timeData.byDivision || {}).forEach(function (divName) {
                    (timeData.byDivision[divName] || []).forEach(function (b) {
                        if (!b || b._isAway !== true || !b._awayZone) return;
                        var _bk = (b._spanTimeKey != null) ? b._spanTimeKey
                            : (typeof b.startTime === 'number')
                            ? b.startTime
                            : (window.SchedulerCoreUtils?.parseTimeToMinutes?.(b.startTime) ?? b.startTime);
                        if (Number(_bk) !== Number(timeKey)) return;
                        _reservedAwayZonesThisPeriod.add(b._awayZone);
                    });
                });

                // ★★★ BUILD POOL - RESPECTS GLOBAL LOCKS ★★★
                // ★ FN-57: built BEFORE matchup selection so sport_variety
                // pairing can see which sports are actually available today.
                var availablePool = buildAvailableFieldSportPool(
                    leagueSports,
                    context,
                    leagueDivisions,
                    timeKey,
                    slots,
                    sampleBlock?.endTime,
                    _awayZoneForPeriod,             // admit THIS league's away zone fields (null → none)
                    _reservedAwayZonesThisPeriod    // exclude OTHER leagues' away-zone fields
                );
                // Exclusive away = only the zone's fields (travel is stamped per-block in
                // fillBlock). Mixed already has the zone's fields admitted alongside the
                // on-campus pool, so it needs no intersection.
                if (_awayZoneForPeriod && _awayModeForPeriod === 'exclusive' && typeof window.getFieldsInZone === 'function') {
                    var _azSet = new Set(window.getFieldsInZone(_awayZoneForPeriod) || []);
                    var _filteredPool = availablePool.filter(function (p) { return _azSet.has(p.field); });
                    if (_filteredPool.length > 0) {
                        console.log('   🚌 Away league "' + league.name + '" @' + timeKey + ' → restricting to zone "' + _awayZoneForPeriod + '" (' + _filteredPool.length + ' field/sport combos)');
                        availablePool = _filteredPool;
                    } else {
                        console.warn('   ⚠️ Away league "' + league.name + '" @' + timeKey + ' → zone "' + _awayZoneForPeriod + '" has no available fields; keeping full pool.');
                    }
                }

                // ★★★ INDOOR-MINIMUM RESERVATION (cross-league) ★★★
                // Leagues process senior→junior and LOCK their fields, so a league
                // with no indoor rule can drain the gyms before a later league that
                // still OWES its teams indoor games gets its turn — that league's
                // indoor hard-filter then has nothing to pick and silently falls
                // back outdoors (same failure shape as the away-zone poach). If THIS
                // league has no unmet indoor need, withhold up to <demand> indoor
                // fields that later-processed leagues in this same period still need
                // for an enabled indoor minimum ('>=' / '='), keeping enough fields
                // for this league's own matchups. Killswitch: window.__leagueIndoorReserve=false.
                try {
                    if (window.__leagueIndoorReserve !== false && availablePool.length > 0) {
                        const _iNeed = function (l) {
                            const r = l && l.indoorRequirement;
                            if (!r || !r.enabled || (r.op || '>=') === '<=') return 0;
                            const tgt = Number.isFinite(r.count) ? r.count : 1;
                            const ic = indoorCountsByLeague[l.name] || {};
                            const below = (l.teams || []).filter(function (t) { return (ic[t] || 0) < tgt; }).length;
                            return Math.ceil(below / 2);   // 2 teams get indoor credit per matchup
                        };
                        if (_iNeed(league) === 0) {
                            const _selfIdx = applicableLeagues.indexOf(league);
                            const _later = applicableLeagues.slice(_selfIdx + 1).filter(function (l) {
                                if (offCampusScheduled[l.name] && offCampusScheduled[l.name].handled) return false;
                                return _iNeed(l) > 0;
                            });
                            if (_later.length) {
                                const _laterSports = new Set();
                                _later.forEach(function (l) { (l.sports || []).forEach(function (s) { _laterSports.add(s); }); });
                                const _demand = _later.reduce(function (n, l) { return n + _iNeed(l); }, 0);
                                // indoor fields in MY pool that a needing league could actually use
                                const _indoorFields = [...new Set(availablePool
                                    .filter(function (o) { return _optIsIndoor(o) && _laterSports.has(o.sport); })
                                    .map(function (o) { return o.field; }))];
                                // safety valve: keep enough distinct fields for my own matchups
                                const _myMatchups = Math.max(1, Math.floor((league.teams || []).length / 2));
                                const _allFieldCount = new Set(availablePool.map(function (o) { return o.field; })).size;
                                const _maxDrop = Math.max(0, _allFieldCount - _myMatchups);
                                const _drop = new Set(_indoorFields.slice(0, Math.min(_demand, _maxDrop)));
                                if (_drop.size) {
                                    availablePool = availablePool.filter(function (o) { return !_drop.has(o.field); });
                                    console.log('   🏠 Withheld ' + _drop.size + ' indoor court(s) [' + [..._drop].join(', ') + '] for indoor-minimum league(s): ' + _later.map(function (l) { return l.name; }).join(', '));
                                }
                            }
                        }
                    }
                } catch (_eIndRes) {}
                // ★ Multi-game-per-day sport variety is now handled PER-MATCHUP,
                // not league-wide. The old code here shrank the single shared
                // availablePool by removing every sport that ANY team in the
                // league had played earlier today — which banned fresh pairs
                // (e.g. Team 3 vs Team 4) from a sport just because a DIFFERENT
                // pair (Team 1 vs Team 2) already used it. With few fields per
                // sport that collapsed the pool below the matchup count and
                // forced byes. The per-matchup assignment functions
                // (assignMatchupsToFieldsAndSports_{Sport,Matchup}Variety)
                // already enforce variety correctly against each pair's OWN
                // history: they exclude sports THIS pair has played together
                // (getPairSports) and apply a strong penalty against repeating
                // each team's most-recent sport. So a fresh pair can reuse a
                // sport another pair played, keeping variety without the byes.

                console.log(`   Available Field/Sport Combinations: ${availablePool.length}`);
                availablePool.slice(0, 10).forEach(p =>
                    console.log(`      • ${p.sport} @ ${p.field}`)
                );

                if (availablePool.length === 0) {
                    console.log(`   🚨 No fields available for league sports!`);
                    _recordByeEvent({
                        league: league.name, kind: 'skipped', time: timeKey, game: gameNumber,
                        reason: 'No fields were open for any of this league\'s sports at this time, so the league period could not run at all — the affected bunks were given regular activities instead. Check field reservations, other leagues at the same time, and which fields host these sports.'
                    });
                    continue;
                }

                // ★★★ Get matchups — playoff > round-robin ★★★
                let matchups;
                let playoffMatchupSports = null;     // null when not in playoff mode
                let playoffMatchupFields = null;     // user-chosen field per matchup ('' = auto)
                let playoffRoundNum = null;
                let playoffIsTBD = false;            // true when emitting placeholder for an undecided future round
                const _PM = window.PlayoffMode;

                // ★ AUTOMATIC ROUND TRACKING: with playoff.startGameCount set
                //   (stamped by the Playoff Hub when playoffs are turned on),
                //   every league tile after that point plays the next round in
                //   sequence — tile #1 = Round 1, tile #2 = Round 2, … — derived
                //   from the same chronological game counter the league already
                //   keeps: round = gameNumber - startGameCount. Legacy playoffs
                //   without the anchor fall back to currentRound + todayGameIndex.
                let _playoffPreseason = false;   // playoff enabled, but this tile predates the start anchor
                if (_PM && _PM.isLeagueInPlayoff(league)) {
                    const _startCnt = league.playoff.startGameCount;
                    const derivedRound = (typeof _startCnt === 'number')
                        ? (gameNumber - _startCnt)
                        : (league.playoff.currentRound + todayGameIndex);
                    if (derivedRound < 1) {
                        console.log('   🏆 PLAYOFF: tile #' + gameNumber + ' predates the playoff start anchor (' + _startCnt + ') — regular league play');
                        _playoffPreseason = true;
                    } else {
                        // ★ Rounds whose winners are already all marked never need
                        //   a tile (e.g. results entered by hand before the round's
                        //   slot ran). Walk forward to the first round that still
                        //   needs games — otherwise the tile would skip, never get
                        //   counted, and the tracker would point at the decided
                        //   round forever.
                        let roundToPlay = derivedRound;
                        if (typeof _PM.getRoundByNumber === 'function') {
                            let _guard = 0;
                            while (_guard++ < 100) {
                                const _r = _PM.getRoundByNumber(league, roundToPlay);
                                if (_r && _PM.isRoundComplete(_r)) roundToPlay++;
                                else break;
                            }
                        }
                        const _reanchor = function () {
                            if (roundToPlay !== derivedRound && typeof _startCnt === 'number') {
                                league.playoff.startGameCount = gameNumber - roundToPlay;
                                console.log('   🏆 PLAYOFF: Round ' + derivedRound + (roundToPlay - derivedRound > 1 ? '–' + (roundToPlay - 1) : '') + ' already decided — tile #' + gameNumber + ' plays Round ' + roundToPlay + ' (anchor re-aligned to ' + league.playoff.startGameCount + ')');
                            }
                        };
                        const userRound = (typeof _PM.getRoundByNumber === 'function')
                            ? _PM.getRoundByNumber(league, roundToPlay) : null;
                        const userRoundMatchups = (userRound && Array.isArray(userRound.matchups)) ? userRound.matchups : [];
                        const userActive = userRoundMatchups.filter(function (m) {
                            return m && m.teamA && m.teamB && m.teamA !== 'BYE' && m.teamB !== 'BYE' && !m.winner;
                        });
                        if (userActive.length > 0) {
                            _reanchor();
                            playoffRoundNum = roundToPlay;
                            matchups = userActive.map(function (m) { return [m.teamA, m.teamB]; });
                            playoffMatchupSports = userActive.map(function (m) { return m.sport || null; });
                            playoffMatchupFields = userActive.map(function (m) { return m.field || ''; });
                            // Keep the hub's display cache in sync with the tracked round
                            league.playoff.currentRound = roundToPlay;
                            console.log('   🏆 PLAYOFF Round ' + roundToPlay + ' (tile #' + gameNumber + '): ' + userActive.length + ' matchup(s)');
                        } else if (!userRound && _PM.getChampion && _PM.getChampion(league)) {
                            console.log('   🏆 PLAYOFF: tournament decided (champion: ' + _PM.getChampion(league) + ') and no Round ' + roundToPlay + ' exists — skipping');
                            continue;
                        } else {
                            // Round not built yet, or built but teams not filled in
                            // — reserve the slot with TBD placeholders sized from
                            // the user's round (or half the previous round).
                            _reanchor();
                            const prevRound = (typeof _PM.getRoundByNumber === 'function')
                                ? _PM.getRoundByNumber(league, roundToPlay - 1) : null;
                            const prevFilled = prevRound
                                ? (prevRound.matchups || []).filter(function (m) {
                                    return m && m.teamA && m.teamB && m.teamA !== 'BYE' && m.teamB !== 'BYE';
                                }) : [];
                            const tbdCount = userRoundMatchups.length > 0
                                ? userRoundMatchups.length
                                : Math.max(1, Math.ceil((prevFilled.length || 2) / 2));
                            const sportsPool = (userRoundMatchups.length ? userRoundMatchups : prevFilled)
                                .map(function (m) { return m.sport || null; })
                                .filter(Boolean);
                            const fallbackSport = (league.sports && league.sports[0]) || null;
                            playoffRoundNum = roundToPlay;
                            playoffIsTBD = true;
                            matchups = [];
                            playoffMatchupSports = [];
                            playoffMatchupFields = [];
                            for (let k = 0; k < tbdCount; k++) {
                                const um = userRoundMatchups[k];
                                matchups.push(['TBD', 'TBD']);
                                playoffMatchupSports.push((um && um.sport)
                                    || (sportsPool.length ? sportsPool[k % sportsPool.length] : fallbackSport));
                                playoffMatchupFields.push((um && um.field) || '');
                            }
                            console.log('   🏆 PLAYOFF Round ' + roundToPlay + ' TBD: ' + tbdCount + ' placeholder matchup(s)'
                                + (userRound ? ' (round built, teams not filled in yet)' : ' (round not built yet — add it in the Playoff Hub)'));
                        }
                    }
                }
                if (!(_PM && _PM.isLeagueInPlayoff(league)) || _playoffPreseason) {
                    // ★ NO PREDETERMINED ROUND-ROBIN: every game's matchups are
                    //   computed FRESH from history — how many times teams have met
                    //   + which sports each team still needs this cycle — via
                    //   chooseDailyMatchups (exact search for ≤12 teams, greedy +
                    //   2-opt beyond). BOTH modes always try for new matchups first;
                    //   the mode decides only the impossible situation where a new
                    //   matchup and a new sport can't both happen:
                    //   • matchup_variety → the new opponent wins (a sport may repeat)
                    //   • sport_variety   → the new sport wins (a matchup may repeat)
                    //   The round-robin round below is computed ONLY as the error/
                    //   kill-switch fallback inside chooseDailyMatchups — it is
                    //   never the plan.
                    const fullSchedule = generateRoundRobinSchedule(activeTeams);
                    const roundIndex = (gameNumber - 1) % fullSchedule.length;
                    const _rrMatchups = fullSchedule[roundIndex] || [];
                    const _prioMode = league.schedulingPriority || 'sport_variety';
                    matchups = chooseDailyMatchups(activeTeams, availablePool, league.name, history, _rrMatchups, dayId, _prioMode);
                }

               console.log(`   Game #${gameNumber} (Today's Game: ${todayGameIndex + 1})`);
                console.log(`   Matchups: ${matchups.length}`);
                matchups.forEach(m => {
                    var t1 = Array.isArray(m) ? m[0] : m;
                    var t2 = Array.isArray(m) ? m[1] : m;
                    console.log(`      • ${t1} vs ${t2}`);
                });

                if (matchups.length === 0) {
                    // ≥2 active teams but no pairings came back — every active team
                    // is effectively on a bye this period. Rare, but report it so
                    // no bye is silent.
                    _recordByeEvent({
                        league: league.name, kind: 'skipped', time: timeKey, game: gameNumber,
                        reason: 'No matchups could be formed for this league period, so no games ran and the teams were given regular activities instead.'
                    });
                    continue;
                }

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
                    // Show the round's reserved fields as "Electives" — where
                    // the teams that are out go during this period.
                    const _tbdReservedRows = (_PM.getReservedForRound
                        ? _PM.getReservedForRound(league, playoffRoundNum)
                        : ((league.playoff && league.playoff.reservedActivities) || []));
                    const _tbdRows = ['Round ' + playoffRoundNum + ' — winners TBD']
                        .concat(_openList.length > 0
                            ? ['Open fields:'].concat(_openList.map(function (s) { return '  • ' + s; }))
                            : ['(no open fields at this time)'])
                        .concat(_tbdReservedRows.length > 0
                            ? ['Electives:'].concat(_tbdReservedRows.map(function (s) { return '  • ' + s; }))
                            : []);
                    console.log('   🏆 PLAYOFF TBD info-only: ' + _openList.length + ' open field(s) listed');
                    leagueDivisions.forEach(function (divName) {
                        const blocksForDiv = timeData.byDivision[divName];
                        if (!blocksForDiv) return;
                        blocksForDiv.forEach(function (block) {
                            const _Utils = window.SchedulerCoreUtils;
                            const _blockKey = (block._spanTimeKey != null) ? block._spanTimeKey
                                : (typeof block.startTime === 'number')
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
                    // know which kids will be playing yet. Per-round list —
                    // later rounds usually reserve more fields as more teams
                    // are knocked out (legacy league-wide list as fallback).
                    // ONE multi-division lock per field (comma list) with an
                    // explicit time window — see the main reserve site below.
                    const _tbdReserved = _PM.getReservedForRound
                        ? _PM.getReservedForRound(league, playoffRoundNum)
                        : ((league.playoff && league.playoff.reservedActivities) || []);
                    if (window.GlobalFieldLocks && _tbdReserved.length > 0) {
                        const reservedReason = 'Playoff reserve (' + league.name + ' R' + playoffRoundNum + ' TBD)';
                        const _tbdResDivs = leagueDivisions.join(', ');
                        // Same window derivation as the main league lock: start
                        // from the authoritative period start (timeKey), end
                        // best-effort from the league's own slot grid.
                        const _tbdDivSlots = window.divisionTimes?.[leagueDivisions[0]] || [];
                        let _tbdStart = (timeKey != null && !isNaN(Number(timeKey))) ? Number(timeKey) : null;
                        let _tbdEnd = null;
                        if (slots.length > 0 && _tbdDivSlots[slots[0]]) {
                            if (_tbdStart == null) _tbdStart = _tbdDivSlots[slots[0]].startMin;
                            _tbdEnd = _tbdDivSlots[slots[slots.length - 1]]?.endMin;
                        }
                        if (_tbdStart != null && (_tbdEnd == null || _tbdEnd <= _tbdStart)) _tbdEnd = _tbdStart + 40;
                        _tbdReserved.forEach(function (act) {
                            try {
                                window.GlobalFieldLocks.lockFieldForDivision(act, slots, _tbdResDivs, reservedReason,
                                    (_tbdStart != null ? { startMin: _tbdStart, endMin: _tbdEnd } : undefined));
                            } catch (e) {
                                console.warn('[PLAYOFF TBD] failed to reserve "' + act + '" for ' + _tbdResDivs + ':', e);
                            }
                        });
                    }
                    console.log('   📈 Game #' + gameNumber + ' (TBD info) complete for "' + league.name + '"');
                    continue;
                }

                // ★★★ PASS SCHEDULING PRIORITY TO ASSIGNMENT FUNCTION ★★★
                // For playoff mode: each matchup has its own fixed sport — bypass
                // the variety logic and assign per-matchup directly.
                _byeCtx = { time: timeKey, game: gameNumber };   // stamp bye records with this period
                let assignments;
                if (playoffMatchupSports) {
                    assignments = [];
                    const _poolUsed = new Set();
                    // ★ The round's reserved fields are saved for the kids who are
                    //   OUT — the playoff games themselves must not auto-pick them
                    //   (the pool is built before the reserve locks apply). An
                    //   EXPLICIT user-chosen field still wins, even if reserved.
                    const _resFieldSet = new Set(
                        (playoffRoundNum && _PM.getReservedForRound)
                            ? _PM.getReservedForRound(league, playoffRoundNum).map(function (f) { return String(f); })
                            : []
                    );
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
                        // Auto-pick never lands on a reserved field.
                        candidates = candidates.filter(function (p) { return !_resFieldSet.has(p.field); });
                        if (candidates.length === 0) {
                            // For TBD placeholders, the "wanted" sport is just a
                            // forecast — the actual round 2 sport isn't known yet.
                            // Fall back to any available pool entry so the slot
                            // still gets reserved with a TBD label.
                            if (playoffIsTBD) {
                                const fallback = availablePool.filter(function (p) { return !_poolUsed.has(p.field) && !_resFieldSet.has(p.field); });
                                if (fallback.length > 0) {
                                    const pickF = fallback[0];
                                    _poolUsed.add(pickF.field);
                                    assignments.push({ team1: teamA, team2: teamB, field: pickF.field, sport: pickF.sport });
                                    console.log('   🏆 PLAYOFF TBD: using fallback ' + pickF.sport + ' @ ' + pickF.field + ' (preferred sport "' + wantedSport + '" unavailable)');
                                    return;
                                }
                            }
                            console.log('   🚨 PLAYOFF: no field for sport "' + wantedSport + '" (matchup ' + teamA + ' vs ' + teamB + ')'
                                + (_resFieldSet.size ? ' — reserved fields [' + Array.from(_resFieldSet).join(', ') + '] are off-limits to games' : ''));
                            _recordByeEvent({
                                league: league.name, kind: 'bye', team1: teamA, team2: teamB,
                                reason: 'Playoff: no open field supported "' + wantedSport + '" at this time — the matchup could not be placed.'
                            });
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
                        },
                        _sportCapsByLeague[league.name] || null,
                        dayId
                    );
                }

                if (assignments.length === 0) {
                    console.log(`   ❌ No assignments possible`);
                    _recordByeEvent({
                        league: league.name, kind: 'skipped',
                        reason: 'None of this league\'s ' + matchups.length + ' matchup(s) could get a field at this time (see the bye entries), so the league period was skipped — the affected bunks were given regular activities instead.'
                    });
                    continue;
                }

                // ★ STRUCTURAL BYES: report every active team that never got into
                //   a matchup this period (odd-team rotation, etc.) so EVERY bye
                //   shown on the grid is accounted for. Regular rounds only —
                //   playoff byes are bracket structure, not what this warns about.
                if (!playoffMatchupSports && !playoffIsTBD) {
                    _recordUnpairedByes(league.name, activeTeams, matchups);
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
// ★ CROSS-LEAGUE DOUBLE-BOOK FIX: lock START is the authoritative period start
//   (timeKey), NOT a foreign slot index into this league's grid — see the note
//   in buildAvailableFieldSportPool. Any two windows that share this start
//   overlap, so a second league's time-based pool check now reliably sees this
//   lock. End stays best-effort from this league's own grid, guarded so an
//   inverted (empty) window can't slip a field through.
var _lkParse = window.SchedulerCoreUtils?.parseTimeToMinutes;
var _lockStartMin = (timeKey != null && !isNaN(Number(timeKey))) ? Number(timeKey)
    : (_lkParse ? (_lkParse(timeKey) ?? null) : null);
var _lockEndMin = null;
if (slots.length > 0 && _leagueDivSlots[slots[0]]) {
    if (_lockStartMin == null) _lockStartMin = _leagueDivSlots[slots[0]].startMin;
    _lockEndMin = _leagueDivSlots[slots[slots.length - 1]]?.endMin;
}
if (_lockStartMin != null && (_lockEndMin == null || _lockEndMin <= _lockStartMin)) _lockEndMin = _lockStartMin + 40;
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
// User-configured PER-ROUND list of facilities/activities that should be
// reserved exclusively for this league's divisions during the playoff slot,
// so the auto-scheduler routes the not-playing/eliminated bunks into them.
// Later rounds usually reserve more fields as more teams are knocked out
// (legacy league-wide list as fallback for old data / unbuilt rounds).
if (playoffRoundNum) {
    const _roundReserved = _PM.getReservedForRound
        ? _PM.getReservedForRound(league, playoffRoundNum)
        : ((league.playoff && league.playoff.reservedActivities) || []);
    if (_roundReserved.length > 0) {
        const reservedReason = `Playoff reserve (${league.name} R${playoffRoundNum}` + (playoffIsTBD ? ' TBD)' : ')');
        // ★ ONE division lock per field, allowing ALL the league's divisions
        //   (comma list — see GlobalFieldLocks.divisionAllowed). Per-division
        //   calls overwrote each other, leaving only the LAST division allowed.
        //   Explicit time window so cross-grade time checks don't have to guess
        //   from slot grids that may not line up.
        const _resDivs = leagueDivisions.join(', ');
        _roundReserved.forEach(function (act) {
            try {
                window.GlobalFieldLocks.lockFieldForDivision(act, slots, _resDivs, reservedReason,
                    { startMin: _lockStartMin, endMin: _lockEndMin });
            } catch (e) {
                console.warn('[PLAYOFF] failed to reserve "' + act + '" for ' + _resDivs + ':', e);
            }
        });
        console.log('   🎯 PLAYOFF R' + playoffRoundNum + ': reserved [' + _roundReserved.join(', ') + '] for [' + _resDivs + ']');
    }
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
        // ★ Span-merged blocks were re-bucketed to the group's earliest time;
        //   match them on the merged key, not their own start time.
        const _blockKey = (block._spanTimeKey != null) ? block._spanTimeKey
            : (typeof block.startTime === 'number')
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
        // ★ PLAYOFF tiles: teams that are OUT are not listed as byes anymore —
        //   only the round's explicitly-marked byes (sitting out, still in)
        //   show. Underneath the matchups the tile lists the round's reserved
        //   fields under "Electives" — that's where the not-playing kids go.
        let _byeLines, _electiveLines = [];
        if (playoffRoundNum) {
            const _round = _PM && _PM.getRoundByNumber ? _PM.getRoundByNumber(league, playoffRoundNum) : null;
            _byeLines = ((_round && _round.byes) || [])
                .filter(function (t) { return !_playingTeams.has(t); })
                .map(function (t) { return `${t} — Bye`; });
            const _resFields = (_PM && _PM.getReservedForRound)
                ? _PM.getReservedForRound(league, playoffRoundNum)
                : ((league.playoff && league.playoff.reservedActivities) || []);
            if (_resFields.length > 0) {
                _electiveLines = ['Electives:'].concat(_resFields.map(function (f) { return `  • ${f}`; }));
            }
        } else {
            _byeLines = (activeTeams || [])
                .filter(function (t) { return !_playingTeams.has(t); })
                .map(function (t) { return `${t} — Bye`; });
        }
        const pick = {
                            field: `League: ${league.name}`,
                            sport: _firstSport,
                            _activity: `League: ${league.name}`,
                            _leagueName: league.name,
                            _h2h: true,
                            _fixed: true,
                            _allMatchups: assignments.map(a =>
                                `${a.team1} vs ${a.team2} @ ${a.field} (${a.sport})`
                            ).concat(_byeLines).concat(_chinuchLines).concat(_electiveLines),
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
        // ★ Per-tile regen: the day's total = games scheduled THIS run + preserved
        //   (not re-rolled) games kept through the rollback — so adding a morning
        //   game to a day that already had an evening game counts as 2, and the
        //   next day's game number advances correctly.
        for (const [leagueName, count] of Object.entries(leagueGameCounters)) {
            if (count > 0) {
                recordGamesOnDate(leagueName, dayId, count + (_preservedTodayCounts[leagueName] || 0), history);
            }
        }

        // ★ Per-tile regen: renumber the day's games CHRONOLOGICALLY. A new game
        //   scheduled at an EARLIER period than a preserved one is numbered after
        //   it (label-collision avoidance above), leaving e.g. the 12:20 game as
        //   "Game 8" and the 5:10 game as "Game 7". Re-stamp the day's "Game N"
        //   labels in slot-time order (times from the games' own _startMin stamps);
        //   the FN-58 sync below rebuilds the Leagues-page entries from the
        //   renumbered log, so everything stays consistent. Bails untouched when
        //   any game's time is unknown. No-op for normal generations (no preserved
        //   games) — the engine already schedules those in chronological order.
        try {
            _dayResetLeagues.forEach(function (lgName) {
                if (!(_preservedTodayCounts[lgName] > 0)) return;
                const _recs = history.gameLog?.[lgName]?.[dayId] || [];
                const _labels = Array.from(new Set(_recs.map(r => r && r.g).filter(g => /^Game \d+$/.test(g || ''))));
                if (_labels.length < 2) return;
                // label → earliest start time, from the live league assignments
                const _times = {};
                Object.keys(window.leagueAssignments || {}).forEach(function (dv) {
                    const _map = window.leagueAssignments[dv] || {};
                    Object.keys(_map).forEach(function (k) {
                        const g = _map[k];
                        if (!g || g.leagueName !== lgName || !g.gameLabel || g._startMin == null) return;
                        if (_times[g.gameLabel] == null || g._startMin < _times[g.gameLabel]) _times[g.gameLabel] = g._startMin;
                    });
                });
                if (!_labels.every(l => _times[l] != null)) return;  // a game's time is unknown → leave as-is
                const _base = calculateStartingGameNumber(lgName, dayId, history);
                const _sorted = _labels.slice().sort((a, b) => _times[a] - _times[b]);
                const _relabel = {};
                _sorted.forEach(function (l, i) {
                    const nl = 'Game ' + (_base + i + 1);
                    if (nl !== l) _relabel[l] = nl;
                });
                if (!Object.keys(_relabel).length) return;
                // One pass from the OLD labels (safe even when two labels swap).
                history.gameLog[lgName][dayId] = _recs.map(r =>
                    (r && r.g && _relabel[r.g]) ? Object.assign({}, r, { g: _relabel[r.g] }) : r);
                Object.keys(window.leagueAssignments || {}).forEach(function (dv) {
                    const _map = window.leagueAssignments[dv] || {};
                    Object.keys(_map).forEach(function (k) {
                        const g = _map[k];
                        if (g && g.leagueName === lgName && g.gameLabel && _relabel[g.gameLabel]) g.gameLabel = _relabel[g.gameLabel];
                    });
                });
                console.log('[RegularLeagues] ↔️ Renumbered "' + lgName + '" ' + dayId + ' chronologically: ' +
                    Object.keys(_relabel).map(o => o + '→' + _relabel[o]).join(', '));
            });
        } catch (eRn) { console.warn('[RegularLeagues] chronological renumber skipped:', eRn); }

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

        // ★★★ INDOOR-MINIMUM VERIFICATION ★★★ — after the whole day is scheduled,
        // report every team that ended below its league's indoor floor so a miss
        // is visible instead of silent. Shortfalls are also published on
        // window.__leagueIndoorShortfalls for validators / UI checks.
        try {
            window.__leagueIndoorShortfalls = [];
            const _verLeagues = Array.isArray(masterLeagues) ? masterLeagues : Object.values(masterLeagues || {});
            _verLeagues.forEach(function (l) {
                const r = l && l.indoorRequirement;
                if (!l || l.enabled === false || !r || !r.enabled || (r.op || '>=') === '<=') return;
                const ic = indoorCountsByLeague[l.name];
                if (!ic) return;   // league didn't schedule any games today
                const tgt = Number.isFinite(r.count) ? r.count : 1;
                const short = (l.teams || []).filter(function (t) { return (ic[t] || 0) < tgt; });
                if (short.length) {
                    console.warn('⚠️ [IndoorMin] "' + l.name + '": ' + short.length + ' team(s) ended BELOW the indoor minimum (' + tgt + '/day): '
                        + short.map(function (t) { return t + ' ' + (ic[t] || 0) + '/' + tgt; }).join(', '));
                    window.__leagueIndoorShortfalls.push({
                        league: l.name, target: tgt,
                        teams: short.map(function (t) { return { team: t, got: ic[t] || 0 }; })
                    });
                } else {
                    console.log('✅ [IndoorMin] "' + l.name + '": every team met the indoor minimum (' + tgt + '/day)');
                }
            });
        } catch (_eIndVer) {}

        // ★★★ BYE / SKIPPED-GAME NOTIFICATION ★★★ — surface every matchup that
        // got a forced bye and every league period that couldn't run because
        // fields ran out. Dispatches 'campistry-league-bye-warnings' (rendered
        // by coverage_warning.js); an empty dispatch clears a stale banner.
        _publishByeReport();

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

    // Read-only history snapshot for UI consumers (league_play_report.js) so
    // they get the same cloud/local fresher-wins resolution the engine uses.
    Leagues.getHistorySnapshot = function () {
        return loadLeagueHistory();
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

    // =========================================================================
    // POST-EDIT ROTATION SYNC — single-game matchup edit
    // =========================================================================
    // When a league game is changed AFTER generation (post-edit: teams/sport/
    // field), the three rotation stores must follow what was ACTUALLY played or
    // the variety logic is poisoned (a sport/opponent that never happened keeps
    // getting avoided; one that did happen keeps getting picked). This is the
    // edit-time mirror of the generation-time logGameRecord/recordMatchup/
    // recordTeamSport calls, made reversible via the date-keyed gameLog.
    //
    //   oldGame / newGame: { teamA|team1, teamB|team2, sport }  (field ignored)
    //     • oldGame matches a logged entry → its contribution is subtracted and
    //       the entry rewritten to newGame.
    //     • no match (game wasn't logged / fresh manual matchup) → newGame is
    //       inserted.
    //     • newGame = null → only remove oldGame.
    Leagues.editGameRecord = function (leagueName, date, oldGame, newGame, gameLabel) {
        if (!leagueName || !date) return { ok: false, reason: 'missing league/date' };
        try {
            const history = loadLeagueHistory();
            history.gameLog = history.gameLog || {};
            history.gameLog[leagueName] = history.gameLog[leagueName] || {};
            history.gameLog[leagueName][date] = history.gameLog[leagueName][date] || [];
            history.teamSports = history.teamSports || {};
            history.matchupHistory = history.matchupHistory || {};

            const pick = function (o, a, b) { return o ? (o[a] != null ? o[a] : o[b]) : null; };
            const oA = pick(oldGame, 'teamA', 'team1');
            const oB = pick(oldGame, 'teamB', 'team2');
            const oS = oldGame ? (oldGame.sport || null) : null;

            // (1) subtract the old game from its matching logged entry
            let removed = false, removedLabel = null;
            if (oA && oB) {
                const log = history.gameLog[leagueName][date];
                const oKey = getMatchupKey(oA, oB);
                for (let i = 0; i < log.length; i++) {
                    const e = log[i];
                    if (!e) continue;
                    if (getMatchupKey(e.t1, e.t2) === oKey && (oS == null || (e.sport || null) === oS)) {
                        if (e.sport) {
                            [e.t1, e.t2].forEach(function (t) {
                                const arr = history.teamSports[`${leagueName}|${t}`];
                                if (arr) { const idx = arr.lastIndexOf(e.sport); if (idx !== -1) arr.splice(idx, 1); }
                            });
                        }
                        const mk = `${leagueName}:${oKey}`;
                        if (history.matchupHistory[mk] > 1) history.matchupHistory[mk]--;
                        else delete history.matchupHistory[mk];
                        removedLabel = e.g || null;
                        log.splice(i, 1);
                        removed = true;
                        break;
                    }
                }
            }

            // (2) insert the new game (carry the removed entry's label if none given)
            if (newGame) {
                const nA = pick(newGame, 'teamA', 'team1');
                const nB = pick(newGame, 'teamB', 'team2');
                const nS = newGame.sport || null;
                if (nA && nB) {
                    if (nS) { recordTeamSport(leagueName, nA, nS, history); recordTeamSport(leagueName, nB, nS, history); }
                    recordMatchup(leagueName, nA, nB, history);
                    logGameRecord(leagueName, date, nA, nB, nS, history, gameLabel || removedLabel || null);
                }
            }

            saveLeagueHistory(history);

            // (3) keep the Leagues-page results store in sync (preserves scores
            //     for matchups that still exist; mirrors FN-58 auto-save).
            try {
                if (window.LeaguesAPI && typeof window.LeaguesAPI.syncGamesFromGeneration === 'function') {
                    const byLabel = {};
                    (history.gameLog[leagueName][date] || []).forEach(function (e) {
                        const lbl = e.g || 'Game';
                        (byLabel[lbl] = byLabel[lbl] || []).push({ teamA: e.t1, teamB: e.t2, sport: e.sport || null });
                    });
                    const entries = Object.keys(byLabel).map(function (lbl) {
                        const m = String(lbl).match(/Game\s*(\d+)/i);
                        return { gameLabel: lbl, gameNumber: m ? parseInt(m[1], 10) : null, matches: byLabel[lbl] };
                    });
                    window.LeaguesAPI.syncGamesFromGeneration(leagueName, date, entries);
                }
            } catch (e) { console.warn('[RegularLeagues] editGameRecord results-sync skipped:', e); }

            console.log(`[RegularLeagues] ✏️ editGameRecord "${leagueName}" ${date}: removed=${removed}` +
                (newGame ? ` added=${pick(newGame, 'teamA', 'team1')} vs ${pick(newGame, 'teamB', 'team2')} (${newGame.sport || '—'})` : ''));
            return { ok: true, removed: removed, league: leagueName, date: date };
        } catch (e) {
            console.error('[RegularLeagues] editGameRecord error:', e);
            return { ok: false, reason: String(e && e.message || e) };
        }
    };

    window.SchedulerCoreLeagues = Leagues;
    console.log('[RegularLeagues] Module loaded with Chronological Date Ordering + Cloud Persistence v9 (gameLog matchup count + recency tiebreak)');
})();
