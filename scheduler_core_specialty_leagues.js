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

    // =========================================================================
    // ★ LG-8 (specialty port): (LEAGUE, DATE)-GRANULAR HISTORY MERGE
    // =========================================================================
    // Same failure class as the regular engine: the specialty history rode the
    // debounced camp_state_kv sync as a whole blob, and the loader let a cloud
    // copy shadow local WHOLESALE — two writers (devices/tabs/roles) diverged
    // into lineages and generation ran blind to whichever copy lost. The merge
    // treats each (leagueId, date) as the unit: fresher copy wins conflicts,
    // tombstones make deletions stick, and the derived stores (matchupHistory
    // date-arrays, teamFieldRotation, slotDebt) are REBUILT from the merged
    // gameLog for leagues that have one, so they can never diverge from it.
    // Flat overwrite-only stores (lastSlotOrder, conferenceRounds) come from
    // the fresher copy.
    function mergeSpecialtyHistories(a, b) {
        const norm = (h) => {
            const out = {
                teamFieldRotation: (h && h.teamFieldRotation) || {},
                lastSlotOrder: (h && h.lastSlotOrder) || {},
                conferenceRounds: (h && h.conferenceRounds) || {},
                matchupHistory: (h && h.matchupHistory) || {},
                gamesPerDate: (h && h.gamesPerDate) || {},
                gameLog: (h && h.gameLog) || {},
                slotDebt: (h && h.slotDebt) || {},
                _tombstones: (h && h._tombstones) || {},
                _savedAt: Number(h && h._savedAt) || 0
            };
            if (h && h._resetAt) out._resetAt = Number(h._resetAt) || 0;
            if (h && h._countersResetAt) out._countersResetAt = Number(h._countersResetAt) || 0;
            return out;
        };
        if (!a) return b ? norm(b) : norm(null);
        if (!b) return norm(a);
        const A = norm(a), B = norm(b);
        const F = (A._savedAt >= B._savedAt) ? A : B;   // fresher copy
        const O = (A._savedAt >= B._savedAt) ? B : A;   // older copy

        const merged = {
            teamFieldRotation: {},
            lastSlotOrder: F.lastSlotOrder,
            conferenceRounds: F.conferenceRounds,
            matchupHistory: {},
            gamesPerDate: {},
            gameLog: {},
            slotDebt: {},
            _tombstones: {},
            _savedAt: Math.max(A._savedAt, B._savedAt)
        };
        [F, O].forEach(function (h) {
            Object.keys(h._tombstones).forEach(function (k) {
                const ts = Number(h._tombstones[k]) || 0;
                if (!(merged._tombstones[k] >= ts)) merged._tombstones[k] = ts;
            });
        });
        merged._resetAt = Math.max(Number(a && a._resetAt) || 0, Number(b && b._resetAt) || 0) || undefined;
        if (merged._resetAt === undefined) delete merged._resetAt;
        const countersResetAt = Math.max(Number(a && a._countersResetAt) || 0, Number(b && b._countersResetAt) || 0);
        if (countersResetAt) merged._countersResetAt = countersResetAt;
        const tombTs = function (lg, d) {
            return Math.max(
                merged._tombstones[lg + '|' + d] || 0,
                merged._tombstones['*|' + d] || 0,
                Number(merged._resetAt) || 0
            );
        };
        [F, O].forEach(function (src) {
            Object.keys(src.gameLog).forEach(function (lg) {
                Object.keys(src.gameLog[lg] || {}).forEach(function (d) {
                    if (merged.gameLog[lg] && merged.gameLog[lg][d]) return;
                    if (!(src.gameLog[lg][d] || []).length) return;
                    if (tombTs(lg, d) > src._savedAt) return;
                    (merged.gameLog[lg] = merged.gameLog[lg] || {})[d] = src.gameLog[lg][d];
                });
            });
            Object.keys(src.gamesPerDate).forEach(function (lg) {
                if (!merged.gamesPerDate[lg]) merged.gamesPerDate[lg] = {};
                Object.keys(src.gamesPerDate[lg] || {}).forEach(function (d) {
                    if (merged.gamesPerDate[lg][d] !== undefined) return;
                    if (tombTs(lg, d) > src._savedAt) return;
                    if (countersResetAt > src._savedAt) return;
                    merged.gamesPerDate[lg][d] = src.gamesPerDate[lg][d];
                });
            });
        });
        if (!countersResetAt) {
            Object.keys(merged.gameLog).forEach(function (lg) {
                Object.keys(merged.gameLog[lg]).forEach(function (d) {
                    if (merged.gamesPerDate[lg] && merged.gamesPerDate[lg][d] !== undefined) return;
                    const labels = new Set();
                    (merged.gameLog[lg][d] || []).forEach(function (e) { if (e && e.g) labels.add(e.g); });
                    (merged.gamesPerDate[lg] = merged.gamesPerDate[lg] || {})[d] = Math.max(labels.size, 1);
                });
            });
        }
        // Rebuild derived stores from the merged log; leagues with no gameLog
        // at all (pure legacy) keep the fresher copy's entries.
        const loggedLeagues = new Set(Object.keys(merged.gameLog));
        const keepLegacy = function (srcMap, destMap) {
            Object.keys(srcMap).forEach(function (k) {
                if (!loggedLeagues.has(k.split('|')[0])) destMap[k] = srcMap[k];
            });
        };
        keepLegacy(F.teamFieldRotation, merged.teamFieldRotation);
        keepLegacy(F.matchupHistory, merged.matchupHistory);
        keepLegacy(F.slotDebt, merged.slotDebt);
        loggedLeagues.forEach(function (lg) {
            Object.keys(merged.gameLog[lg]).sort().forEach(function (d) {
                (merged.gameLog[lg][d] || []).forEach(function (e) {
                    if (!e || !e.tA || !e.tB) return;
                    const mk = `${lg}|${[e.tA, e.tB].sort().join('|')}`;
                    (merged.matchupHistory[mk] = merged.matchupHistory[mk] || []).push(d);
                    if (e.field) {
                        [e.tA, e.tB].forEach(function (t) {
                            const fk = `${lg}|${t}`;
                            (merged.teamFieldRotation[fk] = merged.teamFieldRotation[fk] || []).push(e.field);
                        });
                    }
                    if (e.s != null) {
                        const w = Math.max(0, (e.s || 1) - 1);
                        if (w > 0) {
                            [e.tA, e.tB].forEach(function (t) {
                                const sk = `${lg}|${t}`;
                                merged.slotDebt[sk] = (merged.slotDebt[sk] || 0) + w;
                            });
                        }
                    }
                });
            });
        });
        return merged;
    }
    SpecialtyLeagues.mergeSpecialtyHistories = mergeSpecialtyHistories;   // diagnostics + batched-sync merge + tests

    function loadSpecialtyHistory() {
        const EMPTY = () => ({
            teamFieldRotation: {}, lastSlotOrder: {}, conferenceRounds: {},
            matchupHistory: {}, gamesPerDate: {}, gameLog: {}, _tombstones: {}
        });
        try {
            // Cloud-synced copy (hydrated into global settings)
            const global = window.loadGlobalSettings?.() || {};
            const cloud = (global.specialtyLeagueHistory && Object.keys(global.specialtyLeagueHistory).length > 0)
                ? global.specialtyLeagueHistory : null;

            // localStorage backup
            let local = null;
            try {
                const raw = localStorage.getItem(SPECIALTY_HISTORY_KEY);
                if (raw) local = JSON.parse(raw);
            } catch (_) {}

            // ★ LG-8: MERGE the copies at (league, date) granularity — the old
            // cloud-wholesale-wins load let a stale cloud row shadow newer
            // local days (and vice versa via the backup), so generation ran
            // blind to the losing lineage's games.
            let history;
            if (cloud && local) {
                history = mergeSpecialtyHistories(cloud, local);
                console.log('[SpecialtyLeagues] ✅ Loaded history (merged cloud + local)');
            } else if (cloud) {
                history = cloud;
                console.log("[SpecialtyLeagues] ✅ Loaded history from cloud");
            } else if (local) {
                history = local;
                // Migrate old format if needed
                if (history.roundCounters && !history.gamesPerDate) {
                    console.log("[SpecialtyLeagues] Migrating old history format...");
                    history.gamesPerDate = {};
                }
            } else {
                return EMPTY();
            }

            // Ensure all fields exist
            history.teamFieldRotation = history.teamFieldRotation || {};
            history.lastSlotOrder = history.lastSlotOrder || {};
            history.conferenceRounds = history.conferenceRounds || {};
            history.matchupHistory = history.matchupHistory || {};
            history.gamesPerDate = history.gamesPerDate || {};
            history.gameLog = history.gameLog || {};
            history._tombstones = history._tombstones || {};
            return history;
        } catch (e) {
            console.error("[SpecialtyLeagues] Failed to load history:", e);
            return EMPTY();
        }
    }

    // ★ LG-8: DIRECT VERIFIED CLOUD PUSH — specialty analog of the regular
    // engine's push (see _pushLeagueHistoryToCloud there): write the row
    // immediately with read-merge-write, retry 3× with backoff, warn loudly
    // on a permissions rejection, coalesce concurrent saves.
    let _spHistoryPushInFlight = false;
    let _spHistoryPushQueued = null;
    function _pushSpecialtyHistoryToCloud(history) {
        try {
            const sb = (typeof window !== 'undefined') && window.supabase;
            const campId = (typeof window !== 'undefined') && window.CampistryDB && window.CampistryDB.getCampId && window.CampistryDB.getCampId();
            if (!sb || !campId) return;
            if (_spHistoryPushInFlight) { _spHistoryPushQueued = history; return; }
            _spHistoryPushInFlight = true;
            const baseDelay = (typeof window !== 'undefined' && Number(window.__leagueHistoryPushRetryMs)) || 2000;
            (async function () {
                let delay = baseDelay;
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        let payload = history;
                        try {
                            const r = await sb.from('camp_state_kv').select('value')
                                .eq('camp_id', campId).eq('key', 'specialtyLeagueHistory').maybeSingle();
                            const cur = r && !r.error && r.data && r.data.value;
                            if (cur && typeof cur === 'object' && (cur.gameLog || cur.gamesPerDate)) {
                                payload = mergeSpecialtyHistories(history, cur);
                            }
                        } catch (_e) {}
                        const res = await sb.from('camp_state_kv').upsert({
                            camp_id: campId, key: 'specialtyLeagueHistory', value: payload,
                            updated_at: new Date().toISOString()
                        }, { onConflict: 'camp_id,key' });
                        const err = res && res.error;
                        if (!err) {
                            console.log('[SpecialtyLeagues] ☁️ History pushed to cloud (verified)');
                            break;
                        }
                        if (String(err.code) === '42501' || /permission|policy|row-level|violates/i.test(err.message || '')) {
                            console.warn('[SpecialtyLeagues] 🚨 History cloud write BLOCKED by permissions — '
                                + 'games recorded in this session exist only on this device. Generate from an '
                                + 'owner/admin account, or apply the scheduler camp_state_kv write migration.', err.message || err);
                            break;
                        }
                        throw err;
                    } catch (e) {
                        if (attempt >= 3) {
                            console.warn('[SpecialtyLeagues] ⚠️ History cloud push failed after 3 attempts — '
                                + 'relying on the batched sync/localStorage backup:', (e && e.message) || e);
                            break;
                        }
                        await new Promise(function (res) { setTimeout(res, delay); });
                        delay *= 2;
                    }
                }
                _spHistoryPushInFlight = false;
                if (_spHistoryPushQueued) {
                    const next = _spHistoryPushQueued;
                    _spHistoryPushQueued = null;
                    _pushSpecialtyHistoryToCloud(next);
                }
            })();
        } catch (_e) {}
    }

    // ★ LG-8: pre-generation cloud refresh — specialty analog of
    // SchedulerCoreLeagues.refreshHistoryFromCloud. Fetches the authoritative
    // row and MERGES it with this device's copy so today's matchups are chosen
    // from the true cross-session record. Best-effort + time-boxed.
    SpecialtyLeagues.refreshHistoryFromCloud = async function () {
        try {
            const sb = (typeof window !== 'undefined') && window.supabase;
            const campId = (typeof window !== 'undefined') && window.CampistryDB && window.CampistryDB.getCampId && window.CampistryDB.getCampId();
            if (!sb || !campId) { console.log('[SpecialtyLeagues] cloud refresh skipped (no client/camp)'); return false; }
            const q = sb.from('camp_state_kv').select('value').eq('camp_id', campId).eq('key', 'specialtyLeagueHistory').maybeSingle();
            const timeout = new Promise(function (res) { setTimeout(function () { res({ _timedOut: true }); }, 6000); });
            const r = await Promise.race([q, timeout]);
            if (r && r._timedOut) { console.warn('[SpecialtyLeagues] cloud history refresh timed out — using existing copy'); return false; }
            if (r && r.error) { console.warn('[SpecialtyLeagues] cloud history refresh error — using existing copy:', r.error); return false; }
            const cloud = r && r.data && r.data.value;
            if (!cloud || typeof cloud !== 'object' || !cloud.gameLog) { console.log('[SpecialtyLeagues] no cloud history to refresh'); return false; }
            const merged = mergeSpecialtyHistories(cloud, loadSpecialtyHistory());
            if (typeof window.saveGlobalSettings === 'function') { try { window.saveGlobalSettings('specialtyLeagueHistory', merged); } catch (_) {} }
            try { localStorage.setItem(SPECIALTY_HISTORY_KEY, JSON.stringify(merged)); } catch (_) {}
            console.log('[SpecialtyLeagues] ☁️ Refreshed history from cloud (merged; ' +
                Object.keys(merged.gameLog || {}).length + ' league(s))');
            return true;
        } catch (e) {
            console.warn('[SpecialtyLeagues] cloud history refresh failed — using existing copy:', e);
            return false;
        }
    };

    function saveSpecialtyHistory(history) {
        // ★ LG-8: stamp the save so merges can order the copies.
        try { if (history && typeof history === 'object') history._savedAt = Date.now(); } catch (_) {}
        // ★ Cloud save FIRST and in its OWN try — see saveLeagueHistory: a full
        //   localStorage must never block the cloud write. Previously a quota error
        //   on the localStorage backup skipped saveGlobalSettings, so the day's games
        //   never synced and the counter reset on the next cold start.
        if (typeof window.saveGlobalSettings === 'function') {
            try {
                window.saveGlobalSettings('specialtyLeagueHistory', history);
                console.log("[SpecialtyLeagues] ✅ History saved (queued for cloud sync)");
            } catch (e) {
                console.error("[SpecialtyLeagues] Failed to save history to cloud:", e);
            }
        }
        // ★ LG-8: immediate verified push, independent of the debounced batch.
        _pushSpecialtyHistoryToCloud(history);
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
                        
                        // ★ LG-31: dedup by actual TIME, not raw slot index — different
                        //   divisions use different slot indices for the same clock time,
                        //   so a bare-index key counted one shared game as several and
                        //   inflated future game numbers. Mirrors the regular engine.
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
                            
                            console.log(`[SpecialtyLeagues] Slot ${slotIdx}: Current Game ${currentNum}, Should be Game ${correctNum}`);
                            
                            if (currentNum !== correctNum) {
                                console.log(`[SpecialtyLeagues] 📝 Updating ${leagueName} on ${futureDate}: Game ${currentNum} → Game ${correctNum}`);
                                
                                // ★ LG-31: update every division cell at the SAME TIME
                                //   (not the same slot index) — a shared game can sit at
                                //   different slot indices per division.
                                for (const d of divNames) {
                                    const dData = leagueAssignments[d] || {};
                                    for (const dSlot of Object.keys(dData)) {
                                        const cell = dData[dSlot];
                                        if (!cell || !cell.isSpecialtyLeague) continue;
                                        if (cell.leagueName !== leagueName && cell.leagueName !== leagueId) continue;
                                        const dTimes = window.divisionTimes?.[d] || [];
                                        const dTimeObj = dTimes[parseInt(dSlot)];
                                        const dTimeKey = dTimeObj?.startTime || dTimeObj?.start || `fallback_${dSlot}`;
                                        const dNormalized = Utils?.parseTimeToMinutes?.(dTimeKey) ?? dTimeKey;
                                        if (`time_${dNormalized}` === slotKey) {
                                            cell.gameLabel = `Game ${correctNum}`;
                                        }
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
                // ★ LG-31 / FN-10: sequential per-day counter for the per-bunk copy.
                //   The old code did indexOf(`${i}`) into the time_-keyed processedSlots
                //   set — never matched, so every game on the date got the same number.
                let bunkGameIndexWithinDay = 0;

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
                            // ★ LG-31 / FN-10: number by sequential per-day game order —
                            //   the old indexOf into the time_-keyed processedSlots set
                            //   never matched a bare bunk-schedule index, so every game
                            //   on the date got numbered identically in the per-bunk copy.
                            const correctNum = gamesBeforeThisDate + bunkGameIndexWithinDay + 1;
                            
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
                            bunkGameIndexWithinDay++;
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

    function getWaitPriorityScore(teamA, teamB, slotDebt, leagueId) {
        const keyA = `${leagueId}|${teamA}`;
        const keyB = `${leagueId}|${teamB}`;

        // Cumulative "late-slot debt": the total number of periods each team has had
        // to WAIT (slotOrder-1 summed over ALL its games). Teams that have waited more
        // across the season score higher → sorted first → placed in the early (no-wait)
        // slot this time. Using the running total (not just the last game) keeps the
        // who-plays-first / who-waits order fair over the whole season, so the same
        // teams aren't repeatedly stuck waiting on a shared court.
        const debtA = (slotDebt && slotDebt[keyA]) || 0;
        const debtB = (slotDebt && slotDebt[keyB]) || 0;

        return (debtA + debtB) * 50;
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

    function assignMatchupsToFieldsAndSlots(matchups, league, history, slots, divName) {
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
            availableFields = window.GlobalFieldLocks.filterAvailableFields(availableFields, slots, divName);

            // ★ CROSS-GRADE ELECTIVE/PINNED RESERVATION: slot indices are NOT comparable
            //   across divisions — slot N maps to a different clock time per grade — so the
            //   slot-index filter above is blind to a lock registered on ANOTHER grade's
            //   grid (e.g. a grade-level elective). An elective reserves its facility for
            //   its OWN grade only; every other grade/division is off-limits at that time.
            //   Re-filter by actual TIME so a facility reserved by another grade's elective
            //   (or any time-locked field) can never be grabbed by this specialty league.
            if (typeof window.GlobalFieldLocks.isFieldLockedByTime === 'function') {
                const _dtsSL = (divName && window.divisionTimes && window.divisionTimes[divName]) || [];
                const _wStartSL = _dtsSL[slots[0]] && _dtsSL[slots[0]].startMin;
                const _wEndSL = _dtsSL[slots[slots.length - 1]] && _dtsSL[slots[slots.length - 1]].endMin;
                if (_wStartSL != null && _wEndSL != null) {
                    availableFields = availableFields.filter(f =>
                        !window.GlobalFieldLocks.isFieldLockedByTime(f, _wStartSL, _wEndSL, divName));
                    // ★ Also honor Daily-Adjustments field reservations (window.fieldReservations),
                    //   division-aware: block a field only when reserved by a DIFFERENT division
                    //   (so this division's own signup-league pool stays usable). See RegularLeagues
                    //   for the full rationale (the מתמדים Home Run Stadium double-book).
                    if (window.fieldReservations) {
                        const _myDiv = String(divName || '').toLowerCase().trim();
                        availableFields = availableFields.filter(f => {
                            const _rl = window.fieldReservations[f] || [];
                            return !_rl.some(r => r && r.startMin < _wEndSL && r.endMin > _wStartSL &&
                                r.division && String(r.division).toLowerCase().trim() !== _myDiv);
                        });
                    }
                }
            }

            const lockedFields = fields.filter(f => !availableFields.includes(f));
            if (lockedFields.length > 0) {
                console.log(`[SpecialtyLeagues] ⚠️ Fields already locked: ${lockedFields.join(', ')}`);
            }
        }

        // ★★★ FILTER OUT FIELDS BLOCKED BY TIME RULES ★★★
        // Per-grade scoping: skip rules whose `divisions` list doesn't
        // intersect this league's active divisions. Empty/missing list = all.
        if (slots && slots.length > 0) {
            // ★ LG-24: resolve the slot window against the DIVISION BEING SCHEDULED, not
            //   an arbitrary first key of divisionTimes — slot index N maps to a different
            //   clock time per division, so using the wrong division dropped/kept courts by
            //   the wrong time window. Fall back to the first key only if divName is missing.
            const _divSlots = (divName && window.divisionTimes?.[divName])
                || window.divisionTimes?.[Object.keys(window.divisionTimes || {})[0]] || [];
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
                // ★ Config-level shut-off: court toggled UNAVAILABLE in Facilities
                //   (available:false). Regular leagues drop these at their pool
                //   build (field.available===false), sports/specials are dropped
                //   at the loader — but specialty leagues use their OWN configured
                //   court pool and never checked the master toggle, so a court you
                //   turned off in Facilities could still host specialty games.
                if (fc.available === false) return false;
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

        // ★ Per-field sport shut-off (DA Resources → uncheck a sport on a court,
        //   stored in dailyDisabledSportsByField). A specialty league plays one
        //   fixed sport (league.sport); drop any court where that sport is turned
        //   off today, mirroring the RegularLeagues pool filter. Keyed to the
        //   authoritative gen-date; fail-open on read error.
        try {
            const _spSport = league && league.sport;
            if (_spSport) {
                let _dsbf = null;
                try {
                    const _dd = window.loadCurrentDailyData ? window.loadCurrentDailyData() : null;
                    if (_dd && _dd.dailyDisabledSportsByField && Object.keys(_dd.dailyDisabledSportsByField).length) _dsbf = _dd.dailyDisabledSportsByField;
                } catch (_e) {}
                if (!_dsbf) {
                    const _dk = window._activeGenDate || window.currentScheduleDate || '';
                    if (_dk) {
                        const _s = localStorage.getItem('campResourceOverrides_' + _dk);
                        if (_s) { const _p = JSON.parse(_s); if (_p && _p.dailyDisabledSportsByField) _dsbf = _p.dailyDisabledSportsByField; }
                    }
                }
                if (_dsbf) {
                    availableFields = availableFields.filter(fName => {
                        const _blk = _dsbf[fName];
                        const _hit = _blk && (Array.isArray(_blk)
                            ? _blk.includes(_spSport)
                            : (typeof _blk.has === 'function' && _blk.has(_spSport)));
                        if (_hit) {
                            console.log(`[SpecialtyLeagues] ⚠️ Sport "${_spSport}" disabled on court "${fName}" today — not offered to specialty league "${league.name}"`);
                            return false;
                        }
                        return true;
                    });
                }
            }
        } catch (_eSport) { /* fail open */ }

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
                waitScore: getWaitPriorityScore(m.teamA, m.teamB, history.slotDebt, id)
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
            waitScore: getWaitPriorityScore(m.teamA, m.teamB, history.slotDebt, id)
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

            if (!bestField) {
                // ★ Playoff: reserved fields (saved for teams that are out) are
                //   off-limits to the games' auto-pick; only an explicit
                //   user-chosen field (handled above) may land on one.
                const _resFieldSet = new Set(
                    (league && Array.isArray(league._playoffReservedNow))
                        ? league._playoffReservedNow.map(String) : []
                );
                let bestRot = -Infinity;
                for (const field of availableFields) {
                    if (_resFieldSet.has(field)) continue;
                    const currentGames = _effectiveGames(field);
                    const maxGames = gamesPerFieldSlot || 3;
                    if (currentGames >= maxGames) continue;   // court already full this period
                    const rotationScore = getFieldRotationScore(matchup.teamA, matchup.teamB, field, history.teamFieldRotation, availableFields, id);
                    // Primary: fewest games already on the court (balance court load).
                    // Secondary (★ LG-17 fix): among equally-loaded courts, pick the one
                    //   these two teams have played LEAST (highest rotation score), so teams
                    //   actually cycle through every court instead of sticking to a fixed few.
                    //   The old guard required currentGames < minGames STRICTLY, so the
                    //   rotation tie-break was unreachable and courts were chosen by array
                    //   order — leaving some teams never on certain courts.
                    if (currentGames < minGames || (currentGames === minGames && rotationScore > bestRot)) {
                        minGames = currentGames;
                        bestRot = rotationScore;
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
            // ★ Cumulative late-slot debt for season-long wait fairness (read by
            //   getWaitPriorityScore): how many periods each team waited this game.
            if (!history.slotDebt) history.slotDebt = {};
            const _wait = Math.max(0, (game.slotOrder || 1) - 1);
            history.slotDebt[keyA] = (history.slotDebt[keyA] || 0) + _wait;
            history.slotDebt[keyB] = (history.slotDebt[keyB] || 0) + _wait;

            const matchupKey = [game.teamA, game.teamB].sort().join('|');
            const fullKey = `${id}|${matchupKey}`;
            if (!history.matchupHistory[fullKey]) history.matchupHistory[fullKey] = [];
            history.matchupHistory[fullKey].push(currentDate);

            // ★ FN-55: record slotOrder (s) so rollbackDayRecords can subtract the
            //   exact late-slot wait this game contributed to the cumulative slotDebt —
            //   a regen / date-delete previously left slotDebt inflated forever.
            history.gameLog[id][currentDate].push({ tA: game.teamA, tB: game.teamB, field: game.field, g: gameLabel || null, s: game.slotOrder });
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
    // contributed. lastSlotOrder is overwrite-only and needs no rollback;
    // slotDebt is cumulative, so it IS rolled back here (FN-55) using the
    // per-game slotOrder now stored on each gameLog entry.

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
            // ★ FN-55: subtract this game's late-slot wait from the cumulative
            //   slotDebt (added in updateHistoryAfterScheduling). Older gameLog
            //   entries predate the `s` field → they added 0 wait then, so skip.
            if (history.slotDebt && e.s != null) {
                const w = Math.max(0, (e.s || 1) - 1);
                if (w > 0) {
                    [e.tA, e.tB].forEach(function (team) {
                        if (!team) return;
                        const k = `${leagueId}|${team}`;
                        if (history.slotDebt[k] != null) {
                            history.slotDebt[k] = Math.max(0, history.slotDebt[k] - w);
                        }
                    });
                }
            }
        });
        const n = entries.length;
        delete history.gameLog[leagueId][date];
        console.log(`[SpecialtyLeagues] ↩️ Rolled back ${n} logged game record(s) for league ${leagueId} on ${date}`);
        return n;
    }

    // =========================================================================
    // ★ LG-9: HISTORY ⇄ SAVED-SCHEDULE RECONCILIATION (specialty)
    // =========================================================================
    // Mirror of the regular engine's reconcileHistoryFromSchedules: rebuild
    // any (league, date) the gameLog has NO record of from the saved daily
    // schedules' leagueAssignments (specialty uiEntries store structured
    // matchups {teamA, teamB, field, slotOrder} under the league's NAME; the
    // history is keyed by the league's ID). Tombstone-aware; derived stores
    // (matchup date-arrays, field rotation, slotDebt) and per-date counters
    // are backfilled alongside; persisted + verified-pushed on change.
    // Killswitch: window.__leagueHistoryReconcile = false.
    function _spDailyDataGames(leagueName, date) {
        try {
            const all = (typeof window !== 'undefined' && window.loadAllDailyData) ? window.loadAllDailyData() : null;
            const la = all && all[date] && all[date].leagueAssignments;
            if (!la) return [];
            const out = [];
            const seen = new Set();
            Object.keys(la).forEach(function (dv) {
                const map = la[dv] || {};
                Object.keys(map).forEach(function (k) {
                    const g = map[k];
                    if (!g || (g.leagueName || '') !== leagueName) return;
                    (g.matchups || []).forEach(function (m) {
                        if (!m || typeof m !== 'object') return;
                        const a = m.teamA != null ? m.teamA : m.team1;
                        const b = m.teamB != null ? m.teamB : m.team2;
                        if (!a || !b || a === 'BYE' || b === 'BYE' || a === 'TBD' || b === 'TBD') return;
                        const key = (g.gameLabel || '') + '::' + [String(a), String(b)].sort().join('|');
                        if (seen.has(key)) return;
                        seen.add(key);
                        out.push({
                            tA: String(a), tB: String(b),
                            field: m.field || null,
                            g: g.gameLabel || null,
                            s: (m.slotOrder != null) ? m.slotOrder : null
                        });
                    });
                });
            });
            return out;
        } catch (_e) { return []; }
    }
    function reconcileHistoryFromSchedules(history, specialtyLeaguesConfig, skipDate) {
        if (typeof window !== 'undefined' && window.__leagueHistoryReconcile === false) return 0;
        let backfilled = 0;
        try {
            const leagues = Object.values(specialtyLeaguesConfig || {}).filter(function (l) { return l && l.id && l.name; });
            if (!leagues.length) return 0;
            const all = (typeof window !== 'undefined' && window.loadAllDailyData) ? window.loadAllDailyData() : null;
            if (!all) return 0;
            const dates = Object.keys(all).filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); }).sort();
            if (!dates.length) return 0;
            history.gameLog = history.gameLog || {};
            history.gamesPerDate = history.gamesPerDate || {};
            history.matchupHistory = history.matchupHistory || {};
            history.teamFieldRotation = history.teamFieldRotation || {};
            const tombs = history._tombstones || {};
            const resetAt = Number(history._resetAt) || 0;
            leagues.forEach(function (league) {
                const teamSet = new Set(league.teams || []);
                if (teamSet.size < 2) return;
                dates.forEach(function (d) {
                    if (d === skipDate) return;
                    if ((history.gameLog[league.id] || {})[d] && history.gameLog[league.id][d].length) return;
                    if ((tombs[`${league.id}|${d}`] || 0) > 0 || (tombs[`*|${d}`] || 0) > 0 || resetAt > 0) return;
                    const games = _spDailyDataGames(league.name, d)
                        .filter(function (g) { return teamSet.has(g.tA) && teamSet.has(g.tB); });
                    if (!games.length) return;
                    if (!history.gameLog[league.id]) history.gameLog[league.id] = {};
                    if (!history.gameLog[league.id][d]) history.gameLog[league.id][d] = [];
                    games.forEach(function (g) {
                        history.gameLog[league.id][d].push({ tA: g.tA, tB: g.tB, field: g.field, g: g.g, s: g.s });
                        const mk = `${league.id}|${[g.tA, g.tB].sort().join('|')}`;
                        (history.matchupHistory[mk] = history.matchupHistory[mk] || []).push(d);
                        if (g.field) {
                            [g.tA, g.tB].forEach(function (t) {
                                const fk = `${league.id}|${t}`;
                                (history.teamFieldRotation[fk] = history.teamFieldRotation[fk] || []).push(g.field);
                            });
                        }
                        if (g.s != null) {
                            const w = Math.max(0, (g.s || 1) - 1);
                            if (w > 0) {
                                if (!history.slotDebt) history.slotDebt = {};
                                [g.tA, g.tB].forEach(function (t) {
                                    const sk = `${league.id}|${t}`;
                                    history.slotDebt[sk] = (history.slotDebt[sk] || 0) + w;
                                });
                            }
                        }
                        backfilled++;
                    });
                    if (history.gamesPerDate[league.id]?.[d] === undefined) {
                        const labels = new Set(games.map(function (g) { return g.g; }).filter(Boolean));
                        if (!history.gamesPerDate[league.id]) history.gamesPerDate[league.id] = {};
                        history.gamesPerDate[league.id][d] = Math.max(labels.size, 1);
                    }
                    console.log(`[SpecialtyLeagues] 🩹 Reconstructed ${games.length} game(s) for "${league.name}" on ${d} from the saved schedule (history had no record)`);
                });
            });
            if (backfilled > 0) {
                console.warn(`[SpecialtyLeagues] 🩹 History reconciliation backfilled ${backfilled} game(s) from saved schedules`);
                saveSpecialtyHistory(history);
            }
        } catch (e) {
            console.warn('[SpecialtyLeagues] history reconciliation skipped:', e);
        }
        return backfilled;
    }
    SpecialtyLeagues.reconcileHistoryFromSchedules = function (specialtyLeaguesConfig) {
        const cfg = specialtyLeaguesConfig || loadSpecialtyLeagues();
        const history = loadSpecialtyHistory();
        return reconcileHistoryFromSchedules(history, cfg, null);
    };

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
        // ★ FN-14: prefer the authoritative gen-date over the global picker —
        //   the picker can transiently revert to the PREVIOUS date mid-gen,
        //   which keyed the day-reset + gameLog to the wrong day (see the
        //   matching note in processRegularLeagues). Local-date fallback:
        //   toISOString() is UTC and flips to tomorrow during evening sessions.
        const currentDate = window._activeGenDate || window.currentScheduleDate || new Date().toLocaleDateString('en-CA');
        console.log(`[SpecialtyLeagues] Current day: "${currentDate}"`);

        // ★ LG-9: rebuild gameLog days the history has NO record of from the
        // saved schedules before any decision reads it (see the function).
        reconcileHistoryFromSchedules(history, specialtyLeaguesConfig, currentDate);

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
                // ★ LG-8 tombstone: this generation REPLACES the league's day —
                // a stale copy's version must lose in any later merge (this
                // run's end-of-gen save is stamped after this, so its own
                // re-logged games survive).
                history._tombstones = history._tombstones || {};
                history._tombstones[`${l.id}|${currentDate}`] = Date.now();
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
            // LG-18: key is `${divName}_${startTime}` (built ~L906). Division
            // names can contain '_' (e.g. "Junior_Boys") but startTime never
            // does, so split on the LAST '_' — a plain split('_') truncated the
            // div name ("Junior_Boys" -> "Junior") and the league never resolved.
            const _ki = key.lastIndexOf('_');
            const divName = _ki >= 0 ? key.slice(0, _ki) : key;
            const startTime = _ki >= 0 ? key.slice(_ki + 1) : '';

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
            // ★ AUTOMATIC ROUND TRACKING: with playoff.startGameCount set
            //   (stamped by the Playoff Hub when playoffs are turned on), every
            //   league tile after that point plays the next round in sequence —
            //   tile #1 = Round 1, tile #2 = Round 2, … — derived from the same
            //   chronological game counter: round = gameNumber - startGameCount.
            //   Legacy playoffs without the anchor fall back to
            //   currentRound + todayGameIndex.
            let _playoffPreseason = false;   // playoff enabled, but this tile predates the start anchor
            league._playoffReservedNow = null;   // set below when a playoff round plays
            if (_PM_S && _PM_S.isLeagueInPlayoff(league)) {
                const _startCnt = league.playoff.startGameCount;
                const derivedRound = (typeof _startCnt === 'number')
                    ? (gameNumber - _startCnt)
                    : (league.playoff.currentRound + todayGameIndex);
                if (derivedRound < 1) {
                    console.log('[SpecialtyLeagues] 🏆 PLAYOFF: tile #' + gameNumber + ' predates the playoff start anchor (' + _startCnt + ') — regular league play');
                    _playoffPreseason = true;
                } else {
                    // ★ Rounds whose winners are already all marked never need a
                    //   tile (e.g. results entered by hand before the round's slot
                    //   ran). Walk forward to the first round that still needs
                    //   games — otherwise the tile would skip, never get counted,
                    //   and the tracker would point at the decided round forever.
                    let roundToPlay = derivedRound;
                    if (typeof _PM_S.getRoundByNumber === 'function') {
                        let _guard = 0;
                        while (_guard++ < 100) {
                            const _r = _PM_S.getRoundByNumber(league, roundToPlay);
                            if (_r && _PM_S.isRoundComplete(_r)) roundToPlay++;
                            else break;
                        }
                    }
                    const _reanchor = function () {
                        if (roundToPlay !== derivedRound && typeof _startCnt === 'number') {
                            league.playoff.startGameCount = gameNumber - roundToPlay;
                            console.log('[SpecialtyLeagues] 🏆 PLAYOFF: Round ' + derivedRound + (roundToPlay - derivedRound > 1 ? '–' + (roundToPlay - 1) : '') + ' already decided — tile #' + gameNumber + ' plays Round ' + roundToPlay + ' (anchor re-aligned to ' + league.playoff.startGameCount + ')');
                        }
                    };
                    // ★ The round's reserved fields are for the kids who are OUT —
                    //   the field assigner must not auto-pick them for games.
                    league._playoffReservedNow = _PM_S.getReservedForRound
                        ? _PM_S.getReservedForRound(league, roundToPlay) : null;
                    const userRound = (typeof _PM_S.getRoundByNumber === 'function')
                        ? _PM_S.getRoundByNumber(league, roundToPlay) : null;
                    const userRoundMatchups = (userRound && Array.isArray(userRound.matchups)) ? userRound.matchups : [];
                    const userActive = userRoundMatchups.filter(function (m) {
                        return m && m.teamA && m.teamB && m.teamA !== 'BYE' && m.teamB !== 'BYE' && !m.winner;
                    });
                    if (userActive.length > 0) {
                        _reanchor();
                        _playoffRoundNum = roundToPlay;
                        matchups = userActive.map(function (m) {
                            return {
                                teamA: m.teamA,
                                teamB: m.teamB,
                                conference: null,
                                isInterConference: false,
                                _playoffSport: m.sport || null,
                                _playoffField: m.field || null
                            };
                        });
                        // Keep the hub's display cache in sync with the tracked round
                        league.playoff.currentRound = roundToPlay;
                        console.log('[SpecialtyLeagues] 🏆 PLAYOFF Round ' + roundToPlay + ' (tile #' + gameNumber + '): ' + userActive.length + ' matchup(s)');
                    } else if (!userRound && _PM_S.getChampion && _PM_S.getChampion(league)) {
                        console.log('[SpecialtyLeagues] 🏆 PLAYOFF: tournament decided (champion: ' + _PM_S.getChampion(league) + ') and no Round ' + roundToPlay + ' exists — skipping');
                        continue;
                    } else {
                        // Round not built yet, or built but teams not filled in —
                        // reserve the slot with TBD placeholders sized from the
                        // user's round (or half the previous round).
                        _reanchor();
                        const prevRound = (typeof _PM_S.getRoundByNumber === 'function')
                            ? _PM_S.getRoundByNumber(league, roundToPlay - 1) : null;
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
                        const fallbackSport = league.sport || null;
                        _playoffRoundNum = roundToPlay;
                        _playoffIsTBD = true;
                        matchups = [];
                        for (let k = 0; k < tbdCount; k++) {
                            const um = userRoundMatchups[k];
                            matchups.push({
                                teamA: 'TBD',
                                teamB: 'TBD',
                                conference: null,
                                isInterConference: false,
                                _playoffSport: (um && um.sport)
                                    || (sportsPool.length ? sportsPool[k % sportsPool.length] : fallbackSport),
                                _playoffField: (um && um.field) || null,
                                _playoffTBD: true,
                                // ★ FN-9: unique per-placeholder id so the field-assignment
                                //   dedup doesn't collapse every "TBD-TBD" matchup into one
                                //   (which reserved only a SINGLE field for a multi-matchup
                                //   undecided round, starving the others).
                                _tbdIndex: k
                            });
                        }
                        console.log('[SpecialtyLeagues] 🏆 PLAYOFF Round ' + roundToPlay + ' TBD: ' + tbdCount + ' placeholder matchup(s)'
                            + (userRound ? ' (round built, teams not filled in yet)' : ' (round not built yet — add it in the Playoff Hub)'));
                    }
                }
            }
            if (!(_PM_S && _PM_S.isLeagueInPlayoff(league)) || _playoffPreseason) {
                matchups = getLeagueMatchupsForToday(league, history, gameNumber);
            }

            if (matchups.length === 0) {
                console.log(`[SpecialtyLeagues] No matchups generated`);
                continue;
            }

            console.log(`[SpecialtyLeagues] Game #${gameNumber} - Generated ${matchups.length} matchups`);
            matchups.forEach(m => console.log(`   • ${m.teamA} vs ${m.teamB} (${m.conference || 'No Conference'})`));

            // ★★★ ASSIGN MATCHUPS - RESPECTING GLOBAL LOCKS ★★★
            const assignments = assignMatchupsToFieldsAndSlots(matchups, league, history, uniqueSlots, divName);

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

            // ★ Playoff court shortage: the round asked for more games than the
            //   league's courts could hold this period — say WHICH matchups got
            //   dropped instead of losing them silently (the validator's
            //   playoff-field-shortage check reports the same thing post-gen).
            if (_playoffRoundNum && !_playoffIsTBD && assignments.length < matchups.length) {
                const _placedPairs = new Set(assignments.map(a => a.teamA + '|' + a.teamB));
                matchups
                    .filter(m => !_placedPairs.has(m.teamA + '|' + m.teamB) && !_placedPairs.has(m.teamB + '|' + m.teamA))
                    .forEach(m => console.warn('[SpecialtyLeagues] 🚨 PLAYOFF R' + _playoffRoundNum + ' ('
                        + league.name + '): ' + m.teamA + ' vs ' + m.teamB + ' did not get a court — '
                        + matchups.length + ' games scheduled but the league\'s ' + ((league.fields || []).length)
                        + ' court(s) hold at most ' + (((league.fields || []).length) * (league.gamesPerFieldSlot || 3))
                        + ' simultaneous games. The matchup was dropped from the schedule.'));
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
// Per-round list — later rounds usually reserve more fields as more teams
// are knocked out (legacy league-wide list as fallback).
if (_playoffRoundNum) {
    const _roundReserved = _PM_S.getReservedForRound
        ? _PM_S.getReservedForRound(league, _playoffRoundNum)
        : ((league.playoff && league.playoff.reservedActivities) || []);
    if (_roundReserved.length > 0) {
        const reservedReason = `Playoff reserve (${league.name} R${_playoffRoundNum}` + (_playoffIsTBD ? ' TBD)' : ')');
        // ★ ONE division lock per field allowing ALL the league's divisions
        //   (comma list — GlobalFieldLocks.divisionAllowed). Per-division calls
        //   overwrote each other across processing passes, leaving only the
        //   last division allowed. Explicit time window for cross-grade checks.
        const _resDivs = (Array.isArray(league.divisions) && league.divisions.length > 0)
            ? league.divisions.join(', ') : divName;
        _roundReserved.forEach(function (act) {
            try {
                window.GlobalFieldLocks.lockFieldForDivision(act, uniqueSlots, _resDivs, reservedReason,
                    (_specLockStart != null ? { startMin: _specLockStart, endMin: _specLockEnd } : undefined));
            } catch (e) {
                console.warn('[PLAYOFF specialty] failed to reserve "' + act + '" for ' + _resDivs + ':', e);
            }
        });
        console.log('[SpecialtyLeagues] 🎯 PLAYOFF R' + _playoffRoundNum + ': reserved [' + _roundReserved.join(', ') + '] for ' + _resDivs);
    }
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

            // Build matchup display strings. For playoff rounds, list the
            // round's user-marked byes underneath the games ("Team — Bye":
            // sitting out this round, still in the playoffs), then the round's
            // reserved fields as "Electives" — where the teams that are out go
            // during this period. Eliminated (knocked-out) teams themselves are
            // never listed.
            let matchupStrings = assignments.map(a =>
                `${a.teamA} vs ${a.teamB} — ${a.field}`
            );
            if (_playoffRoundNum) {
                const _dispRound = _PM_S.getRoundByNumber ? _PM_S.getRoundByNumber(league, _playoffRoundNum) : null;
                const _playingTeams = new Set();
                assignments.forEach(a => { if (a.teamA) _playingTeams.add(a.teamA); if (a.teamB) _playingTeams.add(a.teamB); });
                const _byeRows = ((_dispRound && _dispRound.byes) || [])
                    .filter(t => !_playingTeams.has(t))
                    .map(t => `${t} — Bye`);
                matchupStrings = matchupStrings.concat(_byeRows);
                const _dispReserved = (_PM_S.getReservedForRound
                    ? _PM_S.getReservedForRound(league, _playoffRoundNum)
                    : ((league.playoff && league.playoff.reservedActivities) || []));
                if (_dispReserved.length > 0) {
                    matchupStrings = matchupStrings.concat(
                        ['Electives:'],
                        _dispReserved.map(f => `  • ${f}`)
                    );
                }
            }

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

            // ★ LG-32: never record playoff TBD placeholders ('TBD vs TBD',
            //   teamA/teamB='TBD') into history — they would pollute
            //   teamFieldRotation['id|TBD'] / slotDebt['id|TBD'] /
            //   matchupHistory['id|TBD|TBD'] / gameLog, and the FN-58 sync below
            //   (which reads gameLog) would then auto-save a bogus 'TBD vs TBD'
            //   result game. The regular engine likewise skips recording for TBD.
            //   A real game in another slot/division this day still records normally.
            if (!_playoffIsTBD) {
                updateHistoryAfterScheduling(league, assignments, history, currentDate, gameLabel);
            }

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
        // ★ FN-14: same date-authority order as the engine entry point above.
        const currentDate = window._activeGenDate || window.currentScheduleDate || new Date().toLocaleDateString('en-CA');
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

            // ★ LG-8 tombstone: the whole date was deleted (all leagues) —
            // stamped even when nothing existed locally, because a divergent
            // copy on another device may still carry games for this date.
            history._tombstones = history._tombstones || {};
            history._tombstones[`*|${dateKey}`] = Date.now();
            changed = true;

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
                // ★ LG-8 tombstone: deliberate per-league day reset — a stale
                // copy must not resurrect it in a merge; a later regen (saved
                // after this stamp) survives.
                history._tombstones = history._tombstones || {};
                history._tombstones[`${l.id}|${dateKey}`] = Date.now();
                changed = true;
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

            // ★ LG-8: mark the wipe so merges don't resurrect counters from a
            // stale copy or heal them back from the retained gameLog —
            // erase-all restarts game numbering by design.
            history._countersResetAt = Date.now();

            saveSpecialtyHistory(history);
            console.log('[SpecialtyLeagues] 🗑️ Cleared all gamesPerDate entries (all schedules deleted)');
        } catch (e) {
            console.error('[SpecialtyLeagues] clearAllGamesPerDate error:', e);
        }
    };

    // Read-only history snapshot for UI consumers (league_play_report.js) so
    // they get the same cloud-first resolution the engine uses.
    SpecialtyLeagues.getHistorySnapshot = function () {
        return loadSpecialtyHistory();
    };

    window.SchedulerCoreSpecialtyLeagues = SpecialtyLeagues;

    if (window.SchedulerCoreLeagues) {
        window.SchedulerCoreLeagues.processSpecialtyLeagues = SpecialtyLeagues.processSpecialtyLeagues;
    }

    console.log('[SpecialtyLeagues] Module loaded with Chronological Date Ordering + Cloud Persistence v3');
})();
