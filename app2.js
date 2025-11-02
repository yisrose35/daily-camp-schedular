// App 2 // --- Helper Functions for Time Parsing and Fixed Activities ---

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
    if (hh === 12) hh = (mer === "am") ? 0 : 12;
    else if (mer === "pm") hh += 12;
  }
  return hh * 60 + mm;
}

function fieldLabel(field) {
  if (typeof field === "string") return field;
  if (field && typeof field === "object" && typeof field.name === "string") return field.name;
  return ""; 
}

function findRowsForRange(startStr, endStr) {
  if (!Array.isArray(window.unifiedTimes) || window.unifiedTimes.length === 0) return [];
  const startMin = parseTimeToMinutes(startStr);
  const endMin = parseTimeToMinutes(endStr);
  if (startMin == null || endMin == null || endMin <= startMin) return [];

  const inside = [];
  for (let i = 0; i < window.unifiedTimes.length; i++) {
    const r = window.unifiedTimes[i];
    const rs = r.start.getHours() * 60 + r.start.getMinutes();
    const re = r.end.getHours() * 60 + r.end.getMinutes();
    if (rs >= startMin && re <= endMin) inside.push(i);
  }
  
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

function loadActiveFixedActivities() {
  let raw = localStorage.getItem("fixedActivities_v2");
  if (!raw) raw = localStorage.getItem("fixedActivities");
  try {
    const arr = JSON.parse(raw || "[]");
    return Array.isArray(arr) ? arr.filter(a => a && a.enabled) : [];
  } catch {
    return [];
  }
}

function computeBlockedRowsByDiv() {
  const fixed = loadActiveFixedActivities();
  const blocked = {}; 
  fixed.forEach(act => {
    const rows = findRowsForRange(act.start, act.end); 
    if (rows.length === 0) return;
    const targetDivs = (Array.isArray(act.divisions) && act.divisions.length > 0)
      ? act.divisions
      : (window.availableDivisions || []);
    targetDivs.forEach(div => {
      blocked[div] = blocked[div] || new Set();
      rows.forEach(r => blocked[div].add(r));
    });
  });
  return blocked;
}

function prePlaceFixedActivities() {
  if (window.DailyActivities && typeof window.DailyActivities.prePlace === "function") {
    try {
      window.DailyActivities.prePlace(); 
    } catch (e) {
      console.error("Error executing DailyActivities.prePlace:", e);
    }
  }
  return computeBlockedRowsByDiv();
}

// -------------------- Scheduling Core (Unified Grid) --------------------
function assignFieldsToBunks() {
  // Defensive guards against missing globals
  window.scheduleAssignments = window.scheduleAssignments || {};
  window.availableDivisions = Array.isArray(window.availableDivisions) ? window.availableDivisions : [];
  window.divisions = window.divisions || {};
  window.fields = Array.isArray(window.fields) ? window.fields : [];
  window.specialActivities = Array.isArray(window.specialActivities) ? window.specialActivities : [];
  window.unifiedTimes = Array.isArray(window.unifiedTimes) ? window.unifiedTimes : [];
  window.leagues = window.leagues || {}; 
  window.leaguesByName = window.leaguesByName || {}; 
  window.divisionActiveRows = window.divisionActiveRows || {}; 

  const incEl = document.getElementById("increment");
  const inc = incEl ? parseInt(incEl.value, 10) : 30; 
  const durationEl = document.getElementById("activityDuration");
  const activityDuration = durationEl ? parseInt(durationEl.value, 10) : 30;
  const spanLen = Math.max(1, Math.ceil(activityDuration / inc));

  const availFields = fields.filter(f => f?.available && Array.isArray(f.activities) && f.activities.length > 0);
  const availSpecials = specialActivities.filter(s => s?.available);

  const allActivities = [
    ...availFields.flatMap(f => f.activities.map(act => ({ type: "field", field: f, sport: act }))),
    ...availSpecials.map(sa => ({ type: "special", field: { name: sa.name }, sport: null }))
  ];

  if (allActivities.length === 0 || unifiedTimes.length === 0) {
    console.warn("No activities or time grid available. Scheduling aborted.");
    scheduleAssignments = {};
    return;
  }

  // Reset schedule
  scheduleAssignments = {};
  availableDivisions.forEach(div => {
    (divisions[div]?.bunks || []).forEach(b => {
      scheduleAssignments[b] = new Array(unifiedTimes.length);
    });
  });

  // -------------------- Resource Locks Initialization --------------------
  // These are required for Step 0 (Fixed) and Step 2 (General Fill)
  const globalResourceUsage = {}; 
  const occupiedFieldsBySlot = Array.from({ length: unifiedTimes.length }, () => new Set());
  const globalActivityLock = Array.from({ length: unifiedTimes.length }, () => new Set()); 
  
  // Per-bunk once-per-day tracker
  const usedActivityKeysByBunk = {}; 
  const fieldsUsedByBunk = {}; 

  availableDivisions.forEach(div => {
    (divisions[div]?.bunks || []).forEach(b => {
      usedActivityKeysByBunk[b] = new Set();
      fieldsUsedByBunk[b] = new Set();
    });
  });

  function activityKey(act) {
    if (!act) return null;
    if (act.sport && typeof act.sport === 'string') return `sport:${norm(act.sport)}`;
    const fname = norm(act.field && act.field.name || act.field);
    return fname ? `special:${fname}` : null;
  }

  function overlaps(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
  }

  function canUseField(fieldName, start, end, s) {
    if (!fieldName) return false;
    for (let k = 0; k < spanLen; k++) {
      const idx = s + k;
      if (idx >= unifiedTimes.length) break;
      if (occupiedFieldsBySlot[idx].has(fieldName)) return false;
    }
    if (globalResourceUsage[fieldName]) {
      for (const r of globalResourceUsage[fieldName]) {
        if (overlaps(start, end, r.start, r.end)) return false;
      }
    }
    return true;
  }

  function reserveField(fieldName, start, end, s, sportName = null, currentSpanLen = spanLen) {
    if (!fieldName) return;
    if (!globalResourceUsage[fieldName]) globalResourceUsage[fieldName] = [];
    
    globalResourceUsage[fieldName].push({ start, end }); 
    
    for (let k = 0; k < currentSpanLen; k++) {
      const idx = s + k;
      if (idx >= unifiedTimes.length) break;
      occupiedFieldsBySlot[idx].add(fieldName);
      if (sportName) globalActivityLock[idx].add(norm(sportName));
    }
  }

  function getLeagueForDivision(div) {
    const allLeagues = window.leaguesByName || {};
    for (const name in allLeagues) {
      const lg = allLeagues[name];
      if (lg.enabled && Array.isArray(lg.divisions) && lg.divisions.includes(div)) {
        return lg;
      }
    }
    return null;
  }

  // -------------------- Step 0: Pre-place FIXED Activities (Highest Precedence) --------------------
  const blockedRowsByDiv = prePlaceFixedActivities();


  // -------------------- Lock Resources for Fixed Activities --------------------
  Object.keys(scheduleAssignments).forEach(bunk => {
    scheduleAssignments[bunk].forEach((entry, s) => {
      if (entry && entry._fixed && !entry.continuation) {
        let currentSpanLen = 1;
        for (let k = s + 1; k < unifiedTimes.length; k++) {
          const e2 = scheduleAssignments[bunk][k];
          if (e2 && e2._fixed && fieldLabel(e2.field) === fieldLabel(entry.field)) {
            currentSpanLen++;
          } else {
            break;
          }
        }
        
        const fieldName = fieldLabel(entry.field); 
        const slotStart = unifiedTimes[s].start;
        const absEnd = new Date(slotStart.getTime() + currentSpanLen * inc * 60000);
        reserveField(fieldName, slotStart, absEnd, s, entry.sport, currentSpanLen);
      }
    });
  });


  // -------------------- 1) Schedule Guaranteed Leagues (MATCHUPS ONLY) --------------------
  for (const div of priorityDivs) {
    const leagueData = getLeagueForDivision(div);
    const activeSlots = Array.from(divisionActiveRows[div] || []);

    if (!leagueData || activeSlots.length === 0) continue;

    const nonBlockedSlots = activeSlots.filter(s => {
      if (blockedRowsByDiv[div]?.has(s)) return false; 
      const hasAssignment = (divisions[div]?.bunks || []).some(b => 
        scheduleAssignments[b] && scheduleAssignments[b][s]
      );
      return !hasAssignment;
    });

    if (nonBlockedSlots.length === 0) continue;

    // Use the first available slot after fixed activities
    let chosenSlot = nonBlockedSlots[0]; 
    leagueSlotByDiv[div] = chosenSlot;

    // Get specific matchups (advances round state)
    const teams = leagueData.teams.length > 0 ? leagueData.teams : (divisions[div]?.bunks || []); 
    const leagueMatchups = window.getLeagueMatchups?.(leagueData.name, teams);
    
    if (!leagueMatchups || leagueMatchups.length === 0) continue;

    // Determine generic details
    const chosenSport = leagueData.sports.length > 0 ? leagueData.sports[0] : 'Leagues';
    const leagueFieldName = "League Game (TBD)"; 

    leagueMatchups.forEach(match => {
      const [teamA, teamB] = match;
      if (teamA === "BYE" || teamB === "BYE") return; 

      const playingBunks = [teamA, teamB].filter(t => (divisions[div]?.bunks || []).includes(t));
      if (playingBunks.length < 2) return; 

      const assignmentDetails = {
          field: leagueFieldName,
          sport: chosenSport,
          matchup: playingBunks.join(' vs '),
          isLeague: true,
      };

      // Assign the activity details to the relevant bunks
      playingBunks.forEach(bunk => {
        if (!scheduleAssignments[bunk] || scheduleAssignments[bunk][chosenSlot]) return;

        scheduleAssignments[bunk][chosenSlot] = { ...assignmentDetails, continuation: false };
        
        // Track usage (MANDATORY for general scheduling to skip this slot)
        const key = activityKey(assignmentDetails);
        if (key) usedActivityKeysByBunk[bunk].add(key);
        fieldsUsedByBunk[bunk].add(leagueFieldName); 

        // Fill continuations
        for (let k = 1; k < spanLen; k++) {
          const idx = chosenSlot + k;
          if (idx >= unifiedTimes.length) break;
          if (!(divisionActiveRows[div] && divisionActiveRows[div].has(idx))) break;
          if (scheduleAssignments[bunk][idx]) break; 
          
          scheduleAssignments[bunk][idx] = { ...assignmentDetails, continuation: true };
        }
      });
    });
    // NO reserveField CALLS HERE! 
  }

  // -------------------- 2) Fill Every Remaining Slot --------------------
  const lastActivityByBunk = {};
  const PLACEHOLDER_NAME = 'Special Activity Needed';

  function baseFeasible(act, bunk, slotStart, slotEnd, s, allowFieldReuse) {
    const fname = fieldLabel(act?.field);
    if (!fname) return false;

    // 1. Resource Lock Check (This will now only check Fixed Activities and previous General Fills)
    if (!canUseField(fname, slotStart, slotEnd, s)) return false;

    // 2. Sport Lock Check
    if (act.sport && globalActivityLock[s].has(norm(act.sport))) return false;

    // 3. ABSOLUTE RULE: uniqueness check
    const key = activityKey(act);
    if (key && usedActivityKeysByBunk[bunk]?.has(key)) return false;

    // 4. Soft constraint: field reuse
    if (!allowFieldReuse && fieldsUsedByBunk[bunk]?.has(fname)) return false;

    return true;
  }

  function chooseActivity(bunk, slotStart, slotEnd, s) {
    let pool = allActivities.filter(a => baseFeasible(a, bunk, slotStart, slotEnd, s, false));
    if (pool.length > 0) return pool[Math.floor(Math.random() * pool.length)];

    pool = allActivities.filter(a => baseFeasible(a, bunk, slotStart, slotEnd, s, true));
    if (pool.length > 0) return pool[Math.floor(Math.random() * pool.length)];

    return { type: 'special', field: { name: PLACEHOLDER_NAME }, sport: null, _placeholder: true };
  }

  for (let s = 0; s < unifiedTimes.length; s++) {
    const slotStart = unifiedTimes[s].start;
    const absEnd = new Date(slotStart.getTime() + activityDuration * 60000); 

    for (const div of priorityDivs) {
      if (!(divisionActiveRows[div] && divisionActiveRows[div].has(s)))
        continue;

      for (const bunk of (divisions[div]?.bunks || [])) {
        if (scheduleAssignments[bunk][s]) continue; // fixed/leagues/continuations already set

        const chosen = chooseActivity(bunk, slotStart, absEnd, s);
        const fname = fieldLabel(chosen.field);

        scheduleAssignments[bunk][s] = {
          field: fname,
          sport: chosen.sport,
          continuation: false,
          isLeague: false
        };

        // Reserve only for real activities
        if (!chosen._placeholder) {
          reserveField(fname, slotStart, absEnd, s, chosen.sport);
        }

        // Continuations over spanLen
        for (let k = 1; k < spanLen; k++) {
          const idx = s + k;
          if (idx >= unifiedTimes.length) break;
          if (!(divisionActiveRows[div] && divisionActiveRows[div].has(idx))) break;
          if (scheduleAssignments[bunk][idx]) break; 

          scheduleAssignments[bunk][idx] = {
            field: fname,
            sport: chosen.sport,
            continuation: true,
            isLeague: false
          };
        }

        // Track per-bunk usage (skip placeholder)
        if (!chosen._placeholder) {
          const key = activityKey(chosen);
          if (key) usedActivityKeysByBunk[bunk].add(key);
          fieldsUsedByBunk[bunk].add(fname);
        }

        lastActivityByBunk[bunk] = { field: fname, sport: chosen.sport, isLeague: false };
      }
    }
  }

  updateTable();
  saveSchedule(); 
}

// -------------------- Rendering (FINAL) --------------------
function updateTable() {
  const scheduleTab = document.getElementById("schedule");
  if (!scheduleTab) { return; }
  scheduleTab.innerHTML = "";
  
  if (unifiedTimes.length === 0) return;

  Object.keys(scheduleAssignments).forEach(b => {
    if (Array.isArray(scheduleAssignments[b])) {
      scheduleAssignments[b].forEach(e => { if (e) delete e._skip; });
    }
  });

  const table = document.createElement("table");
  table.className = "division-schedule";

  const thead = document.createElement("thead");
  const row1 = document.createElement("tr");
  const thTime = document.createElement("th");
  thTime.textContent = "Time";
  row1.appendChild(thTime);

  availableDivisions.forEach(div => {
    const th = document.createElement("th");
    th.colSpan = (divisions[div]?.bunks || []).length;
    th.textContent = div;
    th.style.background = divisions[div]?.color || '#333';
    th.style.color = "#fff";
    row1.appendChild(th);
  });
  thead.appendChild(row1);

  const row2 = document.createElement("tr");
  const thB = document.createElement("th");
  thB.textContent = "Bunk";
  row2.appendChild(thB);
  availableDivisions.forEach(div => {
    (divisions[div]?.bunks || []).forEach(b => {
      const th = document.createElement("th");
      th.textContent = b;
      row2.appendChild(th);
    });
  });
  thead.appendChild(row2);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (let s = 0; s < unifiedTimes.length; s++) {
    const tr = document.createElement("tr");
    const tdTime = document.createElement("td");
    tdTime.textContent = unifiedTimes[s].label;
    tr.appendChild(tdTime);

    availableDivisions.forEach(div => {
      const activeSet = divisionActiveRows[div] || new Set();
      (divisions[div]?.bunks || []).forEach(b => {
        if (scheduleAssignments[b] && scheduleAssignments[b][s] && scheduleAssignments[b][s]._skip) return;
        const td = document.createElement("td");
        const active = activeSet.has(s);
        if (!active) { td.className = "grey-cell"; tr.appendChild(td); return; }

        const entry = scheduleAssignments[b][s];
        if (entry && !entry.continuation) {
          let span = 1;
          for (let k = s + 1; k < unifiedTimes.length; k++) {
            const e2 = scheduleAssignments[b][k];
            const sameField = e2 && fieldLabel(e2.field) === fieldLabel(entry.field);
            const sameSport = (e2 && e2.sport) === (entry && entry.sport);
            const sameLeague = !!(e2 && e2.isLeague) === !!(entry && entry.isLeague);
            const sameFixed = !!(e2 && e2._fixed) === !!(entry && entry._fixed);
            if (!e2 || !e2.continuation || !sameField || !sameSport || !sameLeague || !sameFixed) break;
            span++;
            scheduleAssignments[b][k]._skip = true;
          }
          td.rowSpan = span;

          if (entry.isLeague) {
            // RENDER MATCHUP ONLY
            const display = entry.matchup 
                ? `<span style="font-weight:600;">${entry.matchup}</span><br><span style="font-size:0.8em; opacity:0.8;">(${entry.sport})</span>` 
                : 'Leagues';
            td.innerHTML = `<div class="league-pill">${display}</div>`;
            td.style.backgroundColor = divisions[div]?.color || '#4CAF50';
            td.style.color = 'white';
          } else if (entry._fixed) { 
            td.innerHTML = `<span class="fixed-pill">${fieldLabel(entry.field)}</span>`;
            td.style.backgroundColor = '#f1f1f1';
          } else if (fieldLabel(entry.field) === "Special Activity Needed" && !entry.sport) {
            td.innerHTML = `<span class="need-special-pill" style="color:#c0392b;">${fieldLabel(entry.field)}</span>`;
          } else {
            const label = fieldLabel(entry.field);
            td.textContent = entry.sport ? `${label} – ${entry.sport}` : label;
          }
        } else if (!entry) td.textContent = "";
        tr.appendChild(td);
      });
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  scheduleTab.appendChild(table);
}

// -------------------- Schedule Save / Load --------------------
function saveSchedule() {
  console.log("Saving schedule to local storage.");
  localStorage.setItem("scheduleAssignments", JSON.stringify(scheduleAssignments));
}

function reconcileOrRenderSaved() {
  const saved = localStorage.getItem("scheduleAssignments");
  if (!saved) { updateTable(); return; } 

  let parsed;
  try { parsed = JSON.parse(saved); } catch { parsed = null; }
  if (!parsed || typeof parsed !== "object") { updateTable(); return; }

  const blocked = computeBlockedRowsByDiv();

  let conflict = false;
  Object.keys(parsed).forEach(bunk => {
    const div = Object.keys(divisions).find(d => (divisions[d]?.bunks || []).includes(bunk));
    if (!div) return;
    const rows = parsed[bunk] || [];
    rows.forEach((cell, idx) => {
      if (cell && !cell._fixed && blocked[div] && blocked[div].has(idx)) {
         conflict = true; 
      }
    });
  });

  if (conflict) {
    console.log("Fixed activity conflict detected. Regenerating schedule.");
    assignFieldsToBunks();
  } else {
    window.scheduleAssignments = parsed;
    updateTable();
  }
}

function initScheduleSystem() {
  try {
    reconcileOrRenderSaved();
  } catch (e) {
    console.error("Init error during schedule load:", e);
    updateTable(); 
  }
}

// Global exposure and auto-initialization on load
window.assignFieldsToBunks = assignFieldsToBunks;
window.updateTable = updateTable;
window.initScheduleSystem = initScheduleSystem;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initScheduleSystem);
} else {
  initScheduleSystem();
}
