// -------------------- app2.js (Trips & Overrides) --------------------
// (All logic from FIX 1 to FIX 13 is included)
//
// NEW: Removed Bunk Overrides, added prePlaceTrips() function.
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
  // This compute is for FIXED activities (Lunch, etc)
  // It does NOT include Trips.
  return computeBlockedRowsByDiv();
}

// ===== NEW: Pre-place Daily Trips =====
function prePlaceTrips() {
    const dailyData = window.loadCurrentDailyData?.() || {};
    const trips = dailyData.trips || [];
    if (trips.length === 0) return;
    
    const masterDivisions = (window.loadGlobalSettings?.().app1 || {}).divisions || {};

    trips.forEach(trip => {
        const rows = findRowsForRange(trip.start, trip.end);
        if (rows.length === 0) return;

        let targetBunks = new Set();
        
        // Resolve targets: can be divisions OR bunks
        (trip.targets || []).forEach(target => {
            if (masterDivisions[target]) {
                // It's a division, add all its bunks
                (masterDivisions[target].bunks || []).forEach(b => targetBunks.add(b));
            } else {
                // It's an individual bunk
                targetBunks.add(target);
            }
        });
        
        // Place the trip on the schedule for each bunk
        targetBunks.forEach(bunk => {
            if (!window.scheduleAssignments[bunk]) {
                // This can happen if bunk was in a division that had no time template
                // We'll create the array for it
                window.scheduleAssignments[bunk] = new Array(window.unifiedTimes.length);
            }
            
            rows.forEach((r, idx) => {
                // Overwrite anything (leagues, etc) - trips have top priority
                window.scheduleAssignments[bunk][r] = {
                    field: { name: trip.name },
                    sport: null,
                    continuation: (idx > 0),
                    _fixed: true, // Treat it like a fixed activity
                    _skip: false
                };
            });
        });
    });
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

// ===== League Sport Rotation (UPDATED - FIX 13) =====
let leagueSportRotation = {}; // This will now store history
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
 * RE-WRITTEN assignSportsToMatchups (FIX 13)
 */
function assignSportsToMatchups(leagueName, matchups, sportsList, yesterdayTeamSportHistory) {
  if (!Array.isArray(matchups) || matchups.length === 0) return [];
  if (!Array.isArray(sportsList) || sportsList.length === 0)
    return matchups.map((m) => ({ teams: m, sport: "Leagues" }));

  loadLeagueSportRotation();

  if (!leagueSportRotation[leagueName]) {
      leagueSportRotation[leagueName] = {};
  }
  const leagueHistory = leagueSportRotation[leagueName];

  const assigned = []; 

  for (const match of matchups) {
    const [teamA, teamB] = match;

    const historyA = leagueHistory[teamA] || [];
    const historyB = leagueHistory[teamB] || [];
    const lastSportA = yesterdayTeamSportHistory[teamA];
    const lastSportB = yesterdayTeamSportHistory[teamB];

    let chosenSport = null;

    // 1. Find a "Preferred" sport (not in either team's full history)
    for (const sport of sportsList) {
        if (!historyA.includes(sport) && !historyB.includes(sport)) {
            chosenSport = sport;
            break;
        }
    }

    // 2. If no "new" sport exists, find a "Good" sport (not played *yesterday*)
    if (!chosenSport) {
        for (const sport of sportsList) {
            if (sport !== lastSportA && sport !== lastSportB) {
                chosenSport = sport;
                break;
            }
        }
    }
    
    // 3. If *still* no sport, just pick the first one
    if (!chosenSport) {
        chosenSport = sportsList[0];
    }
    
    // 4. Update the history
    if (!leagueHistory[teamA]) leagueHistory[teamA] = [];
    if (!leagueHistory[teamB]) leagueHistory[teamB] = [];
    
    leagueHistory[teamA].push(chosenSport);
    leagueHistory[teamB].push(chosenSport);

    // 5. If a team has now played all sports, clear its history for the next round
    if (leagueHistory[teamA].length >= sportsList.length) {
        leagueHistory[teamA] = [];
    }
    if (leagueHistory[teamB].length >= sportsList.length) {
        leagueHistory[teamB] = [];
    }
    
    assigned.push({ teams: match, sport: chosenSport });
  }

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
  const overrides = dailyData.overrides || { fields: [], leagues: [] };

  const yesterdayData = window.loadPreviousDailyData?.() || {};
  const yesterdayLeagues = yesterdayData.leagueAssignments || {};
  const yesterdaySchedule = yesterdayData.scheduleAssignments || {};
  
  // ===== 2. Create Today's Filtered Lists =====
  // Fields and Leagues are overridden
  const availFields = masterFields.filter(f => 
      f.available && !overrides.fields.includes(f.name)
  );
  const availSpecials = masterSpecials.filter(s => 
      s.available && !overrides.fields.includes(s.name)
  );
  const enabledByDiv = getEnabledLeaguesByDivision(masterLeagues, overrides);
  
  // Bunks are NOT filtered here anymore. They are pre-scheduled with trips.
  const availableDivisions = [...masterAvailableDivs];
  const divisions = { ...masterDivisions };
  
  window.availableDivisions = availableDivisions;
  window.divisions = divisions;
  
  const inc = parseInt(document.getElementById("increment")?.value || "30", 10);
  const activityDuration = parseInt(
    document.getElementById("activityDuration")?.value || "30",
    10
  );
  const spanLen = Math.max(1, Math.ceil(activityDuration / inc));

  // Create Field-Sport Inventory
  const fieldsBySport = {};
  let allFieldNames = [];
  availFields.forEach(f => {
    allFieldNames.push(f.name);
    if (Array.isArray(f.activities)) {
      f.activities.forEach(sport => {
        fieldsBySport[sport] = fieldsBySport[sport] || [];
        fieldsBySport[sport].push(f.name);
      });
    }
  });

  const allActivities = [
    ...availFields.flatMap((f) =>
      f.activities.map((act) => ({ type: "field", field: f, sport: act }))
    ),
    ...availSpecials.map((sa) => ({
      type: "special",
      field: { name: sa.name },
      sport: null,
    })),
  ];
  const h2hActivities = allActivities.filter(a => a.type === 'field' && a.sport);
  const H2H_CHANCE = 0.10; 

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

  // ===== 3. Pre-place Fixed Activities and Trips =====
  const blockedRowsByDiv = prePlaceFixedActivities(); // Lunch, Swim, etc.
  prePlaceTrips(); // NEW: Daily Trips
  
  // Create Field Reservation System (NOW INCLUDES TRIPS)
  const fieldUsageBySlot = {};
  (availableDivisions || []).forEach(div => {
    (divisions[div]?.bunks || []).forEach(bunk => {
       if (scheduleAssignments[bunk]) {
         scheduleAssignments[bunk].forEach((entry, slot) => {
           if (entry && entry._fixed && entry.field) {
               fieldUsageBySlot[slot] = fieldUsageBySlot[slot] || new Set();
               fieldUsageBySlot[slot].add(fieldLabel(entry.field));
           }
         });
       }
    });
  });

  // ===== 4. Init Activity Histories =====
  const generalActivityHistory = {};
  const generalFieldHistory = {};
  const h2hHistory = {}; 
  const h2hGameCount = {}; 
  
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
  // Pre-populate with TODAY'S fixed activities (Lunch, Trips, etc.)
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
  
  const leagueTeamSportHistory = {};
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

  // ===== 5. Place Leagues =====
  for (const div of availableDivisions) {
    const lg = enabledByDiv[div];
    if (!lg) continue;
    const actSet = window.divisionActiveRows?.[div];
    const actSlots =
      actSet && actSet.size
        ? Array.from(actSet)
        : window.unifiedTimes.map((_, i) => i);

    const bunksInDiv = divisions[div]?.bunks || [];
    const firstBunk = bunksInDiv.length > 0 ? bunksInDiv[0] : null;

    const candidates = actSlots.filter((s) => {
      for (let k = 0; k < spanLen; k++) {
        const slot = s + k;
        if (slot >= window.unifiedTimes.length) return false;
        if (blockedRowsByDiv[div]?.has(slot)) return false;
        if (takenLeagueSlots.has(slot)) return false;
        // Check if the slot is *already* taken by a Trip or Fixed Activity
        if (firstBunk && scheduleAssignments[firstBunk]?.[slot])
          return false;
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

    const availableFieldsForSpan = new Set(allFieldNames);
    for (let k = 0; k < spanLen; k++) {
        const slot = chosenSlot + k;
        if (fieldUsageBySlot[slot]) {
            fieldUsageBySlot[slot].forEach(f => availableFieldsForSpan.delete(f));
        }
    }

    const gamesWithPossibleFields = gamesWithSports.map(game => {
        const possibleFields = (fieldsBySport[game.sport] || [])
            .filter(field => availableFieldsForSpan.has(field));
        return { game, possibleFields };
    });

    gamesWithPossibleFields.sort((a, b) => a.possibleFields.length - b.possibleFields.length);

    const tempReservedFields = new Set();
    const gamesWithFields = gamesWithPossibleFields.map(item => {
        const { game, possibleFields } = item;
        let assignedField = "No Field Available"; 
        
        for (const field of possibleFields) {
            if (!tempReservedFields.has(field)) {
                assignedField = field;
                tempReservedFields.add(field); 
                break;
            }
        }
        return { ...game, field: assignedField };
    });

    window.leagueAssignments[div] = window.leagueAssignments[div] || {};
    const leagueData = { games: gamesWithFields, leagueName: lg.name, isContinuation: false };
    const leagueContinuation = { leagueName: lg.name, isContinuation: true };

    for (let k = 0; k < spanLen; k++) {
      const slot = chosenSlot + k;
      if (slot >= window.unifiedTimes.length) break; 
      
      window.leagueAssignments[div][slot] = (k === 0) ? leagueData : leagueContinuation;
      takenLeagueSlots.add(slot);
      
      gamesWithFields.forEach(game => {
          if (game.field !== "No Field Available") {
              fieldUsageBySlot[slot] = fieldUsageBySlot[slot] || new Set();
              fieldUsageBySlot[slot].add(game.field);
          }
      });
    }
  }

  // ===== 6. Fill General Activities =====
  for (const div of availableDivisions) {
    const isActive = (s) => window.divisionActiveRows?.[div]?.has(s) ?? true;
    const allBunksInDiv = divisions[div]?.bunks || [];

    for (const bunk of allBunksInDiv) {
      for (let s = 0; s < window.unifiedTimes.length; s++) { 
        if (scheduleAssignments[bunk][s]) continue;
        if (window.leagueAssignments?.[div]?.[s]) continue;
        // Bunks on trips are blocked by prePlaceTrips, so this check is valid
        if (blockedRowsByDiv[div]?.has(s)) continue; 
        if (!isActive(s)) continue;

        let assignedSpan = 0;
        let didH2H = false;

        // --- Try H2H ---
        if (h2hGameCount[bunk] < 2 && Math.random() < H2H_CHANCE) {
            
            const opponents = allBunksInDiv.filter(b => {
                if (b === bunk) return false;
                if (scheduleAssignments[b][s]) return false;
                if ((h2hHistory[bunk][b] || 0) >= 1) return false; 
                if (h2hGameCount[b] >= 2) return false;
                return true;
            });

            if (opponents.length > 0) {
                const opponent = opponents[Math.floor(Math.random() * opponents.length)];
                
                const h2hPicks = h2hActivities.filter(pick => {
                    const actName = getActivityName(pick);
                    return !generalActivityHistory[bunk].has(actName) && !generalActivityHistory[opponent].has(actName);
                }).sort(() => 0.5 - Math.random());

                for (const pick of h2hPicks) {
                    const activityName = getActivityName(pick);
                    const pickedField = fieldLabel(pick.field);

                    let canFit = true;
                    let spanForThisPick = 0;
                    for (let k = 0; k < spanLen; k++) {
                        const currentSlot = s + k;
                        if (currentSlot >= window.unifiedTimes.length) { canFit = false; break; }
                        if (
                            scheduleAssignments[bunk][currentSlot] || scheduleAssignments[opponent][currentSlot] ||
                            window.leagueAssignments?.[div]?.[currentSlot] ||
                            blockedRowsByDiv[div]?.[currentSlot] || !isActive(currentSlot) ||
                            (pickedField && fieldUsageBySlot[currentSlot]?.has(pickedField))
                        ) {
                            if (k === 0) canFit = false;
                            break;
                        }
                        spanForThisPick++;
                    }

                    if (canFit && spanForThisPick > 0) {
                        for (let k = 0; k < spanForThisPick; k++) {
                            const currentSlot = s + k;
                            const cont = k > 0;
                            scheduleAssignments[bunk][currentSlot] = {
                                field: pickedField, sport: pick.sport, continuation: cont, _h2h: true, vs: opponent
                            };
                            scheduleAssignments[opponent][currentSlot] = {
                                field: pickedField, sport: pick.sport, continuation: cont, _h2h: true, vs: bunk
                            };
                            if (pickedField) {
                                fieldUsageBySlot[currentSlot] = fieldUsageBySlot[currentSlot] || new Set();
                                fieldUsageBySlot[currentSlot].add(pickedField);
                            }
                        }
                        assignedSpan = spanForThisPick;
                        generalActivityHistory[bunk].add(activityName);
                        generalActivityHistory[opponent].add(activityName);
                        
                        h2hHistory[bunk][opponent] = (h2hHistory[bunk][opponent] || 0) + 1;
                        h2hHistory[opponent][bunk] = (h2hHistory[opponent][bunk] || 0) + 1;
                        h2hGameCount[bunk]++;
                        h2hGameCount[opponent]++;
                        
                        didH2H = true; 
                        break; 
                    }
                }
            }
        }
        
        // --- Fallback to General Activity ---
        if (!didH2H) {
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

            // 1. Try to assign a preferred activity first
            for (const pick of shuffledPreferred) {
                const pickedField = fieldLabel(pick.field);
                let [canFit, spanForThisPick] = canActivityFit(bunk, div, s, spanLen, pickedField, fieldUsageBySlot, isActive, blockedRowsByDiv);
                if (canFit && spanForThisPick > 0) {
                    assignedSpan = assignActivity(bunk, s, spanForThisPick, pick, fieldUsageBySlot, generalActivityHistory);
                    break;
                }
            }

            // 2. If no preferred activity could be scheduled, try a non-preferred one
            if (assignedSpan === 0) {
                for (const pick of shuffledNonPreferred) {
                    const pickedField = fieldLabel(pick.field);
                    const activityName = getActivityName(pick);
                    
                    const yesterdayField = generalFieldHistory[bunk][activityName];
                    if (pickedField === yesterdayField && allFieldNames.length > 1) { 
                        continue; 
                    }
                    
                    let [canFit, spanForThisPick] = canActivityFit(bunk, div, s, spanLen, pickedField, fieldUsageBySlot, isActive, blockedRowsByDiv);
                    if (canFit && spanForThisPick > 0) {
                        assignedSpan = assignActivity(bunk, s, spanForThisPick, pick, fieldUsageBySlot, generalActivityHistory);
                        break;
                    }
                }
            }
        }
        
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
 * Helper for FIX 13: Checks if a general activity can fit in a slot.
 */
function canActivityFit(bunk, div, s, spanLen, pickedField, fieldUsageBySlot, isActive, blockedRowsByDiv) {
    let canFitThisPick = true;
    let spanForThisPick = 0;

    for (let k = 0; k < spanLen; k++) {
        const currentSlot = s + k;
        if (currentSlot >= window.unifiedTimes.length) break; 

        if (
            window.scheduleAssignments[bunk][currentSlot] || 
            window.leagueAssignments?.[div]?.[currentSlot] ||
            blockedRowsByDiv[div]?.[currentSlot] ||
            !isActive(currentSlot) ||
            (pickedField && fieldUsageBySlot[currentSlot]?.has(pickedField))
        ) {
            if (k === 0) canFitThisPick = false; 
            break; 
        }
        spanForThisPick++;
    }
    return [canFitThisPick, spanForThisPick];
}

/**
 * Helper for FIX 13: Assigns a general activity to the schedule.
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
        if (pickedField) {
            fieldUsageBySlot[currentSlot] = fieldUsageBySlot[currentSlot] || new Set();
            fieldUsageBySlot[currentSlot].add(pickedField);
        }
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

      if (league) {
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
            .map((g) => `${g.teams[0]} vs ${g.teams[1]} (${g.sport}) @ ${g.field}`)
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
