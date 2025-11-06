// -------------------- scheduler_logic_core.js --------------------
// Core logic: helpers, fixed-activity plumbing, league helpers/rotation,
// uniqueness rules, and primary scheduling (assignFieldsToBunks).
//
// NEW: `canActivityFit` and `activityProperties` now support
//      advanced `sharableWith` rules (all, none, custom).
// --------------------

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

// ===== FIX 8 HELPER =====
function getActivityName(pick) {
  if (pick.sport) return pick.sport; // e.g., "Basketball"
  return fieldLabel(pick.field);     // e.g., "Gameroom" or special name
}

// ===== Fixed Activities =====
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
    const r = window.unifiedTimes[i], rs = r.start.getHours() * 60 + r.start.getMinutes(), re = r.end.getHours() * 60 + r.end.getMinutes();
    if (rs >= startMin && re <= endMin) inside.push(i);
  }
  if (inside.length === 0) {
    const overlap = [];
    for (let i = 0; i < window.unifiedTimes.length; i++) {
      const r = window.unifiedTimes[i], rs = r.start.getHours() * 60 + r.start.getMinutes(), re = r.end.getHours() * 60 + r.end.getMinutes();
      if (Math.max(rs, startMin) < Math.min(re, endMin)) overlap.push(i);
    }
    return overlap;
  }
  return inside;
}

/**
 * NEW UPGRADED FUNCTION
 * This function now handles BOTH Daily Trips and Global Fixed Activities.
 */
function prePlaceFixedActivities() {
  const dailyData = window.loadCurrentDailyData?.() || {};
  const globalSettings = window.loadGlobalSettings?.() || {};
  const allDivisionsMap = window.divisions || {};
  const allBunks = (window.availableDivisions || []).flatMap(div => allDivisionsMap[div]?.bunks || []);

  const blocked = {}; // This is what we will return

  // --- 1. Place Daily Trips (Highest Priority) ---
  const trips = dailyData.trips || [];
  trips.forEach(trip => {
    const rows = findRowsForRange(trip.start, trip.end); // Use existing helper
    if (rows.length === 0) return;

    // Resolve targets (divisions + bunks) into a flat list of bunk names
    const targetBunks = new Set();
    (trip.targets || []).forEach(target => {
      if (allDivisionsMap[target]) {
        // It's a division
        (allDivisionsMap[target].bunks || []).forEach(b => targetBunks.add(b));
      } else if (allBunks.includes(target)) {
        // It's a single bunk
        targetBunks.add(target);
      }
    });

    // Place the trip on the grid for each bunk
    targetBunks.forEach(bunk => {
      const div = window.bunkToDivision?.[bunk];
      if (!window.scheduleAssignments[bunk]) {
         console.warn(`Trip placer: Could not find schedule row for bunk ${bunk}`);
         return;
      }

      rows.forEach((r, k) => {
        // Stamp the trip onto the grid
        window.scheduleAssignments[bunk][r] = {
          field: trip.name, // "Museum Trip"
          _fixed: true,
          continuation: k > 0
        };
        
        // Also mark this row as blocked for this bunk's division
        if (div) {
          blocked[div] = blocked[div] || new Set();
          blocked[div].add(r);
        }
      });
    });
  });

  // --- 2. Place Global Fixed Activities (Lower Priority) ---
  const globalFixed = loadActiveFixedActivities(); // Uses existing helper
  globalFixed.forEach(act => {
    const rows = findRowsForRange(act.start, act.end);
    if (rows.length === 0) return;
    
    const targetDivs = Array.isArray(act.divisions) && act.divisions.length > 0 
      ? act.divisions 
      : window.availableDivisions || [];
      
    targetDivs.forEach(div => {
      if (!allDivisionsMap[div]) return;
      
      // Mark as blocked (for the main scheduler)
      blocked[div] = blocked[div] || new Set();
      rows.forEach(r => blocked[div].add(r));

      // Place on grid *only* for bunks that are not already on a trip
      (allDivisionsMap[div].bunks || []).forEach(bunk => {
        if (!window.scheduleAssignments[bunk]) return;
        
        rows.forEach((r, k) => {
          // *** KEY LOGIC ***: Don't override an existing trip
          if (!window.scheduleAssignments[bunk][r]) { 
            window.scheduleAssignments[bunk][r] = {
              field: act.name, // "Lunch"
              _fixed: true,
              continuation: k > 0
            };
          }
        });
      });
    });
  });

  return blocked;
}

/**
 * NEW: Helper for canActivityFit
 * Finds the bunk and division of the *first* occupant on a field in a slot.
 */
function findOccupantBunk(currentSlot, pickedField) {
  const allDivs = window.availableDivisions || [];
  const divs = window.divisions || {};
  for (const dv of allDivs) {
    const bunksHere = divs[dv]?.bunks || [];
    for (const b of bunksHere) {
      const e = window.scheduleAssignments[b]?.[currentSlot];
      if (e && !e._fixed && !e._h2h && fieldLabel(e.field) === pickedField) {
        return { bunk: b, div: dv };
      }
    }
  }
  return null;
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

// ===== League Sport Rotation (UPDATED) =====
let leagueSportRotation = {};
let leagueMatchupHistory = {}; // NEW: For tracking sport per opponent

// Renamed from loadLeagueSportRotation
function loadLeagueStates() {
  try {
    if (window.currentDailyData && window.currentDailyData.leagueSportRotation) {
      // Load from today's data if it exists
      leagueSportRotation = window.currentDailyData.leagueSportRotation;
      leagueMatchupHistory = window.currentDailyData.leagueMatchupHistory || {};
    } else if (window.loadPreviousDailyData) {
      // Otherwise, load from yesterday and save to today
      const yesterdayData = window.loadPreviousDailyData();
      leagueSportRotation = yesterdayData.leagueSportRotation || {};
      leagueMatchupHistory = yesterdayData.leagueMatchupHistory || {};
      saveLeagueStates(); // Carry-forward to today's data
    } else {
      // No data, start fresh
      leagueSportRotation = {};
      leagueMatchupHistory = {};
    }
  } catch(e) {
    console.error("Failed to load league states:", e);
    leagueSportRotation = {};
    leagueMatchupHistory = {};
  }
}

// Renamed from saveLeagueSportRotation
function saveLeagueStates() {
  try {
    window.saveCurrentDailyData?.("leagueSportRotation", leagueSportRotation);
    window.saveCurrentDailyData?.("leagueMatchupHistory", leagueMatchupHistory);
  } catch {}
}

// Helper for league matchup history
function getMatchupKey(teamA, teamB) {
  return [teamA, teamB].sort().join('-');
}

// UPDATED assignSportsToMatchups (Handles Req #1 and #3)
function assignSportsToMatchups(leagueName, matchups, sportsList, yesterdayHistory) {
  if (!Array.isArray(matchups) || matchups.length === 0) return [];
  if (!Array.isArray(sportsList) || sportsList.length === 0) {
    return matchups.map((m) => ({ teams: m, sport: "Leagues" }));
  }

  loadLeagueStates(); // Use the new function

  const leagueHist = leagueMatchupHistory[leagueName] || {};
  const state = leagueSportRotation[leagueName] || { index: 0 };
  let idx = state.index;

  const assigned = [];

  for (const match of matchups) {
    const [teamA, teamB] = match;
    const matchupKey = getMatchupKey(teamA, teamB);
    const hist = leagueHist[matchupKey] || [];
    
    // REQ #1: Get last sport played *against this opponent*
    const lastSportVsOpponent = hist.length > 0 ? hist[hist.length - 1] : null;

    // REQ #3: Get last sport played *yesterday*
    const lastSportA = yesterdayHistory[teamA];
    const lastSportB = yesterdayHistory[teamB];

    let chosenSport = null;
    let chosenSportIdx = -1;

    // --- Pass 1: Strict Mode (Respects Req #1 AND #3) ---
    for (let i = 0; i < sportsList.length; i++) {
      const sportIdx = (idx + i) % sportsList.length;
      const sport = sportsList[sportIdx];

      if (sport === lastSportVsOpponent) continue; // Fail Req #1
      if (sport === lastSportA || sport === lastSportB) continue; // Fail Req #3 (back-to-back)

      chosenSport = sport;
      chosenSportIdx = sportIdx;
      break;
    }

    // --- Pass 2: Relaxed Mode (Respects Req #1, but allows back-to-back) ---
    if (!chosenSport) {
      for (let i = 0; i < sportsList.length; i++) {
        const sportIdx = (idx + i) % sportsList.length;
        const sport = sportsList[sportIdx];

        if (sport === lastSportVsOpponent) continue; // STILL Fail Req #1

        chosenSport = sport;
        chosenSportIdx = sportIdx;
        break;
      }
    }
    
    // --- Pass 3: Failsafe (Req #1 cannot be met) ---
    if (!chosenSport) {
      chosenSportIdx = idx % sportsList.length;
      chosenSport = sportsList[chosenSportIdx];
    }
    
    idx = (chosenSportIdx + 1) % sportsList.length;
    assigned.push({ teams: match, sport: chosenSport });

    const newHist = leagueHist[matchupKey] || [];
    newHist.push(chosenSport);
    leagueHist[matchupKey] = newHist;
  }

  leagueSportRotation[leagueName] = { index: idx };
  leagueMatchupHistory[leagueName] = leagueHist;
  saveLeagueStates(); // Use the new function

  return assigned;
}

/**
 * This function now checks for daily overrides before applying global rules.
 */
function computeActivityBlockedSlots() {
  const globalSettings = window.loadGlobalSettings?.() || {};
  const allFields = globalSettings.app1?.fields || [];
  const allSpecials = globalSettings.app1?.specialActivities || [];
  const allActivities = [...allFields, ...allSpecials];
  
  const dailyData = window.loadCurrentDailyData?.() || {};
  const dailyOverrides = dailyData.fieldAvailability || {};
  
  const unifiedTimes = window.unifiedTimes || [];
  if (unifiedTimes.length === 0) return {};

  const activityBlockedSlots = {};

  allActivities.forEach(item => {
    if (!item || !item.name) return;
    
    const activityName = item.name;
    activityBlockedSlots[activityName] = new Set();
    
    const dailyRule = dailyOverrides[activityName];
    let ruleToApply;

    if (dailyRule) {
      ruleToApply = {
        mode: dailyRule.mode || "available",
        exceptions: dailyRule.exceptions || []
      };
    } else {
      ruleToApply = {
        mode: item.availabilityMode || "available",
        exceptions: item.availabilityExceptions || []
      };
    }
    
    const { mode, exceptions } = ruleToApply;

    const exceptionRanges = [];
    exceptions.forEach(rangeStr => {
      const parts = rangeStr.split('-');
      if (parts.length === 2) {
        const startMin = parseTimeToMinutes(parts[0]);
        const endMin = parseTimeToMinutes(parts[1]);
        if (startMin != null && endMin != null && endMin > startMin) {
          exceptionRanges.push({ start: startMin, end: endMin });
        }
      }
    });

    for (let i = 0; i < unifiedTimes.length; i++) {
      const slot = unifiedTimes[i];
      const slotStart = slot.start.getHours() * 60 + slot.start.getMinutes();
      const slotEnd = slot.end.getHours() * 60 + slot.end.getMinutes();

      let inExceptionRange = false;
      for (const range of exceptionRanges) {
        if (Math.max(slotStart, range.start) < Math.min(slotEnd, range.end)) {
          inExceptionRange = true;
          break;
        }
      }

      let isBlocked = false;
      if (mode === "available") {
        if (inExceptionRange) {
          isBlocked = true;
        }
      } else {
        if (!inExceptionRange) {
          isBlocked = true;
        }
      }

      if (isBlocked) {
        activityBlockedSlots[activityName].add(i);
      }
    }
  });

  return activityBlockedSlots;
}

// ====== CORE ASSIGN ======<br>
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
    leagues: loadedOverrides.leagues || []
  };

  // ===== Load *Yesterday's* Data =====
  const yesterdayData = window.loadPreviousDailyData?.() || {};
  const yesterdayLeagues = yesterdayData.leagueAssignments || {};
  const yesterdaySchedule = yesterdayData.scheduleAssignments || {};

  // 3. Create Today's Filtered Lists
  const availFields = masterFields.filter(f => f.available);
  const availSpecials = masterSpecials.filter(s => s.available);
  const availableDivisions = masterAvailableDivs; 
  
  const divisions = {};
  for (const divName of availableDivisions) {
    if (!masterDivisions[divName]) continue;
    divisions[divName] = JSON.parse(JSON.stringify(masterDivisions[divName]));
  }
  window.availableDivisions = availableDivisions;
  window.divisions = divisions;
  
  window.bunkToDivision = {};
  availableDivisions.forEach(dv => { (divisions[dv]?.bunks || []).forEach(bk => window.bunkToDivision[bk] = dv); });

  scheduleAssignments = {};
  availableDivisions.forEach((d) => (divisions[d]?.bunks || []).forEach((b) => (scheduleAssignments[b] = new Array(window.unifiedTimes.length))));
  window.scheduleAssignments = scheduleAssignments;

  // Place fixed blocks (trips AND fixed activities)
  const blockedRowsByDiv = prePlaceFixedActivities();
  
  window.activityBlockedSlots = computeActivityBlockedSlots(); 

  const allGlobalDivisions = app1Data.availableDivisions || masterAvailableDivs;

  // ===== UPDATED: Activity properties =====
  // Now includes the new `sharableWith` object
  const activityProperties = {};
  availFields.forEach(f => {
    activityProperties[f.name] = {
      sharableWith: f.sharableWith || { type: 'not_sharable' }, // <-- NEW
      allowedDivisions: (f.allowedDivisions || []).length > 0 ? f.allowedDivisions : allGlobalDivisions
    };
  });
  availSpecials.forEach(s => {
    activityProperties[s.name] = {
      sharableWith: s.sharableWith || { type: 'all' }, // <-- NEW
      allowedDivisions: (s.allowedDivisions || []).length > 0 ? s.allowedDivisions : allGlobalDivisions
    };
  });
  // ===== END UPDATE =====

  const enabledByDiv = getEnabledLeaguesByDivision(masterLeagues, overrides);

  const inc = parseInt(document.getElementById("increment")?.value || "30", 10);
  const activityDuration = parseInt(document.getElementById("activityDuration")?.value || "30", 10);
  const spanLen = Math.max(1, Math.ceil(activityDuration / inc));

  const fieldsBySport = {}; window._lastFieldsBySportCache = fieldsBySport;
  const allFieldNames = [];
  availFields.forEach(f => {
    allFieldNames.push(f.name);
    if (Array.isArray(f.activities)) {
      f.activities.forEach(sport => {
        fieldsBySport[sport] = fieldsBySport[sport] || [];
        fieldsBySport[sport].push(f.name);
        window._lastFieldsBySportCache = fieldsBySport;
      });
    }
  });
  window.allSchedulableNames = allFieldNames.concat(availSpecials.map(s => s.name));

  const allActivities = [
    ...availFields.flatMap((f) => (f.activities || []).map((act) => ({ type: "field", field: f, sport: act }))),
    ...availSpecials.map((sa) => ({ type: "special", field: sa, sport: null }))
  ];
  const h2hActivities = allActivities.filter(a => a.type === 'field' && a.sport);

  window._allActivitiesCache = allActivities;

  if ((!allActivities.length && !availSpecials.length) || !window.unifiedTimes || window.unifiedTimes.length === 0) {
    console.warn("Cannot assign fields: No activities or unified times are set. Did you click 'Generate Schedule Times'?");
    updateTable();
    return;
  }

  window.todayActivityUsed = {};
  availableDivisions.forEach(div => {
    (divisions[div]?.bunks || []).forEach(b => {
      window.todayActivityUsed[b] = new Set();
    });
  });

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
          if (entry) {
            const name = entry.sport ? entry.sport : fieldLabel(entry.field);
            if (name) window.todayActivityUsed[bunk].add(name);
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
  availableDivisions.forEach(div => {
    (divisions[div]?.bunks || []).forEach(bunk => {
      if (scheduleAssignments[bunk]) {
        scheduleAssignments[bunk].forEach((entry) => { if (entry && entry._fixed) generalActivityHistory[bunk].add(fieldLabel(entry.field)); });
      }
    });
  });

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
          let k = slot;
          while (k > 0 && window.scheduleAssignments[b][k-1] && window.scheduleAssignments[b][k-1].continuation) k--;
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
      for (let k = 0; k < spanLen; k++) {
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

    for (const chosenSlot of candidates) {
      const teams = (lg.data.teams || []).map((t) => String(t).trim()).filter(Boolean);
      if (teams.length < 2) break;
      const matchups = window.getLeagueMatchups?.(lg.name, teams) || [];
      if (!matchups.length) break;
      const gamesWithSports = assignSportsToMatchups(lg.name, matchups, lg.data.sports, leagueTeamSportHistory);

      const availableFieldsForSpan = {};
      allFieldNames.forEach(name => {
        let capacity = 1;
        for (let k = 0; k < spanLen; k++) { 
          const slot = chosenSlot + k; 
          const usage = fieldUsageBySlot[slot]?.[name] || 0; 
          if (usage > 0 || window.activityBlockedSlots?.[name]?.has(slot)) { 
            capacity = 0; 
            break; 
          } 
        }
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

      if (!allGamesCanBeScheduled) continue; 

      window.leagueAssignments[div] = window.leagueAssignments[div] || {};
      const leagueData = { games: gamesWithFields, leagueName: lg.name, isContinuation: false };
      const leagueContinuation = { leagueName: lg.name, isContinuation: true };
      for (let k = 0; k < spanLen; k++) {
        const slot = chosenSlot + k; if (slot >= window.unifiedTimes.length) break;
        window.leagueAssignments[div][slot] = (k === 0) ? leagueData : leagueContinuation;
        takenLeagueSlots.add(slot);
        gamesWithFields.forEach(game => { if (game.field) { fieldUsageBySlot[slot] = fieldUsageBySlot[slot] || {}; fieldUsageBySlot[slot][game.field] = 2; } });
      }
      (gamesWithFields || []).forEach(g => {
        const sportName = g.sport;
        const [teamA, teamB] = g.teams || [];
        if (sportName) {
          if (teamA && window.todayActivityUsed[teamA]) window.todayActivityUsed[teamA].add(sportName);
          if (teamB && window.todayActivityUsed[teamB]) window.todayActivityUsed[teamB].add(sportName);
        }
      });

      placedLeague = true; break;
    }

    if (!placedLeague) {
      for (const chosenSlot of candidates) {
        const teams = (lg.data.teams || []).map((t) => String(t).trim()).filter(Boolean);
        if (teams.length < 2) break;
        const matchups = window.getLeagueMatchups?.(lg.name, teams) || [];
        if (!matchups.length) break;
        const gamesWithSports = assignSportsToMatchups(lg.name, matchups, lg.data.sports, leagueTeamSportHistory);
        const candidateFields = new Set();
        gamesWithSports.forEach(g => (fieldsBySport[g.sport] || []).forEach(f => candidateFields.add(f)));
        evictAssignmentsOnFields(chosenSlot, spanLen, candidateFields, fieldUsageBySlot);
        
        const avail = {}; allFieldNames.forEach(name => { 
          let cap = 1; 
          for (let k = 0; k < spanLen; k++) { 
            const slot = chosenSlot + k; 
            if ((fieldUsageBySlot[slot]?.[name] || 0) > 0 || window.activityBlockedSlots?.[name]?.has(slot)) { 
              cap = 0; 
              break; 
            } 
          } 
          avail[name] = cap; 
        });
        
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
          for (let k = 0; k < spanLen; k++) {
            const slot = chosenSlot + k; if (slot >= window.unifiedTimes.length) break;
            window.leagueAssignments[div][slot] = (k === 0) ? leagueData : leagueContinuation;
            takenLeagueSlots.add(slot);
            finalGames.forEach(game => { fieldUsageBySlot[slot] = fieldUsageBySlot[slot] || {}; fieldUsageBySlot[slot][game.field] = 2; });
          }
          (finalGames || []).forEach(g => {
            const sportName = g.sport;
            const [teamA, teamB] = g.teams || [];
            if (sportName) {
              if (teamA && window.todayActivityUsed[teamA]) window.todayActivityUsed[teamA].add(sportName);
              if (teamB && window.todayActivityUsed[teamB]) window.todayActivityUsed[teamB].add(sportName);
            }
          });

          placedLeague = true; break;
        }
      }
      if (!placedLeague) console.warn(`Skipping league "${lg.name}": Not enough fields across candidate slots (even after eviction).`);
    }
  }

  // ========================================================
  // ===== 3. SCHEDULE GENERAL/H2H (NEW PRIORITY LOGIC) =====
  // ========================================================
  for (const div of availableDivisions) {
    const isActive = (s) => window.divisionActiveRows?.[div]?.has(s) ?? true;
    const allBunksInDiv = divisions[div]?.bunks || [];

    for (const bunk of allBunksInDiv) {
      for (let s = 0; s < window.unifiedTimes.length; s++) {
        if (scheduleAssignments[bunk][s]) continue;
        if (window.leagueAssignments?.[div]?.[s]) continue;
        if (!isActive(s)) continue;
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
        if (assignedSpan > 0) { s += (assignedSpan - 1); }
      }
    }
  }

  // ===== Post-passes (defined in scheduler_logic_fillers.js) =====
  fillRemainingWithForcedH2HPlus(window.availableDivisions || [], window.divisions || {}, spanLen, h2hActivities, fieldUsageBySlot, activityProperties, h2hHistory, h2hGameCount);
  fillRemainingWithDoublingAggressive(window.availableDivisions || [], window.divisions || {}, spanLen, fieldUsageBySlot, activityProperties);
  fillRemainingWithFallbackSpecials(window.availableDivisions || [], window.divisions || {}, spanLen, fieldUsageBySlot, activityProperties);

  // ===== NEW: Absolute failsafe (no placeholders) =====
  fillAbsolutelyAllCellsNoPlaceholders(window.availableDivisions || [], window.divisions || {}, spanLen, h2hActivities, fieldUsageBySlot, activityProperties, h2hHistory, h2hGameCount);

  updateTable();
  saveSchedule();
}

// ===== Helpers for General/H2H placement =====
function tryGeneralActivity(bunk, div, s, spanLen, activityList, fieldUsageBySlot, isActive, generalActivityHistory, generalFieldHistory, activityProperties) {
  const todayActivityUsed = window.todayActivityUsed || {};
  for (const pick of activityList) {
    const pickedField = fieldLabel(pick.field);
    const activityName = getActivityName(pick); // sport for fields-with-sport, else special/field name

    if (todayActivityUsed[bunk]?.has(activityName)) continue;
    if (generalFieldHistory && generalFieldHistory[bunk][activityName] === pickedField && (window.allSchedulableNames || []).length > 1) continue;

    let [canFit, spanForThisPick] = canActivityFit(bunk, div, s, spanLen, pickedField, fieldUsageBySlot, isActive, activityProperties);
    if (canFit && spanForThisPick > 0) {
      const placed = assignActivity(bunk, s, spanForThisPick, pick, fieldUsageBySlot, generalActivityHistory);
      if (placed > 0) {
        todayActivityUsed[bunk].add(activityName);
      }
      return placed;
    }
  }
  return 0;
}

function tryH2H(bunk, div, s, spanLen, allBunksInDiv, h2hActivities, fieldUsageBySlot, isActive, activityProperties, h2hHistory, h2hGameCount) {
  const todayActivityUsed = window.todayActivityUsed || {};
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
      const sportName = getActivityName(pick); // sport
      if (todayActivityUsed[bunk]?.has(sportName) || todayActivityUsed[opponent]?.has(sportName)) continue;

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
        h2hHistory[bunk][opponent] = (H2H_PROB && h2hHistory[bunk][opponent] || 0) + 1;
        h2hHistory[opponent][bunk] = (H2H_PROB && h2hHistory[opponent][bunk] || 0) + 1;
        h2hGameCount[bunk] = (h2hGameCount[bunk] || 0) + 1;
        h2hGameCount[opponent] = (h2hGameCount[opponent] || 0) + 1;

        todayActivityUsed[bunk].add(sportName);
        todayActivityUsed[opponent].add(sportName);

        return finalSpan;
      }
    }
  }
  return 0;
}


/**
 * ==========================================================
 * ===== THIS IS THE MOST IMPORTANTLY UPDATED FUNCTION =====
 * ==========================================================
 * Replaces the old `canActivityFit` function.
 * This new version understands the `sharableWith` object.
 */
function canActivityFit(bunk, div, s, spanLen, pickedField, fieldUsageBySlot, isActive, activityProperties) {
  let canFitThisPick = true;
  let spanForThisPick = 0;
  
  for (let k = 0; k < spanLen; k++) {
    const currentSlot = s + k;
    if (currentSlot >= window.unifiedTimes.length) { canFitThisPick = false; break; }

    let isBusy = false;

    // 1. Check if bunk is already busy (Trip, League, Inactive)
    if (window.scheduleAssignments[bunk][currentSlot] || window.leagueAssignments?.[div]?.[currentSlot] || !isActive(currentSlot)) {
      isBusy = true;
    }
    
    // 2. Check if the activity itself is time-blocked
    if (!isBusy && window.activityBlockedSlots?.[pickedField]?.has(currentSlot)) {
      isBusy = true;
    }

    // 3. Check if this division is allowed to use this activity at all
    const fieldProps = activityProperties[pickedField];
    if (!isBusy && fieldProps && !fieldProps.allowedDivisions.includes(div)) {
      isBusy = true;
    }
    
    // 4. Check field usage (the sharing logic)
    if (!isBusy && fieldProps) {
      const usage = fieldUsageBySlot[currentSlot]?.[pickedField] || 0;
      
      if (usage === 0) {
        // Field is free. We can take it.
      } 
      else if (usage === 1) {
        // Field is in use by one other bunk. Check if we can share.
        const rules = fieldProps.sharableWith || { type: 'not_sharable' };

        if (rules.type === 'not_sharable') {
          isBusy = true; // In use and not sharable
        } 
        else if (rules.type === 'all') {
          // 'Sharable with All' - we can join.
        }
        else if (rules.type === 'custom') {
          // 'Sharable with Specific...'
          const rules = fieldProps.sharableWith;
          const allowedDivs = rules.divisions || [];
          const allowedBunks = rules.bunks || [];
          
          // Find the current occupant
          const occupant = findOccupantBunk(currentSlot, pickedField);
          
          // Check if *our* bunk/div is in the allowed list
          const weCanShare = allowedDivs.includes(div) || allowedBunks.includes(bunk);
          
          // Check if the *occupant's* bunk/div is *also* in the allowed list
          const theyCanShare = occupant && (allowedDivs.includes(occupant.div) || allowedBunks.includes(occupant.bunk));
          
          if (weCanShare && theyCanShare) {
            // Both parties are in the "club". We can share.
          } else {
            // One or both bunks are not in the allowed sharing list.
            isBusy = true;
          }
        }
      }
      else { // usage >= 2
        isBusy = true; // Field is full
      }
    }

    if (isBusy) { 
      if (k === 0) canFitThisPick = false; // Can't even start
      break; // Stop checking this span
    }
    
    spanForThisPick++;
  }
  
  return [canFitThisPick, spanForThisPick];
}
// ===== END OF REPLACED FUNCTION =====


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
