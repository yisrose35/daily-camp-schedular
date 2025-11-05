// -------------------- scheduler_ui.js (Part 2 of 2) --------------------
// This is the "INTERFACE". It contains all the logic for
// DRAWING the schedule table and handling save/load/init.
//
// =================================================================

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

  // Body
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
          const prevMid =
            (unifiedTimes[i - 1].start.getHours() * 60 +
              unifiedTimes[i - 1].start.getMinutes() +
              unifiedTimes[i - 1].end.getHours() * 60 +
              unifiedTimes[i - 1].end.getMinutes()) /
            2;
          const prevOutside =
            (start != null && prevMid < start) ||
            (end != null && prevMid >= end);
          if (prevOutside) covered = true;
        }
        if (!covered) {
          let span = 1;
          for (let j = i + 1; j < unifiedTimes.length; j++) {
            const nextMid =
              (unifiedTimes[j].start.getHours() * 60 +
                unifiedTimes[j].start.getMinutes() +
                unifiedTimes[j].end.getHours() * 60 +
                unifiedTimes[j].end.getMinutes()) /
              2;
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
  for (const bunk of slotBunks) {
    if (bunksAssigned.has(bunk)) continue; // Already in an H2H game

    const div = bunkToDivision[bunk];
    const preferred = shuffle(allActivities.filter(p => !generalActivityHistory[bunk].has(getActivityName(p))));
    const nonPreferred = shuffle(allActivities.filter(p => generalActivityHistory[bunk].has(getActivityName(p))));
    
    let chosenPick = null;

    // Try Preferred
    for (const pick of preferred) {
      const fName = fieldLabel(pick.field);
      if (!slotFields[fName]) continue; // Field not available in this slot
      
      const fieldCap = slotFields[fName].capacity;
      const fieldUsage = fieldsUsed[fName] || 0;
      
      if (fieldUsage < fieldCap) {
        // If field is empty, OR it's sharable and this div is allowed
        if (fieldUsage === 0 || (slotFields[fName].props.sharable && slotFields[fName].props.allowedDivisions.includes(div))) {
          chosenPick = pick;
          break;
        }
      }
    }

    // Try Non-Preferred
    if (!chosenPick) {
      for (const pick of nonPreferred) {
        const fName = fieldLabel(pick.field);
        if (!slotFields[fName]) continue;
        
        // Avoid same field as yesterday
        const actName = getActivityName(pick);
        const yField = generalFieldHistory[bunk][actName];
        if (fName === yField && window.allSchedulableNames.length > 1) continue;
        
        const fieldCap = slotFields[fName].capacity;
        const fieldUsage = fieldsUsed[fName] || 0;
        
        if (fieldUsage < fieldCap) {
          if (fieldUsage === 0 || (slotFields[fName].props.sharable && slotFields[fName].props.allowedDivisions.includes(div))) {
            chosenPick = pick;
            break;
          }
        }
      }
    }
    
    // Add the assignment
    if (chosenPick) {
      assignments.push({ bunk: bunk, pick: chosenPick, isH2H: false, partner: null });
      bunksAssigned.add(bunk);
      const fName = fieldLabel(chosenPick.field);
      fieldsUsed[fName] = (fieldsUsed[fName] || 0) + 1;
    } else {
      // This bunk could not be scheduled
      assignments.push({ bunk: bunk, pick: { field: "Special Activity Needed" }, isH2H: false, partner: null });
      bunksAssigned.add(bunk);
    }
  }

  // 3. Commit all assignments for this slot to the main schedule
  for (const assignment of assignments) {
    const { bunk, pick, isH2H, partner } = assignment;
    const fieldName = fieldLabel(pick.field);
    const sportName = pick.sport || null;
    const div = bunkToDivision[bunk];
    
    for (let k = 0; k < spanLen; k++) {
      const slot = s + k;
      if (slot >= (window.unifiedTimes || []).length) break;
      const cont = k > 0;
      
      if (isH2H) {
        scheduleAssignments[bunk][slot] = { field: fieldName, sport: sportName, continuation: cont, _h2h: true, vs: partner };
        // Also update the field usage in the main map
        if (allSchedulableNames.includes(fieldName)) {
          fieldUsageBySlot[slot] = fieldUsageBySlot[slot] || {};
          fieldUsageBySlot[slot][fieldName] = { count: 2, division: div };
        }
      } else {
        scheduleAssignments[bunk][slot] = { field: fieldName, sport: sportName, continuation: cont };
        // Update field usage
        if (allSchedulableNames.includes(fieldName)) {
          fieldUsageBySlot[slot] = fieldUsageBySlot[slot] || {};
          const usage = fieldUsageBySlot[slot][fieldName]?.count || 0;
          fieldUsageBySlot[slot][fieldName] = { count: usage + 1, division: div };
        }
      }
    }
    
    // Update histories
    if (isH2H) {
      generalActivityHistory[bunk].add(getActivityName(pick));
      generalActivityHistory[partner].add(getActivityName(pick));
      h2hHistory[bunk] = h2hHistory[bunk] || {};
      h2hHistory[partner] = h2hHistory[partner] || {};
      h2hHistory[bunk][partner] = (h2hHistory[bunk][partner] || 0) + 1;
      h2hHistory[partner][bunk] = (h2hHistory[partner][bunk] || 0) + 1;
      h2hGameCount[bunk] = (h2hGameCount[bunk] || 0) + 1;
      h2hGameCount[partner] = (h2hGameCount[partner] || 0) + 1;
    } else if (pick.field !== "Special Activity Needed") {
      generalActivityHistory[bunk].add(getActivityName(pick));
    }
  }
}
 
  updateTable();
  saveSchedule();
}

// ===== This is the end of the logical part of the file =====
// The helper functions were moved to scheduler_ui.js
// to fix the "not defined" errors.

// This file must export the main function
window.assignFieldsToBunks = assignFieldsToBunks;
      // -------------------- scheduler_ui.js (Part 2 of 2) --------------------
// This is the "INTERFACE". It contains all the logic for
// DRAWING the schedule table and handling save/load/init.
//
// =================================================================

// ===== Helpers used by UI (must be in this file) =====
// These were moved from scheduler_logic.js to fix ReferenceErrors

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

  // Body
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
          const prevMid =
            (unifiedTimes[i - 1].start.getHours() * 60 +
              unifiedTimes[i - 1].start.getMinutes() +
              unifiedTimes[i - 1].end.getHours() * 60 +
              unifiedTimes[i - 1].end.getMinutes()) /
        	2;
        	const prevOutside =
            (start != null && prevMid < start) ||
            (end != null && prevMid >= end);
        	if (prevOutside) covered = true;
        }
        if (!covered) {
          let span = 1;
          for (let j = i + 1; j < unifiedTimes.length; j++) {
            const nextMid =
              (unifiedTimes[j].start.getHours() * 60 +
                unifiedTimes[j].start.getMinutes() +
                unifiedTimes[j].end.getHours() * 60 +
                unifiedTimes[j].end.getMinutes()) /
            	2;
            const nextOutside =
              (start != null && nextMid < start) ||
              (end != null && nextMid >= end);
            if (nextOutside) span++;
            else break;
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

      // Fixed
      const firstBunk = bunks.length > 0 ? bunks[0] : null;
      const fixedEntry = firstBunk ? window.scheduleAssignments[firstBunk]?.[i] : null;

      if (fixedEntry && fixedEntry._fixed && !fixedEntry.continuation) {
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
        return;
      }

      // League
      if (league) {
        if (!league.isContinuation) {
          let span = 1;
          for (let j = i + 1; j < unifiedTimes.length; j++) {
            if (window.leagueAssignments?.[div]?.[j]?.isContinuation) span++;
            else break;
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
              return `${g.teams[0]} vs ${g.teams[1]} (${g.sport}) ${gameField}`;
            })
            .join("<br> • ");

          td.innerHTML = `<div class="league-pill">${list}<br><span style="font-size:0.85em;">${league.leagueName}</span></div>`;
          tr.appendChild(td);
        }
        return;
      }

      // General / H2H
      bunks.forEach((b) => {
        const entry = window.scheduleAssignments[b]?.[i];
        if (!entry) {
          const td = document.createElement("td");
          tr.appendChild(td);
          return;
        }
        if (entry.continuation) return;

        let span = 1;
        for (let j = i + 1; j < unifiedTimes.length; j++) {
          if (window.scheduleAssignments[b]?.[j]?.continuation) span++;
          else break;
        }

        const td = document.createElement("td");
        td.rowSpan = span;
        td.style.verticalAlign = "top";

        if (entry._h2h) {
          td.textContent = `${entry.sport} ${entry.field} vs ${entry.vs}`;
          td.style.background = "#e8f4ff";
          td.style.fontWeight = "bold";
        } else if (entry._fixed) {
          td.textContent = fieldLabel(entry.field);
          td.style.background = "#f1f1f1";
          td.style.fontWeight = "600";
        } else if (fieldLabel(entry.field) === "Special Activity Needed") {
          td.innerHTML = `<span style="color:#c0392b;">${fieldLabel(entry.field)}</span>`;
        } else if (entry.sport) {
          td.textContent = `${fieldLabel(entry.field)} – ${entry.sport}`;
    t.style.fontWeight = "600";
        } else if (fieldLabel(entry.field) === "Special Activity Needed") {
          td.innerHTML = `<span style="color:#c0392b;">${fieldLabel(entry.field)}</span>`;
        } else if (entry.sport) {
           td.textContent = `${fieldLabel(entry.field)} – ${entry.sport}`;
s, spanLen, fieldUsageBySlot, isActive, generalActivityHistory, generalFieldHistory, activityProperties);
        }
        // 5. Advance
        if (assignedSpan > 0) { s += (assignedSpan - 1); }
      }
    }
  }

  // Pass 2.5: forced H2H within grade (aggressive), before doubling
  fillRemainingWithForcedH2HPlus(window.availableDivisions || [], window.divisions || {}, spanLen, h2hActivities, fieldUsageBySlot, activityProperties, h2hHistory, h2hGameCount, generalActivityHistory); // Added history

  // Pass 3: aggressive doubling on sharables
  fillRemainingWithDoublingAggressive(window.availableDivisions || [], window.divisions || {}, spanLen, fieldUsageBySlot, activityProperties);

  // Final fallback: sharable specials to remove any blanks
  fillRemainingWithFallbackSpecials(window.availableDivisions || [], window.divisions || {}, spanLen, fieldUsageBySlot, activityProperties);

  updateTable();
  saveSchedule();
}

// ===== Helpers for General/H2H placement =====
function tryGeneralActivity(bunk, div, s, spanLen, activityList, fieldUsageBySlot, isActive, generalActivityHistory, generalFieldHistory, activityProperties) {
  for (const pick of activityList) {
    const pickedField = fieldLabel(pick.field);
    const activityName = getActivityName(pick);
    if (generalFieldHistory && generalFieldHistory[bunk][activityName] === pickedField && (window.allSchedulableNames || []).length > 1) continue; // avoid same field as yesterday when non-preferred
    let [canFit, spanForThisPick] = canActivityFit(bunk, div, s, spanLen, pickedField, fieldUsageBySlot, isActive, activityProperties, false); // false = allow sharing
    if (canFit && spanForThisPick > 0) {
      return assignActivity(bunk, div, s, spanForThisPick, pick, fieldUsageBySlot, generalActivityHistory);
    }
  }
  return 0;
}

function tryH2H(bunk, div, s, spanLen, allBunksInDiv, h2hActivities, fieldUsageBySlot, isActive, activityProperties, h2hHistory, h2hGameCount, generalActivityHistory) {
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
t.style.fontWeight = "600";
        } else if (fieldLabel(entry.field) === "Special Activity Needed") {
          td.innerHTML = `<span style="color:#c0392b;">${fieldLabel(entry.field)}</span>`;
        } else if (entry.sport) {
          td.textContent = `${fieldLabel(entry.field)} – ${entry.sport}`;
        } else {
          td.textContent = fieldLabel(entry.field);
        }
        tr.appendChild(td);
      });
    });

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  container.appendChild(table);
}

// ===== Save/Load/Init =====
function saveSchedule() {
  try {
    window.saveCurrentDailyData?.("scheduleAssignments", window.scheduleAssignments);
    window.saveCurrentDailyData?.("leagueAssignments", window.leagueAssignments);
  } catch (e) {
    console.error("Save schedule failed:", e);
  }
}

function reconcileOrRenderSaved() {
  try {
    const data = window.loadCurrentDailyData?.() || {};
    window.scheduleAssignments = data.scheduleAssignments || {};
    window.leagueAssignments = data.leagueAssignments || {};
  } catch (e) {
    console.error("Reconcile saved failed:", e);
    window.scheduleAssignments = {};
    window.leagueAssignments = {};
  }
  updateTable();
}

function initScheduleSystem() {
  try {
    // Ensure globals exist
    window.scheduleAssignments = window.scheduleAssignments || {};
    window.leagueAssignments = window.leagueAssignments || {};

    // Render whatever is saved for the selected calendar day
    reconcileOrRenderSaved();
  } catch (e) {
    console.error("Init error:", e);
    updateTable();
  }
}

// ===== Exports =====
window.assignFieldsToBunks = window.assignFieldsToBunks || assignFieldsToBunks;
window.updateTable = window.updateTable || updateTable;
window.initScheduleSystem = window.initScheduleSystem || initScheduleSystem;

// If calendar.js changes the date, it should call initScheduleSystem() or
// directly call assignFieldsToBunks() after times are generated. End of file.
