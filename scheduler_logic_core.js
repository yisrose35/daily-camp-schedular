// -------------------- scheduler_logic_core.js --------------------
// Core logic: helpers, fixed-activity plumbing, league helpers/rotation,
// uniqueness rules, and primary scheduling (assignFieldsToBunks).

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
  if (window.DailyActivities?.prePlace) {
    try { window.DailyActivities.prePlace(); } catch (e) { console.error("DailyActivities.prePlace error:", e); }
  }
  return computeBlockedRowsByDiv();
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
  try { window.saveCurrentDailyData?.("leagueSportRotation", leagueSportRotation); } catch {}
}

// UPDATED assignSportsToMatchups (FIX 13 + BUGFIX)
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

  // Safely initialize the overrides object
  const loadedOverrides = dailyData.overrides || {};
  const overrides = {
    fields: loadedOverrides.fields || [],
    bunks: loadedOverrides.bunks || [],
    leagues: loadedOverrides.leagues || []
  };

  // ===== Load *Yesterday's* Data =====
  const yesterdayData = window.loadPreviousDailyData?.() || {};
  const yesterdayLeagues = yesterdayData.leagueAssignments || {};
  const yesterdaySchedule = yesterdayData.scheduleAssignments || {};

  // 3. Create Today's Filtered Lists
  const availFields = masterFields.filter(f => f.available && !overrides.fields.includes(f.name));
  const availSpecials = masterSpecials.filter(s => s.available && !overrides.fields.includes(s.name));
  const availableDivisions = masterAvailableDivs.filter(divName => !overrides.bunks.includes(divName));

  const divisions = {};
  for (const divName of availableDivisions) {
    if (!masterDivisions[divName]) continue;
    divisions[divName] = JSON.parse(JSON.stringify(masterDivisions[divName]));
    divisions[divName].bunks = (divisions[divName].bunks || []).filter(bunkName => !overrides.bunks.includes(bunkName));
  }
  window.availableDivisions = availableDivisions;
  window.divisions = divisions;

  // Build bunk -> division map for sharing rules
  window.bunkToDivision = {};
  availableDivisions.forEach(dv => { (divisions[dv]?.bunks || []).forEach(bk => window.bunkToDivision[bk] = dv); });

  const allGlobalDivisions = app1Data.availableDivisions || masterAvailableDivs;

  // Activity properties (sharable, allowedDivisions)
  const activityProperties = {};
  availFields.forEach(f => {
    activityProperties[f.name] = {
      sharable: f.sharable || false,
      allowedDivisions: (f.allowedDivisions || []).length > 0 ? f.allowedDivisions : allGlobalDivisions
    };
  });
  availSpecials.forEach(s => {
    activityProperties[s.name] = {
      sharable: s.sharable || false,
      allowedDivisions: (s.allowedDivisions || []).length > 0 ? s.allowedDivisions : allGlobalDivisions
    };
  });

  const enabledByDiv = getEnabledLeaguesByDivision(masterLeagues, overrides);

  const inc = parseInt(document.getElementById("increment")?.value || "30", 10);
  const activityDuration = parseInt(document.getElementById("activityDuration")?.value || "30", 10);
  const spanLen = Math.max(1, Math.ceil(activityDuration / inc));

  // Field-Sport Inventory
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
  // Global list of schedulable names (fields + specials)
  window.allSchedulableNames = allFieldNames.concat(availSpecials.map(s => s.name));

  const allActivities = [
    ...availFields.flatMap((f) => (f.activities || []).map((act) => ({ type: "field", field: f, sport: act }))),
    ...availSpecials.map((sa) => ({ type: "special", field: sa, sport: null }))
  ];
  const h2hActivities = allActivities.filter(a => a.type === 'field' && a.sport);

  if ((!allActivities.length && !availSpecials.length) || !window.unifiedTimes || window.unifiedTimes.length === 0) {
    console.warn("Cannot assign fields: No activities or unified times are set. Did you click 'Generate Schedule Times'?");
    updateTable();
    return;
  }

  // Init grids
  scheduleAssignments = {};
  availableDivisions.forEach((d) => (divisions[d]?.bunks || []).forEach((b) => (scheduleAssignments[b] = new Array(window.unifiedTimes.length))));
  window.scheduleAssignments = scheduleAssignments;

  // Place fixed blocks
  const blockedRowsByDiv = prePlaceFixedActivities();

  // ===== Per-day uniqueness tracker =====
  window.todayActivityUsed = {};
  availableDivisions.forEach(div => {
    (divisions[div]?.bunks || []).forEach(b => {
      window.todayActivityUsed[b] = new Set();
    });
  });

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
          // Seed uniqueness from fixed or existing
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

  // --- Leagues FIRST: Smart placement + eviction rescue ---
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

    // try each candidate slot without eviction first
    for (const chosenSlot of candidates) {
      const teams = (lg.data.teams || []).map((t) => String(t).trim()).filter(Boolean);
      if (teams.length < 2) break;
      const matchups = window.getLeagueMatchups?.(lg.name, teams) || [];
      if (!matchups.length) break;
      const gamesWithSports = assignSportsToMatchups(lg.name, matchups, lg.data.sports, leagueTeamSportHistory);

      // availability snapshot
      const availableFieldsForSpan = {};
      allFieldNames.forEach(name => {
        let capacity = 1;
        for (let k = 0; k < spanLen; k++) { const slot = chosenSlot + k; const usage = fieldUsageBySlot[slot]?.[name] || 0; if (usage > 0) { capacity = 0; break; } }
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
      for (let k = 0; k < spanLen; k++) {
        const slot = chosenSlot + k; if (slot >= window.unifiedTimes.length) break;
        window.leagueAssignments[div][slot] = (k === 0) ? leagueData : leagueContinuation;
        takenLeagueSlots.add(slot);
        gamesWithFields.forEach(game => { if (game.field) { fieldUsageBySlot[slot] = fieldUsageBySlot[slot] || {}; fieldUsageBySlot[slot][game.field] = 2; } });
      }
      // Mark league sports as used today for each team
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
        evictAssignmentsOnFields(chosenSlot, spanLen, candidateFields, fieldUsageBySlot);
        const avail = {}; allFieldNames.forEach(name => { let cap = 1; for (let k = 0; k < spanLen; k++) { const slot = chosenSlot + k; if ((fieldUsageBySlot[slot]?.[name] || 0) > 0) { cap = 0; break; } } avail[name] = cap; });
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
          // Mark league sports as used today for each team
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

  updateTable();
  saveSchedule();
}

// ===== Helpers for General/H2H placement =====
function tryGeneralActivity(bunk, div, s, spanLen, activityList, fieldUsageBySlot, isActive, generalActivityHistory, generalFieldHistory, activityProperties) {
  const todayActivityUsed = window.todayActivityUsed || {};
  for (const pick of activityList) {
    const pickedField = fieldLabel(pick.field);
    const activityName = getActivityName(pick); // sport for fields-with-sport, else special/field name

    // Per-day uniqueness: block if already used today
    if (todayActivityUsed[bunk]?.has(activityName)) continue;

    // Avoid same field as yesterday when non-preferred
    if (generalFieldHistory && generalFieldHistory[bunk][activityName] === pickedField && (window.allSchedulableNames || []).length > 1) continue;

    let [canFit, spanForThisPick] = canActivityFit(bunk, div, s, spanLen, pickedField, fieldUsageBySlot, isActive, activityProperties);
    if (canFit && spanForThisPick > 0) {
      const placed = assignActivity(bunk, s, spanForThisPick, pick, fieldUsageBySlot, generalActivityHistory);
      if (placed > 0) {
        // Mark as used today
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
      // Per-day uniqueness for both bunks
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
        h2hHistory[bunk][opponent] = (h2hHistory[bunk][opponent] || 0) + 1;
        h2hHistory[opponent][bunk] = (h2hHistory[opponent][bunk] || 0) + 1;
        h2hGameCount[bunk] = (h2hGameCount[bunk] || 0) + 1;
        h2hGameCount[opponent] = (h2hGameCount[opponent] || 0) + 1;

        // Mark as used today for both teams
        todayActivityUsed[bunk].add(sportName);
        todayActivityUsed[opponent].add(sportName);

        return finalSpan;
      }
    }
  }
  return 0;
}

function canActivityFit(bunk, div, s, spanLen, pickedField, fieldUsageBySlot, isActive, activityProperties) {
  let canFitThisPick = true;
  let spanForThisPick = 0;
  for (let k = 0; k < spanLen; k++) {
    const currentSlot = s + k;
    if (currentSlot >= window.unifiedTimes.length) { canFitThisPick = false; break; }
    let isBusy = false;
    if (window.scheduleAssignments[bunk][currentSlot] || window.leagueAssignments?.[div]?.[currentSlot] || !isActive(currentSlot)) { isBusy = true; }
    if (!isBusy && pickedField && activityProperties[pickedField]) {
      const fieldProps = activityProperties[pickedField];
      const usage = fieldUsageBySlot[currentSlot]?.[pickedField] || 0;
      if (usage > 0) {
        if (!fieldProps.sharable || usage >= 2 || !fieldProps.allowedDivisions.includes(div)) { isBusy = true; }
        else {
          // Enforce same-division sharing
          let occupyingDivision = null;
          const allDivs = window.availableDivisions || [];
          const divs = window.divisions || {};
          for (const dv of allDivs) {
            const bunksHere = divs[dv]?.bunks || [];
            for (const b2 of bunksHere) {
              const e2 = window.scheduleAssignments[b2]?.[currentSlot];
              if (e2 && !e2._fixed && !e2._h2h && fieldLabel(e2.field) === pickedField) { occupyingDivision = window.bunkToDivision?.[b2] || dv; break; }
            }
            if (occupyingDivision) break;
          }
          if (occupyingDivision && occupyingDivision !== div) isBusy = true;
        }
      }
    }
    if (isBusy) { if (k === 0) canFitThisPick = false; break; }
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
