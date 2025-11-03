// -------------------- app2.js (Smarter Scheduling) --------------------
// Leagues render as merged cells per division+slot with per-matchup sports.
// Fixed activities show names properly; early/late times grey per division.
// FIX: Activity length now correctly uses 'activityDuration' instead of single increments.
// FIX 2 (Aesthetic): Use rowspan to merge cells for multi-slot activities.
// FIX 3 (Critical): Prevent general activities from OVERWRITING fixed activities.
// FIX 4 (Critical): Prevent LEAGUE activities from overwriting *or* being fragmented.
// (General activities are *allowed* to be fragmented by fixed activities).
// FIX 5: Assign specific fields to leagues. Leagues get *priority* and reserve fields first.
// FIX 6: Make general scheduler "smarter" to try all activities before leaving a slot blank.
// FIX 7 (NEW): Smarter league field assignment. Solves "bin packing" problem
//              by assigning most constrained games (fewest field options) first.
// FIX 8 (NEW): Prevent bunks from repeating a *general* activity (sport or special)
//              more than once per day. Does not apply to leagues or fixed.

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
// Gets a unique name for an activity (sport name or special activity name)
function getActivityName(pick) {
    if (pick.sport) {
        return pick.sport; // e.g., "Basketball"
    }
    return fieldLabel(pick.field); // e.g., "gameroom"
}

// ===== Fixed Activities =====
function loadActiveFixedActivities() {
  let raw = localStorage.getItem("fixedActivities_v2");
  if (!raw) raw = localStorage.getItem("fixedActivities");
  try {
    const arr = JSON.parse(raw || "[]");
    return Array.isArray(arr) ? arr.filter((a) => a && a.enabled) : [];
  } catch {
    return [];
  }
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
  if (window.leaguesByName && Object.keys(window.leaguesByName).length > 0)
    return window.leaguesByName;
  try {
    const raw = localStorage.getItem("leagues");
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}
function getEnabledLeaguesByDivision() {
  const result = {};
  const all = leaguesSnapshot();
  Object.keys(all).forEach((name) => {
    const l = all[name];
    if (!l?.enabled) return;
    (l.divisions || []).forEach((div) => {
      result[div] = { name, data: l };
    });
  });
  return result;
}

// ===== Round-Robin Generator =====
(function () {
  const KEY = "camp_league_round_state";
  let state = {};
  function load() {
    try {
      state = JSON.parse(localStorage.getItem(KEY) || "{}") || {};
    } catch {
      state = {};
    }
  }
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {}
  }
  function genRR(teams) {
    if (!teams || teams.length < 2) return [];
    const t = [...teams];
    let bye = false;
    if (t.length % 2 !== 0) {
      t.push("BYE");
      bye = true;
    }
    const fixed = t[0],
      rot = t.slice(1),
      rounds = t.length - 1,
      out = [];
    for (let r = 0; r < rounds; r++) {
      const round = [];
      round.push([fixed, rot[0]]);
      for (let i = 1; i < t.length / 2; i++)
        round.push([rot[i], rot[rot.length - i]]);
      out.push(round);
      rot.unshift(rot.pop());
    }
    if (bye)
      return out.map((r) => r.filter((m) => m[0] !== "BYE" && m[1] !== "BYE"));
    return out;
  }
  function get(leagueName, teams) {
    if (!leagueName || !teams || teams.length < 2) return [];
    load();
    const cur = state[leagueName]?.currentRound ?? 0;
    const full = genRR(teams);
    if (full.length === 0) return [];
    const today = full[cur];
    state[leagueName] = { currentRound: (cur + 1) % full.length };
    save();
    return today;
  }
  window.getLeagueMatchups = get;
  load();
})();

// ===== League Sport Rotation =====
const SPORT_STATE_KEY = "camp_league_sport_rotation";
let leagueSportRotation = {};
function loadLeagueSportRotation() {
  try {
    leagueSportRotation =
      JSON.parse(localStorage.getItem(SPORT_STATE_KEY) || "{}") || {};
  } catch {
    leagueSportRotation = {};
  }
}
function saveLeagueSportRotation() {
  try {
    localStorage.setItem(
      SPORT_STATE_KEY,
      JSON.stringify(leagueSportRotation)
    );
  } catch {}
}
function assignSportsToMatchups(leagueName, matchups, sportsList) {
  if (!Array.isArray(matchups) || matchups.length === 0) return [];
  if (!Array.isArray(sportsList) || sportsList.length === 0)
    return matchups.map((m) => ({ teams: m, sport: "Leagues" }));

  loadLeagueSportRotation();
  const state = leagueSportRotation[leagueName] || { index: 0 };
  let idx = state.index;

  const assigned = matchups.map((m) => {
    const sport = sportsList[idx % sportsList.length];
    idx++;
    return { teams: m, sport };
  });

  leagueSportRotation[leagueName] = { index: idx % sportsList.length };
  saveLeagueSportRotation();
  return assigned;
}

// ====== CORE ASSIGN ======
window.leagueAssignments = window.leagueAssignments || {};

function assignFieldsToBunks() {
  window.scheduleAssignments = window.scheduleAssignments || {};
  window.leagueAssignments = {};

  const inc = parseInt(document.getElementById("increment")?.value || "30", 10);
  const activityDuration = parseInt(
    document.getElementById("activityDuration")?.value || "30",
    10
  );
  const spanLen = Math.max(1, Math.ceil(activityDuration / inc));

  const availFields = fields.filter(
    (f) => f?.available && Array.isArray(f.activities) && f.activities.length
  );
  const availSpecials = specialActivities.filter((s) => s?.available);

  // Create Field-Sport Inventory
  const fieldsBySport = {};
  availFields.forEach(f => {
    if (Array.isArray(f.activities)) {
      f.activities.forEach(sport => {
        fieldsBySport[sport] = fieldsBySport[sport] || [];
        fieldsBySport[sport].push(f.name); // Use f.name
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
  if (!allActivities.length || !unifiedTimes.length) return;

  // Init grids
  scheduleAssignments = {};
  availableDivisions.forEach((d) =>
    (divisions[d]?.bunks || []).forEach(
      (b) => (scheduleAssignments[b] = new Array(unifiedTimes.length))
    )
  );

  const blockedRowsByDiv = prePlaceFixedActivities();

  // Create Field Reservation System
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

  // ===== FIX 8: Init General Activity History =====
  const generalActivityHistory = {};
  availableDivisions.forEach(div => {
      (divisions[div]?.bunks || []).forEach(b => { 
          generalActivityHistory[b] = new Set(); 
      }); 
  });
  // Pre-populate history with fixed activities
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
  // ===============================================

  const enabledByDiv = getEnabledLeaguesByDivision();
  const takenLeagueSlots = new Set(); 

  // --- Place Leagues (STRICT: Must fit full span & find a field) ---
  for (const div of availableDivisions) {
    const lg = enabledByDiv[div];
    if (!lg) continue;
    const actSet = divisionActiveRows?.[div];
    const actSlots =
      actSet && actSet.size
        ? Array.from(actSet)
        : unifiedTimes.map((_, i) => i);

    const bunksInDiv = divisions[div]?.bunks || [];
    const firstBunk = bunksInDiv.length > 0 ? bunksInDiv[0] : null;

    // Find first available time slot
    const candidates = actSlots.filter((s) => {
      for (let k = 0; k < spanLen; k++) {
        const slot = s + k;
        if (slot >= unifiedTimes.length) return false;
        if (blockedRowsByDiv[div]?.has(slot)) return false;
        if (takenLeagueSlots.has(slot)) return false;
        if (firstBunk && scheduleAssignments[firstBunk]?.[slot])
          return false;
      }
      return true;
    });
    
    if (!candidates.length) continue;

    const chosen = candidates[0]; // The starting slot index
    const teams = (lg.data.teams || [])
      .map((t) => String(t).trim())
      .filter(Boolean);
    if (teams.length < 2) continue;
    const matchups = window.getLeagueMatchups?.(lg.name, teams) || [];
    if (!matchups.length) continue;

    const gamesWithSports = assignSportsToMatchups(
      lg.name,
      matchups,
      lg.data.sports
    );

    // ===== FIX 7: Smarter Field Assignment =====
    
    // 1. Find all fields that are *completely free* for this entire span
    const availableFieldsForSpan = new Set();
    availFields.forEach(f => availableFieldsForSpan.add(f.name));
    
    for (let k = 0; k < spanLen; k++) {
        const slot = chosen + k;
        if (fieldUsageBySlot[slot]) {
            fieldUsageBySlot[slot].forEach(f => availableFieldsForSpan.delete(f));
        }
    }

    // 2. Map each game to its list of *possible, available* fields
    const gamesWithPossibleFields = gamesWithSports.map(game => {
        const possibleFields = (fieldsBySport[game.sport] || [])
            .filter(field => availableFieldsForSpan.has(field));
        return { game, possibleFields };
    });

    // 3. Sort games by *fewest* options first (most constrained)
    gamesWithPossibleFields.sort((a, b) => a.possibleFields.length - b.possibleFields.length);

    // 4. Try to assign them
    const tempReservedFields = new Set();
    const gamesWithFields = gamesWithPossibleFields.map(item => {
        const { game, possibleFields } = item;
        let assignedField = "No Field Available";
        
        for (const field of possibleFields) {
            if (!tempReservedFields.has(field)) {
                assignedField = field;
                tempReservedFields.add(field); // Reserve it for this loop
                break;
            }
        }
        return { ...game, field: assignedField };
    });

    // 5. Now, *permanently* reserve the fields that were successfully assigned
    const successfullyAssignedGames = gamesWithFields.filter(g => g.field !== "No Field Available");
    
    successfullyAssignedGames.forEach(game => {
        for (let k = 0; k < spanLen; k++) {
            const slot = chosen + k;
            if (slot >= unifiedTimes.length) break;
            fieldUsageBySlot[slot] = fieldUsageBySlot[slot] || new Set();
            fieldUsageBySlot[slot].add(game.field);
        }
    });
    // ===== END FIX 7 =====

    window.leagueAssignments[div] = window.leagueAssignments[div] || {};
    
    const leagueData = { games: gamesWithFields, leagueName: lg.name, isContinuation: false };
    const leagueContinuation = { leagueName: lg.name, isContinuation: true };

    for (let k = 0; k < spanLen; k++) {
      const slot = chosen + k;
      if (slot >= unifiedTimes.length) break; 
      window.leagueAssignments[div][slot] =
        k === 0 ? leagueData : leagueContinuation;
      takenLeagueSlots.add(slot);
    }
  }

  // --- ===== FIX 6 & 8: "Smarter" General Activity Filler w/ No Repeats ===== ---
  for (const div of availableDivisions) {
    const isActive = (s) => divisionActiveRows?.[div]?.has(s) ?? true;

    for (const bunk of divisions[div]?.bunks || []) {
      for (let s = 0; s < unifiedTimes.length; s++) { 
        if (scheduleAssignments[bunk][s]) continue;
        if (window.leagueAssignments?.[div]?.[s]) continue;
        if (blockedRowsByDiv[div]?.has(s)) continue;
        if (!isActive(s)) continue;

        let assignedSpan = 0;
        
        // ===== FIX 8: Filter out repeats first =====
        const availablePicks = allActivities.filter(pick => {
            return !generalActivityHistory[bunk].has(getActivityName(pick));
        });
        
        const shuffledPicks = [...availablePicks].sort(() => 0.5 - Math.random());
        // ==========================================

        for (const pick of shuffledPicks) {
            const pickedField = fieldLabel(pick.field);
            const activityName = getActivityName(pick);
            let canFitThisPick = true;
            let spanForThisPick = 0;

            for (let k = 0; k < spanLen; k++) {
                const currentSlot = s + k;
                if (currentSlot >= unifiedTimes.length) break; 

                if (
                    scheduleAssignments[bunk][currentSlot] || 
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
            
            if (canFitThisPick && spanForThisPick > 0) {
                for (let k = 0; k < spanForThisPick; k++) {
                    const currentSlot = s + k;
                    scheduleAssignments[bunk][currentSlot] = {
                        field: pickedField,
                        sport: pick.sport,
                        continuation: (k > 0),
                    };
                    if (pickedField) {
                        fieldUsageBySlot[currentSlot] = fieldUsageBySlot[currentSlot] || new Set();
                        fieldUsageBySlot[currentSlot].add(pickedField);
                    }
                }
                assignedSpan = spanForThisPick;
                
                // ===== FIX 8: Add to history =====
                generalActivityHistory[bunk].add(activityName);
                // =================================
                
                break; 
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

// ===== RENDERING (per-division grey-out) =====
function updateTable() {
  const container = document.getElementById("schedule");
  if (!container) return;
  container.innerHTML = "";
  if (!unifiedTimes.length) return;

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
  // cache start/end per division
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
          // This cell is already covered by a rowspan, do nothing.
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
          const entry = scheduleAssignments[b]?.[i];

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
            if (scheduleAssignments[b]?.[j]?.continuation) {
              span++;
            } else {
              break;
            }
          }

          const td = document.createElement("td");
          td.rowSpan = span; 
          td.style.verticalAlign = "top"; 

          if (entry._fixed) {
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

// ===== Save/Init =====
function saveSchedule() {
  try {
    localStorage.setItem(
      "scheduleAssignments",
      JSON.stringify(scheduleAssignments)
    );
    localStorage.setItem(
      "leagueAssignments",
      JSON.stringify(window.leagueAssignments || {})
    );
  } catch (e) {
    console.error("Save schedule failed:", e);
  }
}
function reconcileOrRenderSaved() {
  try {
    window.scheduleAssignments =
      JSON.parse(localStorage.getItem("scheduleAssignments") || "{}") || {};
    window.leagueAssignments =
      JSON.parse(localStorage.getItem("leagueAssignments") || "{}") || {};
  } catch {}
  updateTable();
}
function initScheduleSystem() {
  try {
    reconcileOrRenderSaved();
  } catch (e) {
    console.error("Init error:", e);
    updateTable();
  }
}

window.assignFieldsToBunks = assignFieldsToBunks;
window.updateTable = updateTable;
window.initScheduleSystem = initScheduleSystem;

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", initScheduleSystem);
else initScheduleSystem();
