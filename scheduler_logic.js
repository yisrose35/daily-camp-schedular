// -------------------- scheduler_logic.js (Part 1 of 2) --------------------
// This is the "BRAIN". It contains all the logic for
// HOW to build the schedule.
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

// Global cache so helpers can access without closure issues
window.allSchedulableNames = window.allSchedulableNames || [];

// ===== FIX 8 HELPER =====
function getActivityName(pick) {
  if (pick.sport) return pick.sport; // e.g., "Basketball"
  return fieldLabel(pick.field); // e.g., "Gameroom"
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
  const ov = overrides || { leagues: [] };

  Object.keys(all).forEach((name) => {
    if ((ov.leagues || []).includes(name)) return; 
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
  const generalFieldHistory = {};    // { bunk: { activityName: fieldName } }
  const h2hHistory = {};             // { bunk: { otherBunk: count } }
  const h2hGameCount = {};           // { bunk: number }

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
      _allBunksInDiv[b] = { ..._allBunksInDiv[b], bunk: b, isFree: true, div: div };
  }
});

// Run scheduling logic slot-by-slot for the entire day
for (let s = 0; s < (window.unifiedTimes || []).length; s += spanLen) {
  // 1. Identify all free bunks and available fields for this slot span
  const slotBunks = [];
  const slotFields = {};
  const bunksByDiv = {};

  // Check field/special availability for the whole span
  for (const name of (window.allSchedulableNames || [])) {
    const props = activityProperties[name];
    if (!props) continue;
    let capacity = props.sharable ? 2 : 1;
    let canUse = true;
    for (let k = 0; k < spanLen; k++) {
      const slot = s + k;
      if (slot >= (window.unifiedTimes || []).length) { canUse = false; break; }
      const usage = fieldUsageBySlot[slot]?.[name]?.count || 0;
      if (usage >= capacity) { canUse = false; break; }
      if (usage > 0 && !props.sharable) { canUse = false; break; } // safety
      // store the *remaining* capacity
      capacity = Math.min(capacity, maxCap - usage);
    }
    if (canUse && capacity > 0) {
      slotFields[name] = { capacity: capacity, props: props };
    }
  }

  // Check bunk availability for the whole span
  for (const div of availableDivisions) {
    const isActive = (sl) => window.divisionActiveRows?.[div]?.has(sl) ?? true;
    const bunks = divisions[div]?.bunks || [];
    bunksByDiv[div] = [];
    for (const bunk of bunks) {
      let isBunkFree = true;
      for (let k = 0; k < spanLen; k++) {
        const slot = s + k;
        if (slot >= (window.unifiedTimes || []).length) { isBunkFree = false; break; }
        if (scheduleAssignments[bunk][slot] || window.leagueAssignments?.[div]?.[slot] || !isActive(slot)) {
          isBunkFree = false;
          break;
        }
      }
      if (isBunkFree) {
        slotBunks.push(bunk);
        bunksByDiv[div].push(bunk);
      }
    }
  }

  if (slotBunks.length === 0) continue; // No bunks to schedule, move to next slot

  // 2. Calculate "Shortfall" and create H2H games
  const assignments = []; // { bunk, pick, isH2H, partner }
  const bunksAssigned = new Set();
  const fieldsUsed = {}; // { "Gym": 1, "Field A": 2 }

  // --- 2a. Handle H2H "by necessity" ---
  for (const div of Object.keys(bunksByDiv)) {
    const bunksToSchedule = shuffle(bunksByDiv[div]);
    const fieldsForThisDiv = Object.keys(slotFields).filter(name => {
      const data = slotFields[name];
      const usage = data.capacity || 0;
      if (usage === 0) return false;
      if (usage > 0 && !data.props.sharable) return true;
      if (usage > 0 && data.props.sharable && data.props.allowedDivisions.includes(div)) return true;
      return false;
    });
    let availableFieldSlots = 0;
    fieldsForThisDiv.forEach(name => { availableFieldSlots += (slotFields[name].capacity - (fieldsUsed[name] || 0)); });

    let shortfall = bunksToSchedule.length - availableFieldSlots;
    let h2hGamesNeeded = 0;
    if (shortfall > 0) {
      h2hGamesNeeded = Math.ceil(shortfall / 2);
    }

    // Try to create H2H games
    for (let i = 0; i < bunksToSchedule.length; i++) {
      const bunkA = bunksToSchedule[i];
      if (h2hCreated >= h2hGamesNeeded) break;
      if (h2hGameCount[bunkA] >= 2 || bunksAssigned.has(bunkA)) continue;

      // Find a partner
      for (let j = i + 1; j < bunksToSchedule.length; j++) {
        const bunkB = bunksToSchedule[j];
        if (h2hGameCount[bunkB] >= 2 || bunksAssigned.has(bunkB)) continue;
        if ((h2hHistory[bunkA]?.[bunkB] || 0) >= 1) continue; // No rematches

        // Find a field for this H2H pair (H2H is NOT sharable)
        const h2hPick = h2hActivities.find(pick => {
            const fName = fieldLabel(pick.field);
            return (slotFields[fName]?.capacity - (fieldsUsed[fName] || 0)) >= 1 && !activityProperties[fName].sharable; // Find an exclusive field
        });

        if (h2hPick) {
          const fieldName = fieldLabel(h2hPick.field);
          assignments.push({ bunk: bunkA, pick: h2hPick, isH2H: true, partner: bunkB });
          assignments.push({ bunk: bunkB, pick: h2hPick, isH2H: true, partner: bunkA });
          bunksAssigned.add(bunkA);
          bunksAssigned.add(bunkB);
          fieldsUsed[fieldName] = (fieldsUsed[fieldName] || 0) + 2; // H2H takes full capacity
          h2hCreated++;
          break; // Bunk A has a partner
        }
      }
    }
  }

  // --- 2b. Assign all remaining free bunks to General Activities ---
s, spanLen, fieldUsageBySlot, isActive, generalActivityHistory, generalFieldHistory, activityProperties, allSchedulableNames);
        }
        // 3. H2H again if still open
        if (assignedSpan === 0 && (h2hGameCount[bunk] || 0) < 2) {
          assignedSpan = tryH2H(bunk, div, s, spanLen, allBunksInDiv, h2hActivities, fieldUsageBySlot, isActive, activityProperties, h2hHistory, h2hGameCount, generalActivityHistory);
        }
        // 4. Non-preferred
        if (assignedSpan === 0) {
          assignedSpan = tryGeneralActivity(bunk, div, s, spanLen, shuffledNonPreferred, fieldUsageBySlot, isActive, generalActivityHistory, generalFieldHistory, activityProperties, allSchedulableNames);
        }
        // 5. Advance
        if (assignedSpan > 0) { s += (assignedSpan - 1); }
      }
    }
  }

  // Pass 2.5: forced H2H within grade (aggressive), before doubling
  fillRemainingWithForcedH2HPlus(window.availableDivisions || [], window.divisions || {}, spanLen, h2hActivities, fieldUsageBySlot, activityProperties, h2hHistory, h2hGameCount, generalActivityHistory);
