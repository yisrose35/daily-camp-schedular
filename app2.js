// -------------------- app2.js (Cross-Day Memory FIX) --------------------
// (All logic from FIX 1 to FIX 12 is included)
// FIX 13 (Re-integrated): Add cross-day "memory".
// - Leagues will avoid back-to-back sports.
// - General activities will avoid yesterday's activities.
// - BUGFIX: Correctly rotate sports in 'assignSportsToMatchups'.
// - UPDATED: Now uses calendar.js to save/load per-day.
// - NEW BUGFIX: Inherit yesterday's sport rotation state.
//
// =================================================================
 
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
    if (hh === 12) hh = mer === "am" ? 0 : 12;
    else if (mer === "pm") hh += 12;
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
    if (pick.sport) {
        return pick.sport; // e.g., "Basketball"
    }
    return fieldLabel(pick.field); // e.g., "gameroom"
}
 
// ===== Fixed Activities =====
function loadActiveFixedActivities() {
  const globalSettings = window.loadGlobalSettings?.() || {};
  const allFixed = globalSettings.fixedActivities || [];
  return Array.isArray(allFixed) ? allFixed.filter((a) => a && a.enabled) : [];
}
function findRowsForRange(startStr, endStr) {
  if (!Array.isArray(window.unifiedTimes) || window.unifiedTimes.length === 0)
    return [];
  const startMin = parseTimeToMinutes(startStr),
    endMin = parseTimeToMinutes(endStr);
  if (startMin == null || endMin == null || endMin <= startMin) return [];
  const inside = [];
  for (let i = 0; i < window.unifiedTimes.length; i++) {
    const r = window.unifiedTimes[i],
      rs = r.start.getHours() * 60 + r.start.getMinutes(),
      re = r.end.getHours() * 60 + r.end.getMinutes();
    if (rs >= startMin && re <= endMin) inside.push(i);
  }
  if (inside.length === 0) {
    const overlap = [];
    for (let i = 0; i < window.unifiedTimes.length; i++) {
      const r = window.unifiedTimes[i],
        rs = r.start.getHours() * 60 + r.start.getMinutes(),
        re = r.end.getHours() * 60 + r.end.getMinutes();
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
    const targetDivs =
      Array.isArray(act.divisions) && act.divisions.length > 0
        ? act.divisions
        : window.availableDivisions || [];
    targetDivs.forEach((div) => {
      blocked[div] = blocked[div] || new Set();
      rows.forEach((r) => blocked[div].add(r));
    });
  });
  return blocked;
}
function prePlaceFixedActivities() {
  if (window.DailyActivities?.prePlace) {
    try {
      window.DailyActivities.prePlace();
    } catch (e) {
      console.error("DailyActivities.prePlace error:", e);
    }
  }
  return computeBlockedRowsByDiv();
}
 
// ===== League Helpers =====
function leaguesSnapshot() {
  return window.loadGlobalSettings?.().leaguesByName || {};
}
function getEnabledLeaguesByDivision(masterLeagues, overrides) {
  const result = {};
  const all = masterLeagues || {};
  
 Object.keys(all).forEach((name) => {
    if (overrides.leagues.includes(name)) return; 
    
    const l = all[name];
    if (!l?.enabled) return;
    (l.divisions || []).forEach((div) => {
      result[div] = { name, data: l };
    });
  });
  return result;
}
 
// ===== League Sport Rotation (UPDATED) =====
let leagueSportRotation = {};
function loadLeagueSportRotation() {
  try {
    // 1. Try to load THIS day's data
    if (window.currentDailyData && window.currentDailyData.leagueSportRotation && Object.keys(window.currentDailyData.leagueSportRotation).length > 0) {
        leagueSportRotation = window.currentDailyData.leagueSportRotation;
    } 
    // 2. If this day is blank, load YESTERDAY'S data
    else if (window.loadPreviousDailyData) {
        console.log("No sport rotation for today. Loading from yesterday.");
        const yesterdayData = window.loadPreviousDailyData();
        leagueSportRotation = yesterdayData.leagueSportRotation || {};
        
        // IMPORTANT: Save this inherited state to the CURRENT day
        saveLeagueSportRotation();
    }
    else {
        leagueSportRotation = {};
    }
  } catch(e) {
   console.error("Failed to load league sport rotation:", e);
   leagueSportRotation = {};
  }
}
function saveLeagueSportRotation() {
  try {
   window.saveCurrentDailyData?.("leagueSportRotation", leagueSportRotation);
  } catch {}
}
 
/**
 * UPDATED assignSportsToMatchups (FIX 13 + BUGFIX)
 * Now takes history to avoid back-to-back sports.
 */
function assignSportsToMatchups(leagueName, matchups, sportsList, yesterdayHistory) {
  if (!Array.isArray(matchups) || matchups.length === 0) return [];
  if (!Array.isArray(sportsList) || sportsList.length === 0)
    return matchups.map((m) => ({ teams: m, sport: "Leagues" }));

  loadLeagueSportRotation(); // This now correctly loads yesterday's state if today is new
  const state = leagueSportRotation[leagueName] || { index: 0 };
  let idx = state.index;
  
  const assigned = [];

  for (const match of matchups) {
    const [teamA, teamB] = match;
    const lastSportA = yesterdayHistory[teamA];
    const lastSportB = yesterdayHistory[teamB];

    let chosenSport = null;

    // 1. Try to find a "preferred" sport (one neither team played)
    for (let i = 0; i < sportsList.length; i++) {
        const sportIdx = (idx + i) % sportsList.length; 
        const sport = sportsList[sportIdx];
        if (sport !== lastSportA && sport !== lastSportB) {
            chosenSport = sport;
            idx = sportIdx + 1; 
            break;
        }
    }

    // 2. If no preferred sport is found, relax the rule and just pick the next one
    if (!chosenSport) {
        chosenSport = sportsList[idx % sportsList.length];
        idx++; 
    }
    
    assigned.push({ teams: match, sport: chosenSport });
  }

  leagueSportRotation[leagueName] = { index: idx % sportsList.length };
  saveLeagueSportRotation();
  return assigned;
}
 
// ====== CORE ASSIGN ======
window.leagueAssignments = window.leagueAssignments || {};
 
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
  
  // Safely initialize the overrides object
  const loadedOverrides = dailyData.overrides || {};
  const overrides = {
      fields: loadedOverrides.fields || [],
      bunks: loadedOverrides.bunks || [],
      leagues: loadedOverrides.leagues || []
  };

  // ===== NEW (FIX 13): Load *Yesterday's* Data =====
  const yesterdayData = window.loadPreviousDailyData?.() || {};
  const yesterdayLeagues = yesterdayData.leagueAssignments || {};
  const yesterdaySchedule = yesterdayData.scheduleAssignments || {};
  // ===============================================

  // 3. Create Today's Filtered Lists
  const availFields = masterFields.filter(f => 
     f.available && !overrides.fields.includes(f.name)
  );
  const availSpecials = masterSpecials.filter(s => 
     s.available && !overrides.fields.includes(s.name)
  );
  
  const availableDivisions = masterAvailableDivs.filter(divName => {
      return !overrides.bunks.includes(divName);
  });
  
  const divisions = {};
  for (const divName of availableDivisions) {
      if (!masterDivisions[divName]) continue; // Safety check
      divisions[divName] = JSON.parse(JSON.stringify(masterDivisions[divName]));
      divisions[divName].bunks = (divisions[divName].bunks || []).filter(bunkName => 
         !overrides.bunks.includes(bunkName)
      );
  }
  
  window.availableDivisions = availableDivisions; // This is the filtered list for *today*
  window.divisions = divisions;
  
  const allGlobalDivisions = app1Data.availableDivisions || masterAvailableDivs; // This is the master list from Setup

  // =============================================
  // ===== START OF NEW SHARABLE LOGIC =====
  // =============================================
  // Create a lookup map for activity properties (sharable, allowedDivisions)
  const activityProperties = {};
  
  availFields.forEach(f => {
    activityProperties[f.name] = {
        sharable: f.sharable || false,
        // If allowedDivisions is empty, it means "all divisions"
        allowedDivisions: (f.allowedDivisions || []).length > 0 ? f.allowedDivisions : allGlobalDivisions
    };
  });
  availSpecials.forEach(s => {
    activityProperties[s.name] = {
        sharable: s.sharable || false,
        allowedDivisions: (s.allowedDivisions || []).length > 0 ? s.allowedDivisions : allGlobalDivisions
    };
  });
  // =============================================
  // ===== END OF NEW SHARABLE LOGIC =====
  // =============================================

  const enabledByDiv = getEnabledLeaguesByDivision(masterLeagues, overrides);

  const inc = parseInt(document.getElementById("increment")?.value || "30", 10);
  const activityDuration = parseInt(
    document.getElementById("activityDuration")?.value || "30",
    10
  );
  const spanLen = Math.max(1, Math.ceil(activityDuration / inc));

  // Create Field-Sport Inventory
  const fieldsBySport = {};
  const allFieldNames = []; // This list ONLY contains fields, not special activities
  availFields.forEach(f => {
    allFieldNames.push(f.name);
    if (Array.isArray(f.activities)) {
      f.activities.forEach(sport => {
        fieldsBySport[sport] = fieldsBySport[sport] || [];
        fieldsBySport[sport].push(f.name);
      });
    }
  });
  
  // This list includes all schedulable activity names (fields AND specials)
  const allSchedulableNames = allFieldNames.concat(availSpecials.map(s => s.name));

  const allActivities = [
    ...availFields.flatMap((f) =>
      f.activities.map((act) => ({ type: "field", field: f, sport: act }))
    ),
    ...availSpecials.map((sa) => ({
      type: "special",
      field: sa, // Pass the whole object
      sport: null,
    })),
  ];
  const h2hActivities = allActivities.filter(a => a.type === 'field' && a.sport);
 
  if ((!allActivities.length && !availSpecials.length) || !window.unifiedTimes || window.unifiedTimes.length === 0) {
      console.warn("Cannot assign fields: No activities or unified times are set. Did you click 'Generate Schedule Times'?");
       updateTable(); 
       return;
  }

  // Init grids
  scheduleAssignments = {};
  availableDivisions.forEach((d) =>
    (divisions[d]?.bunks || []).forEach(
      (b) => (scheduleAssignments[b] = new Array(window.unifiedTimes.length))
    )
  );
  window.scheduleAssignments = scheduleAssignments; 
  
  const blockedRowsByDiv = prePlaceFixedActivities();

  // Create Field Reservation System (NOW TRACKS COUNTS)
  // fieldUsageBySlot = { 0: {"Gym": 2, "Field A": 1}, 1: ... }
  const fieldUsageBySlot = {};
  (availableDivisions || []).forEach(div => {
    (divisions[div]?.bunks || []).forEach(bunk => {
       if (scheduleAssignments[bunk]) {
         scheduleAssignments[bunk].forEach((entry, slot) => {
           if (entry && entry._fixed && entry.field) {
               const fieldName = fieldLabel(entry.field);
               // Only track usage for "real" fields/activities
               if (allSchedulableNames.includes(fieldName)) {
                  fieldUsageBySlot[slot] = fieldUsageBySlot[slot] || {};
                  // A fixed activity takes ALL capacity of the field. Mark it as full (e.g., 2).
                  fieldUsageBySlot[slot][fieldName] = 2; 
               }
           }
         });
       }
    });
  });

  // ===== Init Activity Histories =====
  const generalActivityHistory = {}; // { Bunk1: Set("Basketball", "Gameroom") }
  const generalFieldHistory = {}; // { Bunk1: { "Basketball": "f1" } }
  const h2hHistory = {}; 
  const h2hGameCount = {}; 
  
  // Pre-populate history with YESTERDAY'S general activities
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
  // Pre-populate with TODAY'S fixed activities
  availableDivisions.forEach(div => {
    (divisions[div]?.bunks || []).forEach(bunk => {
       if (scheduleAssignments[bunk]) {
         scheduleAssignments[bunk].forEach((entry) => {
           if (entry && entry._fixed) {
             generalActivityHistory[bunk].add(fieldLabel(entry.field));
           }
         });
       }
    });
  });
  
  // Create Yesterday's League Sport History
  const leagueTeamSportHistory = {}; // { "Team A": "Basketball" }
  Object.values(yesterdayLeagues).forEach(div => {
      Object.values(div).forEach(slot => {
          if (slot.games && !slot.isContinuation) {
              slot.games.forEach(game => {
                  leagueTeamSportHistory[game.teams[0]] = game.sport;
                  leagueTeamSportHistory[game.teams[1]] = game.sport;
              });
          }
      });
  });

  const takenLeagueSlots = new Set(); 
 
  // --- ===== FIX 7 & 13: Smart Field-First League Scheduling ===== ---
  for (const div of availableDivisions) {
    const lg = enabledByDiv[div];
    if (!lg) continue;
    const actSet = window.divisionActiveRows?.[div];
    const actSlots =
      actSet && actSet.size
        ? Array.from(actSet)
        : window.unifiedTimes.map((_, i) => i);

    const bunksInDiv = divisions[div]?.bunks || [];
    
    // Correctly check if *any* bunk is busy with a fixed activity
    const candidates = actSlots.filter((s) => {
      for (let k = 0; k < spanLen; k++) {
        const slot = s + k;
        if (slot >= window.unifiedTimes.length) return false;
        
        let isBunkBusy = false;
        for (const bunk of bunksInDiv) {
          if (scheduleAssignments[bunk]?.[slot]) { 
            isBunkBusy = true;
            break;
          }
        }
        if (isBunkBusy) return false;

        if (takenLeagueSlots.has(slot)) return false;
      }
      return true;
    });
    
    if (!candidates.length) continue; 

    const chosenSlot = candidates[0]; 

    const teams = (lg.data.teams || [])
      .map((t) => String(t).trim())
      .filter(Boolean);
    if (teams.length < 2) continue;
    const matchups = window.getLeagueMatchups?.(lg.name, teams) || [];
    if (!matchups.length) continue;
    
    const gamesWithSports = assignSportsToMatchups(
      lg.name,
      matchups,
      lg.data.sports,
      leagueTeamSportHistory
    );

    // =============================================
    // ===== START OF LEAGUE SHARABLE FIX =====
    // =============================================
    
    // Check for available fields for this specific slot SPAN
    // LEAGUES ARE NOT SHARABLE. Capacity is 1.
    const availableFieldsForSpan = {}; // e.g., {"Gym": 1, "Field A": 0}
    allFieldNames.forEach(name => {
        let capacity = 1; // Leagues ALWAYS have capacity 1

        for (let k = 0; k < spanLen; k++) {
            const slot = chosenSlot + k;
            const usage = fieldUsageBySlot[slot]?.[name] || 0;
            if (usage > 0) { // If it's used AT ALL, it's unavailable for a league
                 capacity = 0;
                 break;
            }
        }
        availableFieldsForSpan[name] = capacity; // Will be 1 (free) or 0 (busy)
    });


    const gamesWithPossibleFields = gamesWithSports.map(game => {
        const possibleFields = (fieldsBySport[game.sport] || [])
            .filter(fieldName => (availableFieldsForSpan[fieldName] || 0) > 0);
        return { game, possibleFields };
    });

    gamesWithPossibleFields.sort((a, b) => a.possibleFields.length - b.possibleFields.length);

    const tempReservedFields = {}; // { "Gym": 1, "Field A": 1 }
    let allGamesCanBeScheduled = true;
    const gamesWithFields = gamesWithPossibleFields.map(item => {
        const { game, possibleFields } = item;
        let assignedField = null; 
        
        for (const fieldName of possibleFields) {
            // Check if it's free in our main list AND our temp list
            if ((availableFieldsForSpan[fieldName] || 0) > 0 && !tempReservedFields[fieldName]) {
                assignedField = fieldName;
                tempReservedFields[fieldName] = 1; // Mark as used
                break;
            }
        }

        if (!assignedField) {
            allGamesCanBeScheduled = false;
        }
        return { ...game, field: assignedField };
    });
    // =============================================
    // ===== END OF LEAGUE SHARABLE FIX =====
    // =============================================

    if (!allGamesCanBeScheduled) {
      console.warn(`Skipping league "${lg.name}" at slot ${chosenSlot}: Not enough fields.`);
      continue; 
    }

    // All games have fields! Now, book them.
    window.leagueAssignments[div] = window.leagueAssignments[div] || {};
    const leagueData = { games: gamesWithFields, leagueName: lg.name, isContinuation: false };
    const leagueContinuation = { leagueName: lg.name, isContinuation: true };

    for (let k = 0; k < spanLen; k++) {
      const slot = chosenSlot + k;
      if (slot >= window.unifiedTimes.length) break; 
      
      window.leagueAssignments[div][slot] = (k === 0) ? leagueData : leagueContinuation;
      takenLeagueSlots.add(slot);
      
      // Add these fields to the main reservation system
      gamesWithFields.forEach(game => {
          if (game.field) {
              fieldUsageBySlot[slot] = fieldUsageBySlot[slot] || {};
              // TAKE THE WHOLE FIELD. SET USAGE TO 2 (MAX)
              fieldUsageBySlot[slot][game.field] = 2; 
          }
      });
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
        // Skip if slot is already filled
        if (scheduleAssignments[bunk][s]) continue;
        if (window.leagueAssignments?.[div]?.[s]) continue;
        // blockedRowsByDiv check is redundant, as scheduleAssignments is populated by it
        if (!isActive(s)) continue;

        let assignedSpan = 0;
 
        // --- 1. Create preferred/non-preferred lists ---
        const preferredPicks = [];
        const nonPreferredPicks = [];
        allActivities.forEach(pick => {
            if (generalActivityHistory[bunk].has(getActivityName(pick))) {
                nonPreferredPicks.push(pick);
            } else {
                preferredPicks.push(pick);
            }
        });
        const shuffledPreferred = preferredPicks.sort(() => 0.5 - Math.random());
        const shuffledNonPreferred = nonPreferredPicks.sort(() => 0.5 - Math.random());

        // --- 2. Try to assign a PREFERRED activity first ---
        assignedSpan = tryGeneralActivity(bunk, div, s, spanLen, shuffledPreferred, fieldUsageBySlot, isActive, generalActivityHistory, generalFieldHistory, activityProperties);

        // --- 3. If PREFERRED fails, try H2H (by necessity) ---
        if (assignedSpan === 0 && h2hGameCount[bunk] < 2) {
            assignedSpan = tryH2H(bunk, div, s, spanLen, allBunksInDiv, h2hActivities, fieldUsageBySlot, isActive, activityProperties);
        }
        
        // --- 4. If BOTH preferred and H2H fail, use NON-PREFERRED ---
        if (assignedSpan === 0) {
            assignedSpan = tryGeneralActivity(bunk, div, s, spanLen, shuffledNonPreferred, fieldUsageBySlot, isActive, generalActivityHistory, generalFieldHistory, activityProperties);
        }

        // --- 5. Advance the time slot ---
        if (assignedSpan > 0) {
          s += (assignedSpan - 1);
        }
      }
    }
  }
 
  updateTable();
  saveSchedule();
}
 
/**
 * Helper: Tries to schedule a General Activity
 */
function tryGeneralActivity(bunk, div, s, spanLen, activityList, fieldUsageBySlot, isActive, generalActivityHistory, generalFieldHistory, activityProperties) {
    for (const pick of activityList) {
        const pickedField = fieldLabel(pick.field);
        const activityName = getActivityName(pick);

        // Check if this is a non-preferred activity that used the same field yesterday
        if (generalFieldHistory && generalFieldHistory[bunk][activityName] === pickedField && allSchedulableNames.length > 1) {
            continue; // Skip this, try another field
        }

        let [canFit, spanForThisPick] = canActivityFit(bunk, div, s, spanLen, pickedField, fieldUsageBySlot, isActive, activityProperties);
        if (canFit && spanForThisPick > 0) {
            return assignActivity(bunk, s, spanForThisPick, pick, fieldUsageBySlot, generalActivityHistory);
        }
    }
    return 0; // No activity from this list could be scheduled
}

/**
 * Helper: Tries to schedule an H2H game
 */
function tryH2H(bunk, div, s, spanLen, allBunksInDiv, h2hActivities, fieldUsageBySlot, isActive, activityProperties) {
    const opponents = allBunksInDiv.filter(b => {
        if (b === bunk) return false;
        if (scheduleAssignments[b][s]) return false; // Opponent must be free
        if ((h2hHistory[bunk][b] || 0) >= 1) return false; // No rematches
        if (h2hGameCount[b] >= 2) return false; // Opponent must be under H2H limit
        
        if (window.leagueAssignments?.[div]?.[s]) return false;
        return true;
    });

    if (opponents.length > 0) {
        const opponent = opponents[Math.floor(Math.random() * opponents.length)];
        const h2hPicks = h2hActivities.sort(() => 0.5 - Math.random());

        for (const pick of h2hPicks) {
            const activityName = getActivityName(pick);
            const pickedField = fieldLabel(pick.field);

            let [canFit, spanForThisPick] = canActivityFit(bunk, div, s, spanLen, pickedField, fieldUsageBySlot, isActive, activityProperties);
            let [oppCanFit, oppSpan] = canActivityFit(opponent, div, s, spanLen, pickedField, fieldUsageBySlot, isActive, activityProperties);
            
            const finalSpan = Math.min(spanForThisPick, oppSpan);

            if (canFit && oppCanFit && finalSpan > 0) {
                // Assign to BOTH bunks
                for (let k = 0; k < finalSpan; k++) {
                    const currentSlot = s + k;
                    const cont = k > 0;
                    scheduleAssignments[bunk][currentSlot] = {
                        field: pickedField, sport: pick.sport, continuation: cont, _h2h: true, vs: opponent
                    };
                    scheduleAssignments[opponent][currentSlot] = {
                        field: pickedField, sport: pick.sport, continuation: cont, _h2h: true, vs: bunk
                    };
                    if (pickedField && allSchedulableNames.includes(pickedField)) { // Check if it's a real field/activity
                        fieldUsageBySlot[currentSlot] = fieldUsageBySlot[currentSlot] || {};
                        fieldUsageBySlot[currentSlot][pickedField] = (fieldUsageBySlot[currentSlot][pickedField] || 0) + 1;
                    }
                }
                generalActivityHistory[bunk].add(activityName);
                generalActivityHistory[opponent].add(activityName);
                
                h2hHistory[bunk][opponent] = (h2hHistory[bunk][opponent] || 0) + 1;
                h2hHistory[opponent][bunk] = (h2hHistory[opponent][bunk] || 0) + 1;
                h2hGameCount[bunk]++;
                h2hGameCount[opponent]++;
                
                return finalSpan; // Return the span, which is > 0
            }
        }
    }
    return 0; // No H2H game could be scheduled
}
 
/**
 * Helper: Checks if a general activity can fit in a slot.
 */
function canActivityFit(bunk, div, s, spanLen, pickedField, fieldUsageBySlot, isActive, activityProperties) {
    let canFitThisPick = true;
    let spanForThisPick = 0;

    for (let k = 0; k < spanLen; k++) {
        const currentSlot = s + k;
        if (currentSlot >= window.unifiedTimes.length) { 
            canFitThisPick = false; 
            break; 
        }

        let isBusy = false;

        if (
            window.scheduleAssignments[bunk][currentSlot] || // Bunk is busy (e.g., fixed)
            window.leagueAssignments?.[div]?.[currentSlot] || // Division is busy (league)
            !isActive(currentSlot) // Bunk is not active at this time
        ) {
            isBusy = true;
        }

        // =============================================
        // ===== START OF NEW SHARABLE LOGIC (CHECK) =====
        // =============================================
        if (!isBusy && pickedField && activityProperties[pickedField]) { // Check if it's a real field/activity
            const fieldProps = activityProperties[pickedField];
            const usage = fieldUsageBySlot[currentSlot]?.[pickedField] || 0;
            
            if (usage > 0) { // Field is in use
                if (!fieldProps.sharable || usage >= 2) {
                    isBusy = true; // Field is not sharable or is full
                } else if (!fieldProps.allowedDivisions.includes(div)) {
                    isBusy = true; // Field is sharable, but not for this division
                }
                // else: field is sharable (usage=1), has space (max=2), and this div is allowed.
            }
        }
        // =============================================
        // ===== END OF NEW SHARABLE LOGIC (CHECK) =====
        // =============================================

        if (isBusy) {
            // =============================================
            // ===== START OF BUG FIX =====
            // =============================================
            if (k === 0) canFitThisPick = false; // This was the typo. It's now fixed.
            // =============================================
            // ===== END OF BUG FIX =====
            // =============================================
            break; 
        }
        spanForThisPick++;
    }
    return [canFitThisPick, spanForThisPick];
}
 
/**
 * Helper: Assigns a general activity to the schedule.
 */
function assignActivity(bunk, s, spanForThisPick, pick, fieldUsageBySlot, generalActivityHistory) {
    const pickedField = fieldLabel(pick.field);
    const activityName = getActivityName(pick);
    
    for (let k = 0; k < spanForThisPick; k++) {
        const currentSlot = s + k;
        window.scheduleAssignments[bunk][currentSlot] = {
            field: pickedField,
            sport: pick.sport,
            continuation: (k > 0),
        };
        // =============================================
        // ===== START OF NEW SHARABLE LOGIC (ASSIGN) =====
        // =============================================
        if (pickedField && allSchedulableNames.includes(pickedField)) { // Only track real fields/activities
            fieldUsageBySlot[currentSlot] = fieldUsageBySlot[currentSlot] || {};
            fieldUsageBySlot[currentSlot][pickedField] = (fieldUsageBySlot[currentSlot][pickedField] || 0) + 1;
        }
        // =============================================
        // ===== END OF NEW SHARABLE LOGIC (ASSIGN) =====
        // =============================================
    }
    generalActivityHistory[bunk].add(activityName); // Add to *today's* history
    return spanForThisPick;
}
 
 
// ===== RENDERING (per-division grey-out) =====
function updateTable() {
  const container = document.getElementById("scheduleTable");
  if (!container) return;
  container.innerHTML = "";
  
  if (!window.unifiedTimes || !window.unifiedTimes.length) return;
  
  const availableDivisions = window.availableDivisions || [];
  const divisions = window.divisions || {};
  const unifiedTimes = window.unifiedTimes || [];
  
  const table = document.createElement("table");
 
  // Header
  const thead = document.createElement("thead");
  const tr1 = document.createElement("tr");
  const thTime = document.createElement("th");
  thTime.textContent = "Time";
  tr1.appendChild(thTime);
  availableDivisions.forEach((div) => {
    const th = document.createElement("th");
    th.colSpan = (divisions[div]?.bunks || []).length;
    th.textContent = div;
    th.style.background = divisions[div]?.color || "#333";
    th.style.color = "#fff";
    tr1.appendChild(th);
  });
  thead.appendChild(tr1);
 
  const tr2 = document.createElement("tr");
  const bunkTh = document.createElement("th");
  bunkTh.textContent = "Bunk";
  tr2.appendChild(bunkTh);
  availableDivisions.forEach((div) => {
    (divisions[div]?.bunks || []).forEach((b) => {
      const th = document.createElement("th");
      th.textContent = b;
      tr2.appendChild(th);
    });
  });
  thead.appendChild(tr2);
  table.appendChild(thead);
 
  const tbody = document.createElement("tbody");
  const divTimeRanges = {};
  availableDivisions.forEach((div) => {
    const s = parseTimeToMinutes(divisions[div]?.start);
    const e = parseTimeToMinutes(divisions[div]?.end);
    divTimeRanges[div] = { start: s, end: e };
  });
 
  for (let i = 0; i < unifiedTimes.length; i++) {
    const tr = document.createElement("tr");
    const tdTime = document.createElement("td");
    tdTime.textContent = unifiedTimes[i].label;
    tr.appendChild(tdTime);
 
    const mid =
      (unifiedTimes[i].start.getHours() * 60 +
        unifiedTimes[i].start.getMinutes() +
        unifiedTimes[i].end.getHours() * 60 +
        unifiedTimes[i].end.getMinutes()) /
      2;
 
    availableDivisions.forEach((div) => {
      const { start, end } = divTimeRanges[div];
      const outside =
        (start != null && mid < start) || (end != null && mid >= end);
      const league = window.leagueAssignments?.[div]?.[i];
      const bunks = divisions[div]?.bunks || [];
 
      if (outside) {
        let covered = false;
        if (i > 0) {
            const prevMid = (unifiedTimes[i - 1].start.getHours() * 60 + unifiedTimes[i - 1].start.getMinutes() +
                             unifiedTimes[i - 1].end.getHours() * 60 + unifiedTimes[i - 1].end.getMinutes()) / 2;
            const prevOutside = (start != null && prevMid < start) || (end != null && prevMid >= end);
            if (prevOutside) covered = true;
        }
        if (!covered) {
            let span = 1;
            for (let j = i + 1; j < unifiedTimes.length; j++) {
                const nextMid = (unifiedTimes[j].start.getHours() * 60 + unifiedTimes[j].start.getMinutes() +
                                 unifiedTimes[j].end.getHours() * 60 + unifiedTimes[j].end.getMinutes()) / 2;
                const nextOutside = (start != null && nextMid < start) || (end != null && nextMid >= end);
                if (nextOutside) {
                    span++;
                } else {
                    break;
                }
            }
            const td = document.createElement("td");
            td.colSpan = bunks.length;
            td.rowSpan = span;
            td.className = "grey-cell";
            td.style.background = "#ddd";
            td.textContent = "—";
    
            tr.appendChild(td);
        }
        return; 
      }
 
      // Check for fixed activity on the *first bunk*
      const firstBunk = bunks.length > 0 ? bunks[0] : null;
      const fixedEntry = firstBunk ? window.scheduleAssignments[firstBunk]?.[i] : null;

      if (fixedEntry && fixedEntry._fixed && !fixedEntry.continuation) {
          // This slot is a fixed activity. Render it for the whole division.
          let span = 1;
          for (let j = i + 1; j < unifiedTimes.length; j++) {
            if (window.scheduleAssignments[firstBunk]?.[j]?.continuation) span++;
            else break;
          }
          const td = document.createElement("td");
          td.rowSpan = span;
          td.colSpan = bunks.length;
          td.textContent = fieldLabel(fixedEntry.field);
          td.style.background = "#f1f1f1";
          td.style.fontWeight = "600";
          td.style.verticalAlign = "top";
          tr.appendChild(td);
      
      } else if (league) {
        if (league.isContinuation) {
        } else {
          let span = 1;
          for (let j = i + 1; j < unifiedTimes.length; j++) {
            if (window.leagueAssignments?.[div]?.[j]?.isContinuation) {
              span++;
            } else {
              break; 
            }
          }
          const td = document.createElement("td");
          td.colSpan = bunks.length;
          td.rowSpan = span; 
          td.style.background = divisions[div]?.color || "#4CAF50";
          td.style.color = "#fff";
          td.style.fontWeight = "600";
          td.style.verticalAlign = "top"; 
 
          const list = league.games
            .map((g) => {
                const gameField = g.field ? `@ ${g.field}` : "@ No Field";
                return `${g.teams[0]} vs ${g.teams[1]} (${g.sport}) ${gameField}`
            })
            .join("<br> • ");
 
          td.innerHTML = `<div class="league-pill">${list}<br><span style="font-size:0.85em;">${league.leagueName}</span></div>`;
          tr.appendChild(td);
        }
      } else {
        bunks.forEach((b) => {
          const entry = window.scheduleAssignments[b]?.[i];
 
          if (!entry) {
            const td = document.createElement("td");
            tr.appendChild(td); 
            return; 
          }
 
          if (entry.continuation) {
            return; 
          }
 
          let span = 1;
          for (let j = i + 1; j < unifiedTimes.length; j++) {
            if (window.scheduleAssignments[b]?.[j]?.continuation) {
              span++;
            } else {
              break;
            }
          }
 
          const td = document.createElement("td");
          td.rowSpan = span; 
          td.style.verticalAlign = "top"; 
 
          if (entry._h2h) {
            td.textContent = `${entry.sport} ${entry.field} vs ${entry.vs}`;
            td.style.background = "#e8f4ff"; 
            td.style.fontWeight = "bold";
          } 
          else if (entry._fixed) {
            // This should no longer be hit, but is a safe fallback
            td.textContent = fieldLabel(entry.field);
            td.style.background = "#f1f1f1";
            td.style.fontWeight = "600";
          } else if (
            fieldLabel(entry.field) === "Special Activity Needed"
          ) {
            td.innerHTML = `<span style="color:#c0392b;">${fieldLabel(
              entry.field
            )}</span>`;
          } else if (entry.sport) {
            td.textContent = `${fieldLabel(entry.field)} – ${entry.sport}`;
          } else {
            td.textContent = fieldLabel(entry.field);
          }
          tr.appendChild(td);
        });
      }
    });
 
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}
 
// ===== Save/Init (UPDATED) =====
function saveSchedule() {
  try {
    // UPDATED: Save to the current day
    window.saveCurrentDailyData?.("scheduleAssignments", window.scheduleAssignments);
    window.saveCurrentDailyData?.("leagueAssignments", window.leagueAssignments);
  } catch (e) {
    console.error("Save schedule failed:", e);
  }
}
function reconcileOrRenderSaved() {
  try {
    // UPDATED: Load from the current day
    const data = window.loadCurrentDailyData?.() || {};
    window.scheduleAssignments = data.scheduleAssignments || {};
    window.leagueAssignments = data.leagueAssignments || {};
  } catch {
     window.scheduleAssignments = {};
     window.leagueAssignments = {};
  }
  updateTable();
}
 
function initScheduleSystem() {
  try {
    // This is the main load function for the schedule tab
    reconcileOrRenderSaved();
  } catch (e) {
    console.error("Init error:", e);
    updateTable();
  }
}
 
window.assignFieldsToBunks = assignFieldsToBunks;
window.updateTable = updateTable;
window.initScheduleSystem = initScheduleSystem;
 
// This is now called by calendar.js when the date changes
// or by generateTimes() in app1.js
