// App 2 // --- Helper Functions for Time Parsing and Fixed Activities ---

// NOTE: The parseTimeToMinutes, fieldLabel, findRowsForRange, loadActiveFixedActivities, 
// computeBlockedRowsByDiv, and prePlaceFixedActivities functions remain unchanged.
// Only the assignFieldsToBunks function (and its related helpers) and the rendering 
// function (updateTable) contain the new league logic.

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

// Normalize any "field" value (string or {name}) into a label string
function fieldLabel(field) {
  if (typeof field === "string") return field;
  if (field && typeof field === "object" && typeof field.name === "string") return field.name;
  return ""; // safe fallback
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
    // Check if the slot is entirely within the fixed activity time
    if (rs >= startMin && re <= endMin) inside.push(i);
  }
  
  // Fallback: If no slots perfectly align, find any slots that overlap the time block
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
  // If a central source (like a window.DailyActivities object) exists, use that.
  if (window.DailyActivities && typeof window.DailyActivities.prePlace === "function") {
    try {
      // NOTE: Calling prePlace here with dryRun: true is not the intended way 
      // based on the daily_activities.js code. We rely on App 1 or initScheduleSystem 
      // calling generateTimes, which calls assignFieldsToBunks, which calls prePlace.
      // This helper is primarily for reconciliation.
      let raw = localStorage.getItem("fixedActivities_v2") || localStorage.getItem("fixedActivities");
      const arr = JSON.parse(raw || "[]");
      return Array.isArray(arr) ? arr.filter(a => a && a.enabled) : [];

    } catch (e) {
      console.warn("DailyActivities loading failed; falling back to basic localStorage.", e);
    }
  }
  // Fallback to localStorage
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
  const blocked = {}; // { div: Set(rowIndex) }
  fixed.forEach(act => {
    // NOTE: This uses the existing findRowsForRange which relies on window.unifiedTimes
    // This is safe to run during reconciliation.
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
  // We use the function exposed by daily_activities.js to manage pre-placement
  // and update divisionActiveRows, simplifying App 2's role.
  if (window.DailyActivities && typeof window.DailyActivities.prePlace === "function") {
    try {
      window.DailyActivities.prePlace(); // This mutates scheduleAssignments and divisionActiveRows
    } catch (e) {
      console.error("Error executing DailyActivities.prePlace:", e);
      // Fallback is to proceed with empty/old assignments
    }
  }

  // Recalculate blocked rows based on the *current* state of fixed activities
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
  window.leagues = window.leagues || {}; // Division-to-enabled map
  window.leaguesByName = window.leaguesByName || {}; // Full league config
  window.divisionActiveRows = window.divisionActiveRows || {}; // { div: Set(rowIdx) }

  const incEl = document.getElementById("increment");
  const inc = incEl ? parseInt(incEl.value, 10) : 30; // Default to 30 as per index.html
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
  const globalResourceUsage = {}; // { fieldName: [{start,end}] } (absolute time overlap guard across multi-slot spans)
  const occupiedFieldsBySlot = Array.from({ length: unifiedTimes.length }, () => new Set()); // per-slot uniqueness
  const globalActivityLock = Array.from({ length: unifiedTimes.length }, () => new Set()); // per-slot sport name lock
  const leagueTimeLocks = []; // list of {start,end} to spread league rows across time

  // Normalizer
  const norm = (s) => (typeof s === "string" ? s.trim().toLowerCase() : null);

  // Per-bunk once-per-day tracker for both sports & specials (ABSOLUTE RULE)
  const usedActivityKeysByBunk = {}; // { bunk: Set<string> }
  // Soft preference: avoid reusing the same field for same bunk
  const fieldsUsedByBunk = {}; // { bunk: Set<fieldName> }

  // Build empty sets for all bunks
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
    // Slot check: prevents two different activities from scheduling in the same slot
    for (let k = 0; k < spanLen; k++) {
      const idx = s + k;
      if (idx >= unifiedTimes.length) break;
      if (occupiedFieldsBySlot[idx].has(fieldName)) return false;
    }

    // Time check: prevents scheduling if a prior multi-span activity (like a fixed one) locks the time
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
    
    // Time lock for the full duration
    const durationMins = currentSpanLen * inc;
    const absEnd = new Date(start.getTime() + durationMins * 60000);
    globalResourceUsage[fieldName].push({ start, end: absEnd }); 
    
    // Slot lock for the full span
    for (let k = 0; k < currentSpanLen; k++) {
      const idx = s + k;
      if (idx >= unifiedTimes.length) break;
      occupiedFieldsBySlot[idx].add(fieldName);
      if (sportName) globalActivityLock[idx].add(norm(sportName));
    }
  }

  // Helper to retrieve the league configuration associated with a division (new)
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
  // This populates the schedule grid with fixed activities AND returns the rows blocked by division.
  // The actual pre-placement logic runs inside daily_activities.js's prePlace, called by App 1 init.
  const blockedRowsByDiv = prePlaceFixedActivities();


  // -------------------- Lock Resources for Fixed Activities --------------------
  // This iterates over existing assignments (populated by prePlaceFixedActivities) and locks resources.
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
        // Lock resource for the entire fixed span
        reserveField(fieldName, slotStart, slotStart, s, entry.sport, currentSpanLen);
      }
    });
  });


  // -------------------- 1) Schedule Guaranteed Leagues (UPDATED) --------------------
  for (const div of priorityDivs) {
    const leagueData = getLeagueForDivision(div);
    const activeSlots = Array.from(divisionActiveRows[div] || []);

    // 1. Check if the division wants a league
    if (!leagueData || activeSlots.length === 0) continue;

    const nonBlockedSlots = activeSlots.filter(s => {
      if (blockedRowsByDiv[div]?.has(s)) return false; 
      const hasAssignment = (divisions[div]?.bunks || []).some(b => 
        scheduleAssignments[b] && scheduleAssignments[b][s]
      );
      return !hasAssignment;
    });

    if (nonBlockedSlots.length === 0) continue;

    // 2. Choose a spread-out league slot
    let chosenSlot = null;
    for (const slot of nonBlockedSlots) {
      const slotStart = unifiedTimes[slot].start;
      const slotEnd = new Date(slotStart.getTime() + activityDuration * 60000);
      const clashing = leagueTimeLocks.some(l => overlaps(slotStart, slotEnd, l.start, l.end));
      if (!clashing) {
        chosenSlot = slot; 
        leagueTimeLocks.push({ start: slotStart, end: slotEnd });
        break;
      }
    }
    if (chosenSlot === null) chosenSlot = nonBlockedSlots[0];
    leagueSlotByDiv[div] = chosenSlot;

    // 3. Get specific matchups (Side effect: advances round state in league_scheduling.js)
    const teams = leagueData.teams.length > 0 ? leagueData.teams : (divisions[div]?.bunks || []); 
    const leagueMatchups = window.getLeagueMatchups?.(leagueData.name, teams);
    
    if (!leagueMatchups || leagueMatchups.length === 0) continue;

    // 4. Determine sport and resources
    const slotStart = unifiedTimes[chosenSlot].start;
    const availableSports = leagueData.sports.length > 0 ? leagueData.sports : ['Leagues'];
    const chosenSport = availableSports[Math.floor(Math.random() * availableSports.length)];

    leagueMatchups.forEach(match => { // match is [teamA, teamB]
      const [teamA, teamB] = match;
      if (teamA === "BYE" || teamB === "BYE") return; // Skip BYE games

      // Find an available field that supports the chosen sport
      const availableFieldsForSport = availFields.filter(f => f.activities.includes(chosenSport));
      const fieldPool = availableFieldsForSport.length > 0 ? availableFieldsForSport : availFields;
      
      let assignedField = null;
      // Check resource lock for the single slot where the activity starts
      for (const field of fieldPool) {
        if (canUseField(field.name, slotStart, slotStart, chosenSlot)) {
          assignedField = field.name;
          break;
        }
      }

      if (!assignedField) {
        console.warn(`No field available for league match ${teamA} vs ${teamB}`);
        return; 
      }

      // Reserve field for this specific game
      reserveField(assignedField, slotStart, slotStart, chosenSlot, chosenSport);

      // 5. Map match to bunks and assign to schedule
      const playingBunks = [teamA, teamB].filter(t => bunksInDiv.includes(t)); // Filter to actual bunks
      if (playingBunks.length < 2) return; // Should not happen if teams are defined well

      const assignmentDetails = {
          field: assignedField,
          sport: chosenSport,
          matchup: playingBunks.join(' vs '),
          isLeague: true,
      };

      // Assign the activity details to the relevant bunks
      playingBunks.forEach(bunk => {
        const key = activityKey(assignmentDetails); 
        
        // Ensure bunk is in schedule (should be, but defensive)
        if (!scheduleAssignments[bunk]) return;

        // Check for conflicts one last time
        if (scheduleAssignments[bunk][chosenSlot] && !scheduleAssignments[bunk][chosenSlot]._fixed) {
             console.warn(`[League Conflict] Bunk ${bunk} already assigned at slot ${chosenSlot}. Skipping league assignment.`);
             return;
        }

        // Set assignment and track usage
        scheduleAssignments[bunk][chosenSlot] = { ...assignmentDetails, continuation: false };
        if (key) usedActivityKeysByBunk[bunk].add(key);
        fieldsUsedByBunk[bunk].add(assignedField);

        // Fill continuations
        for (let k = 1; k < spanLen; k++) {
          const idx = chosenSlot + k;
          if (idx >= unifiedTimes.length) break;
          if (!(divisionActiveRows[div] && divisionActiveRows[div].has(idx))) break;
          if (scheduleAssignments[bunk][idx] && !scheduleAssignments[bunk][idx]._fixed) break; // respect fixed activities or other league continuations
          
          scheduleAssignments[bunk][idx] = { ...assignmentDetails, continuation: true };
        }
      });
    });

    // We no longer need to reserve a synthetic field for the overall block since individual games lock resources.
  }

  // -------------------- 2) Fill Every Remaining Slot --------------------
  // NOTE: This logic remains the same, but it now respects the slots and fields locked by the Leagues above.
  const lastActivityByBunk = {};
  const PLACEHOLDER_NAME = 'Special Activity Needed';

  function baseFeasible(act, bunk, slotStart, slotEnd, s, allowFieldReuse) {
    const fname = fieldLabel(act?.field);
    if (!fname) return false;

    // Prevent two bunks on the same physical field at the same time
    if (!canUseField(fname, slotStart, slotEnd, s)) return false;

    // Prevent same sport on multiple fields in the SAME slot
    if (act.sport && globalActivityLock[s].has(norm(act.sport))) return false;

    // ABSOLUTE RULE: never repeat the same sport OR same special for this bunk in the same day
    const key = activityKey(act);
    if (key && usedActivityKeysByBunk[bunk]?.has(key)) return false;

    // Soft: avoid reusing the same field for this bunk unless we must
    if (!allowFieldReuse && fieldsUsedByBunk[bunk]?.has(fname)) return false;

    return true;
  }

  function chooseActivity(bunk, slotStart, slotEnd, s) {
    // Tier A: all constraints, no field reuse
    let pool = allActivities.filter(a => baseFeasible(a, bunk, slotStart, slotEnd, s, false));
    if (pool.length > 0) return pool[Math.floor(Math.random() * pool.length)];

    // Tier B: allow field reuse (still no repeat keys)
    pool = allActivities.filter(a => baseFeasible(a, bunk, slotStart, slotEnd, s, true));
    if (pool.length > 0) return pool[Math.floor(Math.random() * pool.length)];

    // Nothing valid → placeholder that does NOT count toward repeats
    return { type: 'special', field: { name: PLACEHOLDER_NAME }, sport: null, _placeholder: true };
  }

  for (let s = 0; s < unifiedTimes.length; s++) {
    const slotStart = unifiedTimes[s].start;
    const slotEnd = new Date(slotStart.getTime() + activityDuration * 60000);

    for (const div of priorityDivs) {
      if (!(divisionActiveRows[div] && divisionActiveRows[div].has(s)))
        continue;

      for (const bunk of (divisions[div]?.bunks || [])) {
        if (scheduleAssignments[bunk][s]) continue; // fixed/leagues/continuations already set

        const chosen = chooseActivity(bunk, slotStart, slotEnd, s);
        const fname = fieldLabel(chosen.field);

        scheduleAssignments[bunk][s] = {
          field: fname,
          sport: chosen.sport,
          continuation: false,
          isLeague: false
        };

        // Reserve only for real activities
        if (!chosen._placeholder) {
          reserveField(fname, slotStart, slotStart, s, chosen.sport);
        }

        // Continuations over spanLen
        for (let k = 1; k < spanLen; k++) {
          const idx = s + k;
          if (idx >= unifiedTimes.length) break;
          if (!(divisionActiveRows[div] && divisionActiveRows[div].has(idx))) break;
          if (scheduleAssignments[bunk][idx]) break; // already filled by fixed/league/other continuation

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
  saveSchedule(); // auto-save each new schedule
}

// -------------------- Rendering (UPDATED) --------------------
function updateTable() {
  const scheduleTab = document.getElementById("schedule");
  if (!scheduleTab) { 
    console.error("Could not find element with ID 'schedule' to render the table.");
    return; 
  }
  scheduleTab.innerHTML = "";
  
  if (unifiedTimes.length === 0) return;

  // clear helper flags from any prior render
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
            // Compare using normalized field labels so strings/objects both work
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
            // UPDATED: Display the specific league matchup and field
            const display = entry.matchup && entry.field
                ? `<span style="font-weight:600;">${entry.matchup}</span><br><span style="font-size:0.8em; opacity:0.8;">@ ${entry.field} (${entry.sport})</span>` 
                : 'Leagues';
            td.innerHTML = `<div class="league-pill">${display}</div>`;
            td.style.backgroundColor = divisions[div]?.color || '#4CAF50';
            td.style.color = 'white';
          } else if (entry._fixed) { // Render fixed activities
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

  // Compute current fixed-blocked rows
  const blocked = computeBlockedRowsByDiv();

  // Detect any saved LEAGUE/REGULAR cell that now conflicts with a FIXED activity
  let conflict = false;
  Object.keys(parsed).forEach(bunk => {
    const div = Object.keys(divisions).find(d => (divisions[d]?.bunks || []).includes(bunk));
    if (!div) return;
    const rows = parsed[bunk] || [];
    rows.forEach((cell, idx) => {
      // If a cell is defined, but is NOT a fixed activity, and the slot is now blocked by a fixed activity
      if (cell && !cell._fixed && blocked[div] && blocked[div].has(idx)) {
         conflict = true; 
      }
    });
  });

  if (conflict) {
    // If fixed activities have been added/changed since the last save, REGENERATE
    console.log("Fixed activity conflict detected. Regenerating schedule.");
    assignFieldsToBunks();
  } else {
    // Otherwise, load the saved schedule and render it
    window.scheduleAssignments = parsed;
    updateTable();
  }
}

function initScheduleSystem() {
  // We need to run this on load to either load the saved schedule or regenerate if it's broken.
  try {
    reconcileOrRenderSaved();
  } catch (e) {
    console.error("Init error during schedule load:", e);
    updateTable(); // Fallback render
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
