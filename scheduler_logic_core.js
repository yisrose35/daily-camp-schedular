// -------------------- scheduler_logic_core.js --------------------
// Core logic: helpers, fixed-activity plumbing, league helpers/rotation,
// uniqueness rules, and primary scheduling (assignFieldsToBunks).
//
// REFACTORED FOR "SCHEDULE PERIODS"
// - Generates a 30-minute unifiedTime grid.
// - Uses schedulePeriods (from app1) to create an "active mask" for each division.
// - Uses periodRules (from app1) to calculate a DYNAMIC spanLen for each division,
//   in each period, for general/H2H activities.
// - Uses a hardcoded default (30 min) for League game length.
// -----------------------------------------------------------------

// ===== CONFIG =====
const INCREMENT_MINS = 30;
const LEAGUE_DURATION_MINS = 30; // Leagues are a separate system, so they
                                  // get a default duration.

// ===== Helpers =====
// (Kept from original)
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
function fmtTime(d) {
    let h = d.getHours(), m = d.getMinutes().toString().padStart(2,"0"), ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
    return `${h}:${m} ${ap}`;
}

// ===== NEW: Period/Time Generation Helpers =====

/**
 * NEW: Generates the unifiedTimes (30-min grid) and divisionActiveRows
 * mask based on the new schedulePeriods from app1.js.
 */
function generateUnifiedTimesAndMasks() {
    const periods = window.schedulePeriods || [];
    if (periods.length === 0) {
        console.warn("No Schedule Periods found. Cannot generate schedule.");
        window.unifiedTimes = [];
        window.divisionActiveRows = {};
        return;
    }

    // 1. Find the full time range of the day
    const allTimes = periods.flatMap(p => [parseTimeToMinutes(p.start), parseTimeToMinutes(p.end)]);
    const earliestMin = Math.min(...allTimes);
    const latestMin = Math.max(...allTimes);

    // 2. Generate unifiedTimes grid
    window.unifiedTimes = [];
    const baseDate = new Date(1970, 0, 1, 0, 0, 0); // Base date for time objects
    
    let currentMin = earliestMin;
    while (currentMin < latestMin) {
        const nextMin = currentMin + INCREMENT_MINS;
        
        const startDate = new Date(baseDate.getTime() + currentMin * 60000);
        const endDate = new Date(baseDate.getTime() + nextMin * 60000);
        
        window.unifiedTimes.push({ 
            start: startDate, 
            end: endDate, 
            label: `${fmtTime(startDate)} - ${fmtTime(endDate)}` 
        });
        
        currentMin = nextMin;
    }
    
    // 3. Generate divisionActiveRows (the "mask")
    window.divisionActiveRows = {};
    const divisions = window.divisions || {};
    const availableDivisions = window.availableDivisions || [];

    availableDivisions.forEach(divName => {
        const activeRows = new Set();
        const div = divisions[divName];
        if (!div) return;

        periods.forEach(period => {
            const periodStartMin = parseTimeToMinutes(period.start);
            const periodEndMin = parseTimeToMinutes(period.end);

            window.unifiedTimes.forEach((timeSlot, index) => {
                const slotStartMin = timeSlot.start.getHours() * 60 + timeSlot.start.getMinutes();
                // Check if the slot starts within this period
                if (slotStartMin >= periodStartMin && slotStartMin < periodEndMin) {
                    activeRows.add(index);
                }
            });
        });
        window.divisionActiveRows[divName] = activeRows;
    });
}

/**
 * NEW: Pre-calculates the spanLen (in slots) for every division and every period.
 * Returns two maps:
 * 1. periodSlotCounts: { periodId: slotCount }
 * 2. divisionSpanLens: { divName: { periodId: spanLen } }
 */
function buildSpanLenMaps() {
    const periodSlotCounts = {};
    const divisionSpanLens = {};

    const periods = window.schedulePeriods || [];
    const divisions = window.divisions || {};
    const availableDivisions = window.availableDivisions || [];
    const unifiedTimes = window.unifiedTimes || [];

    if (unifiedTimes.length === 0) return { periodSlotCounts, divisionSpanLens };

    // 1. Calculate how many slots are in each period
    periods.forEach(period => {
        const periodStartMin = parseTimeToMinutes(period.start);
        const periodEndMin = parseTimeToMinutes(period.end);
        let slotCount = 0;

        unifiedTimes.forEach((timeSlot, index) => {
            const slotStartMin = timeSlot.start.getHours() * 60 + timeSlot.start.getMinutes();
            if (slotStartMin >= periodStartMin && slotStartMin < periodEndMin) {
                slotCount++;
            }
        });
        periodSlotCounts[period.id] = slotCount;
    });

    // 2. Calculate the dynamic spanLen for each division based on their rules
    availableDivisions.forEach(divName => {
        const div = divisions[divName];
        if (!div) return;

        divisionSpanLens[divName] = {};
        const rules = div.periodRules || {};

        periods.forEach(period => {
            const rule = rules[period.id] || "1";
            const numActivities = parseInt(rule, 10);
            const totalSlots = periodSlotCounts[period.id] || 0;
            
            // Calculate span for this activity
            // e.g., 60-min period (2 slots) / "2 Activities" = 1-slot span
            // e.g., 60-min period (2 slots) / "1 Activity" = 2-slot span
            const spanLen = Math.max(1, Math.floor(totalSlots / numActivities));
            
            divisionSpanLens[divName][period.id] = spanLen;
        });
    });

    return { periodSlotCounts, divisionSpanLens };
}

/**
 * NEW: Helper to find which period a given slot index belongs to.
 */
function getPeriodForSlot(slotIndex) {
    const periods = window.schedulePeriods || [];
    const unifiedTimes = window.unifiedTimes || [];
    
    if (!unifiedTimes[slotIndex]) return null;

    const slotStartMin = unifiedTimes[slotIndex].start.getHours() * 60 + unifiedTimes[slotIndex].start.getMinutes();

    for (const period of periods) {
        const periodStartMin = parseTimeToMinutes(period.start);
        const periodEndMin = parseTimeToMinutes(period.end);
        if (slotStartMin >= periodStartMin && slotStartMin < periodEndMin) {
            return period;
        }
    }
    return null;
}

// ===== Fixed Activities =====
// (Kept from original, but prePlaceFixedActivities is now called
// AFTER unifiedTimes is generated)

function loadActiveFixedActivities() {
    const globalSettings = window.loadGlobalSettings?.() || {};
    const allFixed = globalSettings.fixedActivities || [];
    return Array.isArray(allFixed) ? allFixed.filter((a) => a && a.enabled) : [];
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
    const fixed = loadActiveFixedActivities();
    const blocked = {};
    fixed.forEach((act) => {
        const rows = findRowsForRange(act.start, act.end);
        if (rows.length === 0) return;
        const targetDivs = Array.isArray(act.divisions) && act.divisions.length > 0 ? act.divisions : window.availableDivisions || [];
        targetDivs.forEach((div) => {
            blocked[div] = blocked[div] || new Set();
            rows.forEach((r) => blocked[div].add(r));
        });
    });
    return blocked;
}

function prePlaceFixedActivities() {
    // This function now relies on window.DailyActivities.prePlace
    // which is defined in daily_activities.js
    if (window.DailyActivities?.prePlace) {
        try { 
            window.DailyActivities.prePlace(); 
        } catch (e) { 
            console.error("DailyActivities.prePlace error:", e); 
        }
    }
    // Return the map of blocked rows for the scheduler to respect
    return computeBlockedRowsByDiv();
}

// ===== League Helpers =====
// (Kept from original)
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

// ===== League Sport Rotation (UPDATED) =====
// (Kept from original)
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

// ====== CORE ASSIGN (HEAVILY REFACTORED) ======
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
    
    // This function creates window.unifiedTimes and window.divisionActiveRows
    generateUnifiedTimesAndMasks();
    
    if (!window.unifiedTimes || window.unifiedTimes.length === 0) {
        console.warn("Cannot assign fields: No unified times were generated.");
        updateTable();
        return;
    }
    
    // This function creates the dynamic span lengths
    const { periodSlotCounts, divisionSpanLens } = buildSpanLenMaps();
    
    // This defines the span for LEAGUES (which are not period-based)
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

    // Pre-place fixed activities (like Lunch) and get blocked rows
    const blockedRowsByDiv = prePlaceFixedActivities();

    // fieldUsageBySlot = { slot: { FieldName: usageCount } } ; fixed take usage=2
    const fieldUsageBySlot = {};
    (availableDivisions || []).forEach(div => {
        (divisions[div]?.bunks || []).forEach(bunk => {
            if (scheduleAssignments[bunk]) {
                scheduleAssignments[bunk].forEach((entry, slot) => {
                    if (entry && entry._fixed && entry.field) {
                        const fieldName = fieldLabel(entry.field);
                        if (window.allSchedulableNames.includes(fieldName)) {
                            fieldUsageBySlot[slot] = fieldUsageBySlot[slot] || {};
                            fieldUsageBySlot[slot][fieldName] = 2;
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
    // (This logic is kept from the original, as leagues are a separate system)
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
        // This is the "is this slot active for this division?" check
        const isActive = (s) => window.divisionActiveRows?.[div]?.has(s) ?? false;
        const allBunksInDiv = divisions[div]?.bunks || [];

        for (const bunk of allBunksInDiv) {
            for (let s = 0; s < window.unifiedTimes.length; s++) {
                if (scheduleAssignments[bunk][s]) continue; // Already filled
                if (window.leagueAssignments?.[div]?.[s]) continue; // League
                if (!isActive(s)) continue; // Not an active slot for this div

                // ----- NEW DYNAMIC SPAN LOGIC -----
                const period = getPeriodForSlot(s);
                if (!period) continue; // Slot is not in a schedulable period
                
                // Get the calculated span (e.g., 1 slot for 30min, 2 slots for 60min)
                const spanLen = divisionSpanLens[div]?.[period.id] || 1;
                
                // Check if this slot `s` is the *start* of a sub-activity.
                // If spanLen is 1 (30min), this is always true.
                // If spanLen is 2 (60min), this is only true for 9:00 (slot 0),
                // not 9:30 (slot 1).
                const periodStartSlot = findRowsForRange(period.start, period.end)[0];
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
    // NOTE: These fillers are in scheduler_logic_fillers.js
    // They will need to be updated to use the new dynamic spanLen logic.
    // For now, they will be called with a hardcoded span of 1.
    // TODO: Refactor fillers to accept dynamic spans.
    const fillerSpanLen = 1; // Failsafe for old fillers

    // Pass 2.5: forced H2H within grade (aggressive), before doubling
    window.fillRemainingWithForcedH2HPlus?.(availableDivisions, divisions, fillerSpanLen, h2hActivities, fieldUsageBySlot, activityProperties, h2hHistory, h2hGameCount, generalActivityHistory);

    // Pass 3: aggressive doubling on sharables
    window.fillRemainingWithDoublingAggressive?.(availableDivisions, divisions, fillerSpanLen, fieldUsageBySlot, activityProperties, generalActivityHistory);

    // Final fallback: sharable specials to remove any blanks
    window.fillRemainingWithFallbackSpecials?.(availableDivisions, divisions, fillerSpanLen, allActivities, fieldUsageBySlot, activityProperties, generalActivityHistory);


    updateTable();
    saveSchedule();
}
window.assignFieldsToBunks = assignFieldsToBunks; // Expose main function

// ===== Helpers for General/H2H placement =====
// (These are unchanged, they just accept spanLen)
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
    
    // NEW: Check Limit Usage rules
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
