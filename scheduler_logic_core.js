// -------------------- scheduler_logic_core.js --------------------
// REFACTORED FOR "MATRIX" (Per-Division Period Times)
// - Generates a 30-minute grid based on the "earliest" and "latest"
//   time found across ALL divisions' custom period settings.
// - divisionActiveRows mask is built from each division's *specific*
//   start/end times for each period.
// - spanLen is now dynamic per-division, per-period.
// -----------------------------------------------------------------

// ===== CONFIG =====
const INCREMENT_MINS = 30;
const LEAGUE_DURATION_MINS = 30; 

// ===== Helpers =====
function parseTimeToMinutes(str) {
    if (!str || typeof str !== "string") return null;
    let s = str.trim().toLowerCase();
    let mer = null;
    if (s.endsWith("am") || s.endsWith("pm")) {
        mer = s.endsWith("am") ? "am" : "pm";
        s = s.replace(/am|pm/g, "").trim();
    }
    const m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
    if (!m) return null;
    let hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (Number.isNaN(hh) || Number.isNaN(mm) || mm < 0 || mm > 59) return null;
    if (mer) {
        if (hh === 12) hh = mer === "am" ? 0 : 12; // 12am -> 0, 12pm -> 12
        else if (mer === "pm") hh += 12; // 1pm -> 13
    }
    return hh * 60 + mm;
}
function fieldLabel(f) {
    if (typeof f === "string") return f;
    if (f && typeof f === "object" && typeof f.name === "string") return f.name;
    return "";
}
function getActivityName(pick) {
    if (pick.sport) return pick.sport; // e.g., "Basketball"
    return fieldLabel(pick.field); // e.g., "Gameroom"
}

// ----- FIX: ADDED fmtTime HELPER -----
function fmtTime(d) {
    if (!d) return "";
    let h = d.getHours(), m = d.getMinutes().toString().padStart(2,"0"), ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
    return `${h}:${m} ${ap}`;
}

// ===== NEW: Period/Time Generation Helpers (Matrix Logic) =====

function generateUnifiedTimesAndMasks() {
    const periods = window.schedulePeriods || [];
    const divisions = window.divisions || {};
    const availableDivisions = window.availableDivisions || [];
    
    if (periods.length === 0) {
        console.warn("No Schedule Period Names found.");
        window.unifiedTimes = [];
        window.divisionActiveRows = {};
        return;
    }

    // 1. Find the full time range of the day
    let earliestMin = Infinity;
    let latestMin = -Infinity;
    
    availableDivisions.forEach(divName => {
        const rules = divisions[divName]?.periodRules || {};
        for (const periodId in rules) {
            const rule = rules[periodId];
            const start = parseTimeToMinutes(rule.start);
            const end = parseTimeToMinutes(rule.end);
            if (start != null) earliestMin = Math.min(earliestMin, start);
            if (end != null) latestMin = Math.max(latestMin, end);
        }
    });

    if (earliestMin === Infinity) {
        console.warn("No period times set for any division.");
        window.unifiedTimes = [];
        window.divisionActiveRows = {};
        return;
    }

    // 2. Generate unifiedTimes grid
    window.unifiedTimes = [];
    const baseDate = new Date(1970, 0, 1, 0, 0, 0); 
    
    let currentMin = earliestMin;
    while (currentMin < latestMin) {
        const nextMin = currentMin + INCREMENT_MINS;
        const startDate = new Date(baseDate.getTime() + currentMin * 60000);
        const endDate = new Date(baseDate.getTime() + nextMin * 60000);
        window.unifiedTimes.push({ 
            start: startDate, 
            end: endDate, 
            label: `${fmtTime(startDate)} - ${fmtTime(endDate)}` // This line needs fmtTime
        });
        currentMin = nextMin;
    }
    
    // 3. Generate divisionActiveRows (the "mask")
    window.divisionActiveRows = {};
    availableDivisions.forEach(divName => {
        const activeRows = new Set();
        const div = divisions[divName];
        if (!div) return;
        const rules = div.periodRules || {};

        for (const periodId in rules) {
            const rule = rules[periodId];
            const periodStartMin = parseTimeToMinutes(rule.start);
            const periodEndMin = parseTimeToMinutes(rule.end);
            if (periodStartMin == null || periodEndMin == null) continue;

            window.unifiedTimes.forEach((timeSlot, index) => {
                const slotStartMin = timeSlot.start.getHours() * 60 + timeSlot.start.getMinutes();
                if (slotStartMin >= periodStartMin && slotStartMin < periodEndMin) {
                    activeRows.add(index);
                }
            });
        }
        window.divisionActiveRows[divName] = activeRows;
    });
}

function buildSpanLenMaps() {
    const divisionSpanLens = {};
    const periods = window.schedulePeriods || [];
    const divisions = window.divisions || {};
    const availableDivisions = window.availableDivisions || [];
    const unifiedTimes = window.unifiedTimes || [];
    
    if (unifiedTimes.length === 0) return { divisionSpanLens };

    availableDivisions.forEach(divName => {
        const div = divisions[divName];
        if (!div) return;

        divisionSpanLens[divName] = {}; // { periodId: spanLen }
        const rules = div.periodRules || {};

        for (const periodId in rules) {
            const rule = rules[periodId];
            const startMin = parseTimeToMinutes(rule.start);
            const endMin = parseTimeToMinutes(rule.end);
            const numActivities = parseInt(rule.rule, 10) || 1;
            
            if (startMin == null || endMin == null) continue;

            const totalDuration = endMin - startMin;
            const totalSlots = Math.floor(totalDuration / INCREMENT_MINS);
            
            const spanLen = Math.max(1, Math.floor(totalSlots / numActivities));
            
            divisionSpanLens[divName][periodId] = spanLen;
        }
    });

    return { divisionSpanLens };
}

function getPeriodForSlot(slotIndex, divisionName) {
    const periods = window.schedulePeriods || [];
    const unifiedTimes = window.unifiedTimes || [];
    const div = window.divisions?.[divisionName];
    
    if (!unifiedTimes[slotIndex] || !div) return null;

    const slotStartMin = unifiedTimes[slotIndex].start.getHours() * 60 + unifiedTimes[slotIndex].start.getMinutes();
    const rules = div.periodRules || {};

    for (const periodId in rules) {
        const rule = rules[periodId];
        const periodStartMin = parseTimeToMinutes(rule.start);
        const periodEndMin = parseTimeToMinutes(rule.end);
        
        if (slotStartMin >= periodStartMin && slotStartMin < periodEndMin) {
            // Find the original period name
            const period = periods.find(p => p.id === periodId);
            return period;
        }
    }
    return null;
}

// ===== Fixed Activities =====
function loadActiveFixedActivities() {
    // This functionality is now handled by the period system
    // but we leave the function here in case daily_overrides calls it.
    // A better approach would be to remove this and update daily_overrides.
    // For now, return empty.
    return [];
}

function findRowsForRange(startStr, endStr) {
    if (!Array.isArray(window.unifiedTimes) || window.unifiedTimes.length === 0) return [];
    const startMin = parseTimeToMinutes(startStr), endMin = parseTimeToMinutes(endStr);
    if (startMin == null || endMin == null || endMin <= startMin) return [];
    
    const inside = [];
    for (let i = 0; i < window.unifiedTimes.length; i++) {
        const r = window.unifiedTimes[i];
        const rs = r.start.getHours() * 60 + r.start.getMinutes();
        const re = r.end.getHours() * 60 + r.end.getMinutes();
        if (rs >= startMin && re <= endMin) inside.push(i);
    }
    // Fallback to overlap if no perfect fit
    if (inside.length === 0) {
        const overlap = [];
        for (let i = 0; i < window.unifiedTimes.length; i++) {
            const r = window.unifiedTimes[i];
            const rs = r.start.getHours() * 60 + r.start.getMinutes();
            const re = r.end.getHours() * 60 + r.end.getMinutes();
            if (Math.max(rs, startMin) < Math.min(re, endMin)) overlap.push(i);
        }
        return overlap;
    }
    return inside;
}

function computeBlockedRowsByDiv() {
    // This functionality is now handled by the period system
    // and the `divisionActiveRows` mask.
    return {};
}

function prePlaceFixedActivities() {
    // This is now handled by the "Matrix" system.
    // We still check for "Trips" from daily_overrides,
    // as they are a special type of "fixed" activity.
    if (window.DailyOverrides?.prePlaceTrips) {
        try { 
            window.DailyOverrides.prePlaceTrips(); 
        } catch (e) { 
            console.error("DailyOverrides.prePlaceTrips error:", e); 
        }
    }
    // Return empty, as main fixed activities are part of the div mask
    return {};
}

// ===== League Helpers =====
function leaguesSnapshot() { return window.loadGlobalSettings?.().leaguesByName || {}; }

function getEnabledLeaguesByDivision(masterLeagues, overrides) {
    const result = {};
    const all = masterLeagues || {};
    Object.keys(all).forEach((name) => {
        if (overrides.leagues.includes(name)) return; 
        const l = all[name];
        if (!l?.enabled) return;
        (l.divisions || []).forEach((div) => { result[div] = { name, data: l }; });
    });
    return result;
}

// ===== League Sport Rotation =====
let leagueSportRotation = {};
function loadLeagueSportRotation() {
    try {
        if (window.currentDailyData && window.currentDailyData.leagueSportRotation && Object.keys(window.currentDailyData.leagueSportRotation).length > 0) {
            leagueSportRotation = window.currentDailyData.leagueSportRotation;
        } else if (window.loadPreviousDailyData) {
            const yesterdayData = window.loadPreviousDailyData();
            leagueSportRotation = yesterdayData.leagueSportRotation || {};
            saveLeagueSportRotation();
        } else {
            leagueSportRotation = {};
        }
    } catch(e) {
        console.error("Failed to load league sport rotation:", e);
        leagueSportRotation = {};
    }
}
function saveLeagueSportRotation() {
    try { window.saveCurrentDailyData?.("leagueSportRotation", leagueSportRotation); } catch(e) {
        console.error("Failed to save league sport rotation:", e);
    }
}

function assignSportsToMatchups(leagueName, matchups, sportsList, yesterdayHistory) {
    if (!Array.isArray(matchups) || matchups.length === 0) return [];
    if (!Array.isArray(sportsList) || sportsList.length === 0) return matchups.map((m) => ({ teams: m, sport: "Leagues" }));
    loadLeagueSportRotation();
    const state = leagueSportRotation[leagueName] || { index: 0 };
    let idx = state.index;
    const assigned = [];
    for (const match of matchups) {
        const [teamA, teamB] = match;
        const lastSportA = yesterdayHistory[teamA];
        const lastSportB = yesterdayHistory[teamB];
        let chosenSport = null;
        for (let i = 0; i < sportsList.length; i++) {
            const sportIdx = (idx + i) % sportsList.length; 
            const sport = sportsList[sportIdx];
            if (sport !== lastSportA && sport !== lastSportB) { chosenSport = sport; idx = sportIdx + 1; break; }
        }
        if (!chosenSport) { chosenSport = sportsList[idx % sportsList.length]; idx++; }
        assigned.push({ teams: match, sport: chosenSport });
    }
    leagueSportRotation[leagueName] = { index: idx % sportsList.length };
    saveLeagueSportRotation();
    return assigned;
}

// ====== CORE ASSIGN ======
window.leagueAssignments = window.leagueAssignments || {};
const H2H_PROB = 0.6; // 60% attempt per bunk/slot

function assignFieldsToBunks() {
    window.scheduleAssignments = window.scheduleAssignments || {};
    window.leagueAssignments = {};

    // ===== 1. LOAD MASTER & OVERRIDE DATA =====
    const globalSettings = window.loadGlobalSettings?.() || {};
    const app1Data = globalSettings.app1 || {};
    const masterFields = app1Data.fields || [];
    const masterDivisions = app1Data.divisions || {};
    const masterAvailableDivs = app1Data.availableDivisions || [];
    const masterSpecials = app1Data.specialActivities || [];
    const masterLeagues = globalSettings.leaguesByName || {};
    const dailyData = window.loadCurrentDailyData?.() || {};

    const loadedOverrides = dailyData.overrides || {};
    const overrides = {
        fields: loadedOverrides.fields || [],
        bunks: loadedOverrides.bunks || [],
        leagues: loadedOverrides.leagues || []
    };

    const yesterdayData = window.loadPreviousDailyData?.() || {};
    const yesterdayLeagues = yesterdayData.leagueAssignments || {};
    const yesterdaySchedule = yesterdayData.scheduleAssignments || {};

    // ===== 2. FILTER DATA BASED ON OVERRIDES =====
    const availFields = masterFields.filter(f => f.available && !overrides.fields.includes(f.name));
    const availSpecials = masterSpecials.filter(s => s.available && !overrides.fields.includes(s.name));
    const availableDivisions = masterAvailableDivs.filter(divName => !overrides.bunks.includes(divName));

    const divisions = {};
    for (const divName of availableDivisions) {
        if (!masterDivisions[divName]) continue;
        divisions[divName] = JSON.parse(JSON.stringify(masterDivisions[divName]));
        divisions[divName].bunks = (divisions[divName].bunks || []).filter(bunkName => !overrides.bunks.includes(bunkName));
    }
    // RE-PUBLISH GLOBALS (filtered)
    window.availableDivisions = availableDivisions;
    window.divisions = divisions;

    // Build bunk -> division map
    window.bunkToDivision = {};
    availableDivisions.forEach(dv => { (divisions[dv]?.bunks || []).forEach(bk => window.bunkToDivision[bk] = dv); });

    // Build activity properties map
    const activityProperties = {};
    availFields.forEach(f => {
        activityProperties[f.name] = {
            sharable: f.sharableWith?.type === 'all' || f.sharableWith?.type === 'custom',
            allowedDivisions: (f.sharableWith?.divisions?.length > 0) ? f.sharableWith.divisions : availableDivisions,
            limitUsage: f.limitUsage
        };
    });
    availSpecials.forEach(s => {
        activityProperties[s.name] = {
            sharable: s.sharableWith?.type === 'all' || s.sharableWith?.type === 'custom',
            allowedDivisions: (s.sharableWith?.divisions?.length > 0) ? s.sharableWith.divisions : availableDivisions,
            limitUsage: s.limitUsage
        };
    });

    const enabledByDiv = getEnabledLeaguesByDivision(masterLeagues, overrides);

    // ===== 3. NEW: GENERATE TIME GRID & RULES =====
    generateUnifiedTimesAndMasks();
    
    if (!window.unifiedTimes || window.unifiedTimes.length === 0) {
        console.warn("Cannot assign fields: No unified times were generated.");
        updateTable();
        return;
    }
    
    const { divisionSpanLens } = buildSpanLenMaps();
    const leagueSpanLen = Math.max(1, Math.ceil(LEAGUE_DURATION_MINS / INCREMENT_MINS));

    // Field-Sport Inventory
    const fieldsBySport = {}; window._lastFieldsBySportCache = fieldsBySport;
    const allFieldNames = [];
    availFields.forEach(f => {
        allFieldNames.push(f.name);
        if (Array.isArray(f.activities)) {
            f.activities.forEach(sport => {
                fieldsBySport[sport] = fieldsBySport[sport] || [];
                fieldsBySport[sport].push(f.name);
            });
        }
    });
    // Global list of schedulable names (fields + specials)
    window.allSchedulableNames = allFieldNames.concat(availSpecials.map(s => s.name));

    const allActivities = [
        ...availFields.flatMap((f) => (f.activities || []).map((act) => ({ type: "field", field: f, sport: act }))),
        ...availSpecials.map((sa) => ({ type: "special", field: sa, sport: null }))
    ];
    const h2hActivities = allActivities.filter(a => a.type === 'field' && a.sport);

    if (allActivities.length === 0) {
        console.warn("Cannot assign fields: No activities found.");
        updateTable();
        return;
    }

    // ===== 4. INIT GRIDS, HISTORIES, AND FIXED ACTIVITIES =====
    scheduleAssignments = {};
    availableDivisions.forEach((d) => (divisions[d]?.bunks || []).forEach((b) => (scheduleAssignments[b] = new Array(window.unifiedTimes.length))));
    window.scheduleAssignments = scheduleAssignments;

    // Pre-place fixed activities (like Trips)
    prePlaceFixedActivities();

    // fieldUsageBySlot = { slot: { FieldName: usageCount } }
    const fieldUsageBySlot = {};
    (availableDivisions || []).forEach(div => {
        (divisions[div]?.bunks || []).forEach(bunk => {
            if (scheduleAssignments[bunk]) {
                scheduleAssignments[bunk].forEach((entry, slot) => {
                    if (entry && entry._fixed && entry.field) {
                        const fieldName = fieldLabel(entry.field);
                        if (window.allSchedulableNames.includes(fieldName)) {
                            fieldUsageBySlot[slot] = fieldUsageBySlot[slot] || {};
                            fieldUsageBySlot[slot][fieldName] = 2; // Fixed activities get exclusive lock
                        }
                    }
                });
            }
        });
    });

    // Histories
    const generalActivityHistory = {}; // { bunk: Set(activityName) }
    const generalFieldHistory = {};    // { bunk: { activityName: fieldName } }
    const h2hHistory = {};             // { bunk: { otherBunk: count } }
    const h2hGameCount = {};           // { bunk: number }

    // Seed with yesterday
    availableDivisions.forEach(div => {
        (divisions[div]?.bunks || []).forEach(b => {
            generalActivityHistory[b] = new Set();
            generalFieldHistory[b] = {};
            h2hHistory[b] = {};
            h2hGameCount[b] = 0;
            const yBunkSchedule = yesterdaySchedule[b] || [];
            yBunkSchedule.forEach(entry => {
                if (entry && !entry._fixed && !entry._h2h) {
                    const actName = entry.sport || fieldLabel(entry.field);
                    generalActivityHistory[b].add(actName);
                    generalFieldHistory[b][actName] = fieldLabel(entry.field);
                }
            });
        });
    });
    // Mark today's fixed into history
    availableDivisions.forEach(div => {
        (divisions[div]?.bunks || []).forEach(bunk => {
            if (scheduleAssignments[bunk]) {
                scheduleAssignments[bunk].forEach((entry) => { if (entry && entry._fixed) generalActivityHistory[bunk].add(fieldLabel(entry.field)); });
            }
        });
    });

    // Yesterday's team sport map for leagues
    const leagueTeamSportHistory = {};
    Object.values(yesterdayLeagues).forEach(div => {
        Object.values(div).forEach(slot => {
            if (slot && slot.games && !slot.isContinuation) {
                slot.games.forEach(game => {
                    if (game.teams && game.teams.length >= 2) {
                        leagueTeamSportHistory[game.teams[0]] = game.sport;
                        leagueTeamSportHistory[game.teams[1]] = game.sport;
                    }
                });
            }
        });
    });

    const takenLeagueSlots = new Set();

    // ===== 5. LEAGUES FIRST (uses fixed leagueSpanLen) =====
    function evictAssignmentsOnFields(slotStart, span, targetFields, fus) {
        const unified = window.unifiedTimes || [];
        const endSlot = Math.min(slotStart + span, unified.length);
        for (let slot = slotStart; slot < endSlot; slot++) {
            for (const dv of (window.availableDivisions || [])) {
                const bunks = (window.divisions?.[dv]?.bunks) || [];
                for (const b of bunks) {
                    const e = window.scheduleAssignments?.[b]?.[slot];
                    if (!e || e._fixed || e._h2h) continue;
                    const f = fieldLabel(e.field);
                    if (!f || !targetFields.has(f)) continue;
                    // walk to start of its span
                    let k = slot;
                    while (k > 0 && window.scheduleAssignments[b][k-1] && window.scheduleAssignments[b][k-1].continuation) k--;
                    // clear forward
                    while (k < unified.length && window.scheduleAssignments[b][k] && (k===slot || window.scheduleAssignments[b][k].continuation)) {
                        const rem = window.scheduleAssignments[b][k];
                        const rf = fieldLabel(rem.field);
                        window.scheduleAssignments[b][k] = undefined;
                        if (rf) {
                            fus[k] = fus[k] || {};
                            fus[k][rf] = Math.max(0, (fus[k][rf] || 1) - 1);
                        }
                        k++;
                    }
                }
            }
        }
    }

    for (const div of availableDivisions) {
        const lg = enabledByDiv[div];
        if (!lg) continue;

        const actSet = window.divisionActiveRows?.[div];
        const actSlots = actSet && actSet.size ? Array.from(actSet) : window.unifiedTimes.map((_, i) => i);

        const bunksInDiv = divisions[div]?.bunks || [];

        const candidates = actSlots.filter((s) => {
            for (let k = 0; k < leagueSpanLen; k++) {
                const slot = s + k;
                if (slot >= window.unifiedTimes.length) return false;
                let busy = false;
                for (const bunk of bunksInDiv) { if (scheduleAssignments[bunk]?.[slot]) { busy = true; break; } }
                if (busy) return false;
                if (takenLeagueSlots.has(slot)) return false;
            }
            return true;
        });

        if (!candidates.length) continue;

        let placedLeague = false;
        // try each candidate slot without eviction first
        for (const chosenSlot of candidates) {
            const teams = (lg.data.teams || []).map((t) => String(t).trim()).filter(Boolean);
            if (teams.length < 2) break;
            const matchups = window.getLeagueMatchups?.(lg.name, teams) || [];
            if (!matchups.length) break;
            const gamesWithSports = assignSportsToMatchups(lg.name, matchups, lg.data.sports, leagueTeamSportHistory);

            const availableFieldsForSpan = {};
            allFieldNames.forEach(name => {
                let capacity = 1;
                for (let k = 0; k < leagueSpanLen; k++) { const slot = chosenSlot + k; const usage = fieldUsageBySlot[slot]?.[name] || 0; if (usage > 0) { capacity = 0; break; } }
                availableFieldsForSpan[name] = capacity;
            });

            const gamesWithPossibleFields = gamesWithSports.map(game => {
                const possibleFields = (fieldsBySport[game.sport] || []).filter(fieldName => (availableFieldsForSpan[fieldName] || 0) > 0);
                return { game, possibleFields };
            }).sort((a, b) => a.possibleFields.length - b.possibleFields.length);

            const tempReservedFields = {};
            let allGamesCanBeScheduled = true;
            const gamesWithFields = gamesWithPossibleFields.map(item => {
                const { game, possibleFields } = item;
                let assignedField = null; 
                for (const fieldName of possibleFields) {
                    if ((availableFieldsForSpan[fieldName] || 0) > 0 && !tempReservedFields[fieldName]) { assignedField = fieldName; tempReservedFields[fieldName] = 1; break; }
                }
                if (!assignedField) allGamesCanBeScheduled = false;
                return { ...game, field: assignedField };
            });

            if (!allGamesCanBeScheduled) continue; // try next candidate

            // book
            window.leagueAssignments[div] = window.leagueAssignments[div] || {};
            const leagueData = { games: gamesWithFields, leagueName: lg.name, isContinuation: false };
            const leagueContinuation = { leagueName: lg.name, isContinuation: true };
            for (let k = 0; k < leagueSpanLen; k++) {
                const slot = chosenSlot + k; if (slot >= window.unifiedTimes.length) break;
                window.leagueAssignments[div][slot] = (k === 0) ? leagueData : leagueContinuation;
                takenLeagueSlots.add(slot);
                gamesWithFields.forEach(game => { if (game.field) { fieldUsageBySlot[slot] = fieldUsageBySlot[slot] || {}; fieldUsageBySlot[slot][game.field] = 2; } });
            }
            placedLeague = true; break;
        }

        // eviction-based rescue
        if (!placedLeague) {
            for (const chosenSlot of candidates) {
                const teams = (lg.data.teams || []).map((t) => String(t).trim()).filter(Boolean);
                if (teams.length < 2) break;
                const matchups = window.getLeagueMatchups?.(lg.name, teams) || [];
                if (!matchups.length) break;
                const gamesWithSports = assignSportsToMatchups(lg.name, matchups, lg.data.sports, leagueTeamSportHistory);
                const candidateFields = new Set();
                gamesWithSports.forEach(g => (fieldsBySport[g.sport] || []).forEach(f => candidateFields.add(f)));
                evictAssignmentsOnFields(chosenSlot, leagueSpanLen, candidateFields, fieldUsageBySlot);
                const avail = {}; allFieldNames.forEach(name => { let cap = 1; for (let k = 0; k < leagueSpanLen; k++) { const slot = chosenSlot + k; if ((fieldUsageBySlot[slot]?.[name] || 0) > 0) { cap = 0; break; } } avail[name] = cap; });
                const temp = {}; const finalGames = [];
                const byHardness = gamesWithSports.map(g => ({ g, poss: (fieldsBySport[g.sport] || []).filter(fn => (avail[fn] || 0) > 0) }))
                    .sort((a,b)=> a.poss.length - b.poss.length);
                let ok = true;
                for (const item of byHardness) {
                    let chosen = null; for (const f of item.poss) { if (!temp[f]) { chosen = f; temp[f]=1; break; } }
                    if (!chosen) { ok = false; break; }
                    finalGames.push({ teams: item.g.teams, sport: item.g.sport, field: chosen });
                }
                if (ok) {
                    window.leagueAssignments[div] = window.leagueAssignments[div] || {};
                    const leagueData = { games: finalGames, leagueName: lg.name, isContinuation: false };
                    const leagueContinuation = { leagueName: lg.name, isContinuation: true };
                    for (let k = 0; k < leagueSpanLen; k++) {
                        const slot = chosenSlot + k; if (slot >= window.unifiedTimes.length) break;
                        window.leagueAssignments[div][slot] = (k === 0) ? leagueData : leagueContinuation;
                        takenLeagueSlots.add(slot);
                        finalGames.forEach(game => { fieldUsageBySlot[slot] = fieldUsageBySlot[slot] || {}; fieldUsageBySlot[slot][game.field] = 2; });
                    }
                    placedLeague = true; break;
                }
            }
            if (!placedLeague) console.warn(`Skipping league "${lg.name}": Not enough fields across candidate slots (even after eviction).`);
        }
    }

    // =============================================================
    // ===== 6. SCHEDULE GENERAL/H2H (NEW DYNAMIC SPAN LOGIC) =====
    // =============================================================
    for (const div of availableDivisions) {
        const isActive = (s) => window.divisionActiveRows?.[div]?.has(s) ?? false;
        const allBunksInDiv = divisions[div]?.bunks || [];

        for (const bunk of allBunksInDiv) {
            for (let s = 0; s < window.unifiedTimes.length; s++) {
                if (scheduleAssignments[bunk][s]) continue; // Already filled
                if (window.leagueAssignments?.[div]?.[s]) continue; // League
                if (!isActive(s)) continue; // Not an active slot for this div

                // ----- NEW DYNAMIC SPAN LOGIC -----
                const period = getPeriodForSlot(s, div); // Pass division!
                if (!period) continue; // Slot is not in a schedulable period
                
                const spanLen = divisionSpanLens[div]?.[period.id] || 1;
                const rule = divisions[div].periodRules[period.id];
                if (!rule) continue;

                // Find the very first slot of this period for this division
                const periodStartSlotArr = findRowsForRange(rule.start, rule.end);
                if (!periodStartSlotArr || periodStartSlotArr.length === 0) continue;
                const periodStartSlot = periodStartSlotArr[0];
                
                // Check if this slot `s` is the *start* of a sub-activity.
                if ((s - periodStartSlot) % spanLen !== 0) {
                    continue; // This is the middle of an activity block, not a start
                }
                // ----- END NEW DYNAMIC SPAN LOGIC -----

                let assignedSpan = 0;

                const preferredPicks = [];
                const nonPreferredPicks = [];
                allActivities.forEach(pick => { (generalActivityHistory[bunk].has(getActivityName(pick)) ? nonPreferredPicks : preferredPicks).push(pick); });
                const shuffledPreferred = preferredPicks.sort(() => 0.5 - Math.random());
                const shuffledNonPreferred = nonPreferredPicks.sort(() => 0.5 - Math.random());

                // 2a. With probability, attempt H2H FIRST
                if (assignedSpan === 0 && (h2hGameCount[bunk] || 0) < 2 && Math.random() < H2H_PROB) {
                    assignedSpan = tryH2H(bunk, div, s, spanLen, allBunksInDiv, h2hActivities, fieldUsageBySlot, isActive, activityProperties, h2hHistory, h2hGameCount);
                }
                // 2b. Preferred general
                if (assignedSpan === 0) {
                    assignedSpan = tryGeneralActivity(bunk, div, s, spanLen, shuffledPreferred, fieldUsageBySlot, isActive, generalActivityHistory, generalFieldHistory, activityProperties);
                }
                // 3. H2H again if still open
                if (assignedSpan === 0 && (h2hGameCount[bunk] || 0) < 2) {
                    assignedSpan = tryH2H(bunk, div, s, spanLen, allBunksInDiv, h2hActivities, fieldUsageBySlot, isActive, activityProperties, h2hHistory, h2hGameCount);
                }
                // 4. Non-preferred
                if (assignedSpan === 0) {
                    assignedSpan = tryGeneralActivity(bunk, div, s, spanLen, shuffledNonPreferred, fieldUsageBySlot, isActive, generalActivityHistory, generalFieldHistory, activityProperties);
                }
                
                // 5. Advance
                if (assignedSpan > 0) { 
                    s += (assignedSpan - 1); // Skip slots we just filled
                }
            }
        }
    }

    // ===== 7. CALL FILLER PASSES =====
    // Pass the new spanLen map
    // Note: The fillers need to be refactored to use this new map
    window.fillRemainingWithForcedH2HPlus?.(availableDivisions, divisions, divisionSpanLens, h2hActivities, fieldUsageBySlot, activityProperties, h2hHistory, h2hGameCount, generalActivityHistory);
    window.fillRemainingWithDoublingAggressive?.(availableDivisions, divisions, divisionSpanLens, fieldUsageBySlot, activityProperties, generalActivityHistory);
    window.fillRemainingWithFallbackSpecials?.(availableDivisions, divisions, divisionSpanLens, allActivities, fieldUsageBySlot, activityProperties, generalActivityHistory);
    
    updateTable();
    saveSchedule();
}
window.assignFieldsToBunks = assignFieldsToBunks; // Expose main function

// ===== Helpers for General/H2H placement =====
function tryGeneralActivity(bunk, div, s, spanLen, activityList, fieldUsageBySlot, isActive, generalActivityHistory, generalFieldHistory, activityProperties) {
    for (const pick of activityList) {
        const pickedField = fieldLabel(pick.field);
        const activityName = getActivityName(pick);
        
        // Don't repeat the exact same field for the same activity as yesterday
        if (generalFieldHistory && generalFieldHistory[bunk][activityName] === pickedField && (window.allSchedulableNames || []).length > 1) {
             continue;
        }

        let [canFit, spanForThisPick] = canActivityFit(bunk, div, s, spanLen, pickedField, fieldUsageBySlot, isActive, activityProperties);
        if (canFit && spanForThisPick > 0) {
            return assignActivity(bunk, s, spanForThisPick, pick, fieldUsageBySlot, generalActivityHistory);
        }
    }
    return 0;
}

function tryH2H(bunk, div, s, spanLen, allBunksInDiv, h2hActivities, fieldUsageBySlot, isActive, activityProperties, h2hHistory, h2hGameCount) {
    const opponents = allBunksInDiv.filter(b => {
        if (b === bunk) return false;
        if (scheduleAssignments[b][s]) return false;
        if ((h2hHistory[bunk]?.[b] || 0) >= 1) return false; // no rematch
        if ((h2hGameCount[b] || 0) >= 2) return false; // opponent cap
        if (window.leagueAssignments?.[div]?.[s]) return false;
        return true;
    });
    if (opponents.length > 0) {
        const opponent = opponents[Math.floor(Math.random() * opponents.length)];
        const h2hPicks = h2hActivities.sort(() => 0.5 - Math.random());
        for (const pick of h2hPicks) {
            const pickedField = fieldLabel(pick.field);
            let [canFit, spanForThisPick] = canActivityFit(bunk, div, s, spanLen, pickedField, fieldUsageBySlot, isActive, activityProperties);
            let [oppCanFit, oppSpan] = canActivityFit(opponent, div, s, spanLen, pickedField, fieldUsageBySlot, isActive, activityProperties);
            const finalSpan = Math.min(spanForThisPick, oppSpan);

            if (canFit && oppCanFit && finalSpan > 0) {
                for (let k = 0; k < finalSpan; k++) {
                    const currentSlot = s + k; const cont = k > 0;
                    scheduleAssignments[bunk][currentSlot] = { field: pickedField, sport: pick.sport, continuation: cont, _h2h: true, vs: opponent };
                    scheduleAssignments[opponent][currentSlot] = { field: pickedField, sport: pick.sport, continuation: cont, _h2h: true, vs: bunk };
                    if (pickedField && (window.allSchedulableNames || []).includes(pickedField)) {
                        fieldUsageBySlot[currentSlot] = fieldUsageBySlot[currentSlot] || {};
                        fieldUsageBySlot[currentSlot][pickedField] = 2; // exclusive lock
                    }
                }
                h2hHistory[bunk] = h2hHistory[bunk] || {};
                h2hHistory[opponent] = h2hHistory[opponent] || {};
                h2hHistory[bunk][opponent] = (h2hHistory[bunk][opponent] || 0) + 1;
                h2hHistory[opponent][bunk] = (h2hHistory[opponent][bunk] || 0) + 1;
                h2hGameCount[bunk] = (h2hGameCount[bunk] || 0) + 1;
                h2hGameCount[opponent] = (h2hGameCount[opponent] || 0) + 1;
                return finalSpan;
            }
        }
    }
    return 0;
}

function canActivityFit(bunk, div, s, spanLen, pickedField, fieldUsageBySlot, isActive, activityProperties) {
    let canFitThisPick = true;
    let spanForThisPick = 0;
    
    // Check Limit Usage rules
    const fieldProps = activityProperties[pickedField];
    if (fieldProps?.limitUsage?.enabled) {
        const limits = fieldProps.limitUsage.divisions;
        if (!limits[div]) {
            return [false, 0]; // This division is not allowed at all
        }
        const bunksAllowed = limits[div];
        if (bunksAllowed.length > 0 && !bunksAllowed.includes(bunk)) {
            return [false, 0]; // This bunk is not in the allowed list
        }
    }

    for (let k = 0; k < spanLen; k++) {
        const currentSlot = s + k;
        if (currentSlot >= window.unifiedTimes.length) { canFitThisPick = false; break; }
        
        let isBusy = false;
        if (window.scheduleAssignments[bunk][currentSlot] || window.leagueAssignments?.[div]?.[currentSlot] || !isActive(currentSlot)) { 
            isBusy = true; 
        }

        if (!isBusy && pickedField && (window.allSchedulableNames || []).includes(pickedField)) {
            const usage = fieldUsageBySlot[currentSlot]?.[pickedField] || 0;
            if (usage > 0) {
                if (!fieldProps || !fieldProps.sharable || usage >= 2 || !fieldProps.allowedDivisions.includes(div)) { 
                    isBusy = true; 
                } else {
                    // Enforce same-division sharing
                    let occupyingDivision = null;
                    const allDivs = window.availableDivisions || [];
                    const divs = window.divisions || {};
                    for (const dv of allDivs) {
                        const bunksHere = divs[dv]?.bunks || [];
                        for (const b2 of bunksHere) {
                            const e2 = window.scheduleAssignments[b2]?.[currentSlot];
                            if (e2 && !e2._fixed && !e2._h2h && fieldLabel(e2.field) === pickedField) { 
                                occupyingDivision = window.bunkToDivision?.[b2] || dv; 
                                break; 
                            }
                        }
                        if (occupyingDivision) break;
                    }
                    if (occupyingDivision && occupyingDivision !== div) {
                        isBusy = true; // Can't share with a different division
                    }
                }
            }
        }

        if (isBusy) { 
            if (k === 0) canFitThisPick = false; 
            break; 
        }
        spanForThisPick++;
    }
    return [canFitThisPick, spanForThisPick];
}

function assignActivity(bunk, s, spanForThisPick, pick, fieldUsageBySlot, generalActivityHistory) {
    const pickedField = fieldLabel(pick.field);
    const activityName = getActivityName(pick);
    for (let k = 0; k < spanForThisPick; k++) {
        const currentSlot = s + k;
        window.scheduleAssignments[bunk][currentSlot] = { field: pickedField, sport: pick.sport, continuation: (k > 0) };
        if (pickedField && (window.allSchedulableNames || []).includes(pickedField)) {
            fieldUsageBySlot[currentSlot] = fieldUsageBySlot[currentSlot] || {};
            fieldUsageBySlot[currentSlot][pickedField] = (fieldUsageBySlot[currentSlot][pickedField] || 0) + 1;
        }
    }
    generalActivityHistory[bunk].add(activityName);
    return spanForThisPick;
}
