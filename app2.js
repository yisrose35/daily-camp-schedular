// --- Helper Functions for Time Parsing and Fixed Activities ---

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
      const list = window.DailyActivities.prePlace({ dryRun: true });
      return Array.isArray(list) ? list.filter(a => a && a.enabled) : [];
    } catch (e) {
      console.warn("DailyActivities.prePlace() failed; falling back to localStorage.", e);
    }
  }
  // Fallback to localStorage (where you might have manually saved fixed activities)
  let raw = localStorage.getItem("fixedActivities_v2");
  if (!raw) raw = localStorage.getItem("fixedActivities");
  try {
    const arr = JSON.parse(raw || "[]");
    // Ensure all returned activities are explicitly enabled
    return Array.isArray(arr) ? arr.filter(a => a && a.enabled) : [];
  } catch {
    return [];
  }
}

function computeBlockedRowsByDiv() {
  const fixed = loadActiveFixedActivities();
  const blocked = {}; // { div: Set(rowIndex) }
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
  const fixed = loadActiveFixedActivities();
  const blockedRowsByDiv = {}; // { div: Set(rowIndex) }

  fixed.forEach(act => {
    const rows = findRowsForRange(act.start, act.end);
    if (rows.length === 0) return;

    const targetDivs = (Array.isArray(act.divisions) && act.divisions.length > 0)
      ? act.divisions
      : (window.availableDivisions || []);

    targetDivs.forEach(div => {
      const bunksInDiv = (window.divisions[div]?.bunks) || [];
      if (bunksInDiv.length === 0) return;

      blockedRowsByDiv[div] = blockedRowsByDiv[div] || new Set();
      rows.forEach(r => blockedRowsByDiv[div].add(r));

      bunksInDiv.forEach(bunk => {
        window.scheduleAssignments[bunk] = window.scheduleAssignments[bunk] || new Array(window.unifiedTimes.length);
        rows.forEach((r, idx) => {
          if (window.scheduleAssignments[bunk][r]?.isFixed) return; // idempotent
          window.scheduleAssignments[bunk][r] = {
            type: "fixed",
            field: act.name, // Fixed activity name (STRING)
            sport: null,
            continuation: idx > 0,
            isFixed: true
          };
        });
      });
    });
  });

  return blockedRowsByDiv;
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
  window.divisionActiveRows = window.divisionActiveRows || {}; // { div: Set(rowIdx) }

  const availFields = fields.filter(f => f?.available && Array.isArray(f.activities) && f.activities.length > 0);
  const availSpecials = specialActivities.filter(s => s?.available);

  const allActivities = [
    ...availFields.flatMap(f => f.activities.map(act => ({ type: "field", field: f, sport: act }))),
    ...availSpecials.map(sa => ({ type: "special", field: { name: sa.name }, sport: null }))
  ];

  if (allActivities.length === 0 || unifiedTimes.length === 0) {
    alert("No activities or time grid available.");
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

  const incEl = document.getElementById("increment");
  const inc = incEl ? parseInt(incEl.value, 10) : 15;
  const spanLen = Math.max(1, Math.ceil(activityDuration / inc));

  // -------------------- Step 0: Pre-place FIXED Activities (Highest Precedence) --------------------
  // This populates the schedule grid with fixed activities AND returns the rows blocked by division.
  const blockedRowsByDiv = prePlaceFixedActivities();


  // -------------------- Resource Locks --------------------
  const globalResourceUsage = {}; // { fieldName: [{start,end}] } (absolute time overlap guard across multi-slot spans)
  const occupiedFieldsBySlot = Array.from({ length: unifiedTimes.length }, () => new Set()); // per-slot uniqueness
  const globalActivityLock = Array.from({ length: unifiedTimes.length }, () => new Set()); // per-slot sport name lock (avoid same sport on two fields if desired)
  const leagueTimeLocks = []; // list of {start,end} to spread league rows across time

  // Normalizer
  const norm = (s) => (typeof s === "string" ? s.trim().toLowerCase() : null);

  // Per-bunk once-per-day tracker for both sports & specials (ABSOLUTE RULE)
  const usedActivityKeysByBunk = {}; // { bunk: Set<string> }
  // Soft preference: avoid reusing same field for same bunk
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
    // Count all field-sport plays as a single sport key per day regardless of which field
    if (act.sport && typeof act.sport === 'string') return `sport:${norm(act.sport)}`;
    // Count specials (and leagues/fixed) by their special name
    const fname = norm(act.field && act.field.name);
    return fname ? `special:${fname}` : null;
  }

  function overlaps(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
  }

  function canUseField(fieldName, start, end, s) {
    if (!fieldName) return false;
    if (occupiedFieldsBySlot[s].has(fieldName)) return false;
    if (globalResourceUsage[fieldName]) {
      for (const r of globalResourceUsage[fieldName]) {
        if (overlaps(start, end, r.start, r.end)) return false;
      }
    }
    return true;
  }

  function reserveField(fieldName, start, end, s, sportName = null) {
    if (!fieldName) return;
    if (!globalResourceUsage[fieldName]) globalResourceUsage[fieldName] = [];
    globalResourceUsage[fieldName].push({ start, end });
    for (let k = 0; k < spanLen; k++) {
      const idx = s + k;
      if (idx >= unifiedTimes.length) break;
      occupiedFieldsBySlot[idx].add(fieldName);
      if (sportName) globalActivityLock[idx].add(norm(sportName));
    }
  }

  // Helper: global master toggle (neutralized unless you set window.leagueGlobalEnabled = true elsewhere)
  function isGlobalLeaguesDay() {
    return !!window.leagueGlobalEnabled; // default false/undefined → no global effect
  }

  // -------------------- 1) Schedule Guaranteed Leagues --------------------
  const leagueSlotByDiv = {};
  const priorityDivs = [...availableDivisions].reverse(); // older → younger priority
  const globalLeaguesOn = isGlobalLeaguesDay();

  for (const div of priorityDivs) {
    const activeSlots = Array.from(divisionActiveRows[div] || []);
    if (activeSlots.length === 0) continue;

    // PER-DIVISION decision only (no unintended global)
    const wantsLeague = !!(leagues && leagues[div] && leagues[div].enabled);
    if (!wantsLeague) continue;

    // Filter active slots to only those not blocked by a fixed activity
    const nonBlockedSlots = activeSlots.filter(s => {
        // Must be active and NOT blocked by a fixed activity in Step 0
        return !blockedRowsByDiv[div]?.has(s);
    });

    if (nonBlockedSlots.length === 0) {
        console.warn(`[Leagues] No available non-blocked slots found for division ${div}.`);
        continue; // Skip division if all active slots are fixed
    }

    // Choose a spread-out league slot from the available non-blocked slots
    let chosenSlot = null;
    for (const slot of nonBlockedSlots) {
      const slotStart = unifiedTimes[slot].start;
      const slotEnd = new Date(slotStart.getTime() + activityDuration * 60000);
      const clashing = leagueTimeLocks.some(l => overlaps(slotStart, slotEnd, l.start, l.end));
      if (!clashing) {
        chosenSlot = slot; leagueTimeLocks.push({ start: slotStart, end: slotEnd });
        break;
      }
    }
    // Fallback: if spreading fails, just pick the first non-blocked slot
    if (chosenSlot === null) chosenSlot = nonBlockedSlots[0];
    leagueSlotByDiv[div] = chosenSlot;

    const slotStart = unifiedTimes[chosenSlot].start;
    const slotEnd = new Date(slotStart.getTime() + activityDuration * 60000);

    (divisions[div]?.bunks || []).forEach(b => {
      const leagueAct = { type: 'special', field: { name: 'Leagues' }, sport: null };
      const key = activityKey(leagueAct);

      // Check for fixed activity collision (shouldn't happen if we filtered nonBlockedSlots correctly, but defensive check)
      if (scheduleAssignments[b][chosenSlot] && scheduleAssignments[b][chosenSlot].isFixed) {
         console.warn(`[Conflict] League attempt failed for bunk ${b} at slot ${chosenSlot} due to fixed activity.`);
         return; 
      }
      
      scheduleAssignments[b][chosenSlot] = {
        field: 'Leagues',
        sport: null,
        continuation: false,
        isLeague: true
      };

      // Fill continuations
      for (let k = 1; k < spanLen; k++) {
        const idx = chosenSlot + k;
        if (idx >= unifiedTimes.length) break;
        if (!(divisionActiveRows[div] && divisionActiveRows[div].has(idx))) break;
        if (scheduleAssignments[b][idx] && scheduleAssignments[b][idx].isFixed) break; // respect fixed activities during continuation
        
        scheduleAssignments[b][idx] = {
          field: 'Leagues',
          sport: null,
          continuation: true,
          isLeague: true
        };
      }

      if (key) usedActivityKeysByBunk[b].add(key); // counts as special once per day
      fieldsUsedByBunk[b].add('Leagues');
    });

    // Reserve a synthetic field so leagues don’t collide cross-division
    reserveField(`LEAGUE-${div}`, slotStart, slotEnd, chosenSlot, 'Leagues');
  }

  // -------------------- 2) Fill Every Remaining Slot --------------------
  const lastActivityByBunk = {};
  const PLACEHOLDER_NAME = 'Special Activity Needed';

  function baseFeasible(act, bunk, slotStart, slotEnd, s, allowFieldReuse) {
    const fieldName = act?.field?.name;
    if (!fieldName) return false;

    // Prevent two bunks on the same physical field at the same time
    if (!canUseField(fieldName, slotStart, slotEnd, s)) return false;

    // Prevent same sport on multiple fields in the SAME slot (optional lock)
    if (act.sport && globalActivityLock[s].has(norm(act.sport))) return false;

    // ABSOLUTE RULE: never repeat the same sport OR same special for this bunk in the same day
    const key = activityKey(act);
    if (key && usedActivityKeysByBunk[bunk]?.has(key)) return false;

    // Soft: avoid reusing the same field for this bunk unless we must
    if (!allowFieldReuse && fieldsUsedByBunk[bunk]?.has(fieldName)) return false;

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

        scheduleAssignments[bunk][s] = {
          field: chosen.field.name,
          sport: chosen.sport,
          continuation: false,
          isLeague: false
        };

        // Reserve only for real activities
        if (!chosen._placeholder) {
          reserveField(chosen.field.name, slotStart, slotEnd, s, chosen.sport);
        }

        // Continuations over spanLen
        for (let k = 1; k < spanLen; k++) {
          const idx = s + k;
          if (idx >= unifiedTimes.length) break;
          if (!(divisionActiveRows[div] && divisionActiveRows[div].has(idx))) break;
          if (scheduleAssignments[bunk][idx]) break; // already filled by fixed/league/other continuation

          const contStart = unifiedTimes[idx].start;
          const contEnd = new Date(contStart.getTime() + activityDuration * 60000);

          scheduleAssignments[bunk][idx] = {
            field: chosen.field.name,
            sport: chosen.sport,
            continuation: true,
            isLeague: false
          };

          if (!chosen._placeholder) {
            reserveField(chosen.field.name, contStart, contEnd, idx, chosen.sport);
          }
        }

        // Track per-bunk usage (skip placeholder)
        if (!chosen._placeholder) {
          const key = activityKey(chosen);
          if (key) usedActivityKeysByBunk[bunk].add(key);
          fieldsUsedByBunk[bunk].add(chosen.field.name);
        }

        lastActivityByBunk[bunk] = { field: chosen.field.name, sport: chosen.sport, isLeague: false };
      }
    }
  }

  updateTable();
  saveSchedule(); // auto-save each new schedule
}

// -------------------- Rendering --------------------
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
            if (!e2 || !e2.continuation || e2.field !== entry.field || e2.sport !== entry.sport) break;
            span++;
            scheduleAssignments[b][k]._skip = true;
          }
          td.rowSpan = span;

          if (entry.isLeague) {
            td.innerHTML = `<span class="league-pill">Leagues</span>`;
          } else if (entry.isFixed) { // Render fixed activities
            td.innerHTML = `<span class="fixed-pill">${entry.field}</span>`;
          } else if (entry.field === "Special Activity Needed" && !entry.sport) {
            td.innerHTML = `<span class="need-special-pill">${entry.field}</span>`;
          } else {
            td.textContent = entry.sport ? `${entry.field} – ${entry.sport}` : entry.field;
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
  localStorage.setItem("scheduleAssignments", JSON.stringify(scheduleAssignments));
}

function reconcileOrRenderSaved() {
  const saved = localStorage.getItem("scheduleAssignments");
  if (!saved) { updateTable(); return; } // Nothing saved, just render empty table

  let parsed;
  try { parsed = JSON.parse(saved); } catch { parsed = null; }
  if (!parsed || typeof parsed !== "object") { updateTable(); return; }

  // Compute current fixed-blocked rows
  const blocked = computeBlockedRowsByDiv();

  // Detect any saved LEAGUE cell that now conflicts with a FIXED activity
  let conflict = false;
  Object.keys(parsed).forEach(bunk => {
    const div = Object.keys(divisions).find(d => (divisions[d]?.bunks || []).includes(bunk));
    if (!div) return;
    const rows = parsed[bunk] || [];
    rows.forEach((cell, idx) => {
      // Check if saved LEAGUE or REGULAR activity now sits on a FIXED time slot
      if (!cell || cell.isFixed) return; 
      if (blocked[div] && blocked[div].has(idx)) {
         // Also check if the saved activity in the blocked slot is not already a fixed activity 
         // (which would be handled by prePlaceFixedActivities)
         if (!cell.isFixed) {
             conflict = true; 
         }
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
