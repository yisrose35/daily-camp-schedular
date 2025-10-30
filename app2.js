// app2.js
// Scheduling Core: Fixed Activities (hard precedence) + Leagues + No Repeats + No Field Clashes
// Relies on globals from app1.js and optional window.DailyActivities

// -------------------- Helpers --------------------
const norm = s => (typeof s === "string" ? s.trim().toLowerCase() : null);

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
  if (!Array.isArray(unifiedTimes) || unifiedTimes.length === 0) return [];
  const startMin = parseTimeToMinutes(startStr);
  const endMin = parseTimeToMinutes(endStr);
  if (startMin == null || endMin == null || endMin <= startMin) return [];

  const rowsInside = [];
  for (let i = 0; i < unifiedTimes.length; i++) {
    const r = unifiedTimes[i];
    const rs = r.start.getHours() * 60 + r.start.getMinutes();
    const re = r.end.getHours() * 60 + r.end.getMinutes();
    if (rs >= startMin && re <= endMin) rowsInside.push(i);
  }

  if (rowsInside.length > 0) return rowsInside;

  // Misaligned: include any overlapping rows (we still don't shorten fixed)
  const rowsOverlap = [];
  for (let i = 0; i < unifiedTimes.length; i++) {
    const r = unifiedTimes[i];
    const rs = r.start.getHours() * 60 + r.start.getMinutes();
    const re = r.end.getHours() * 60 + r.end.getMinutes();
    const overlaps = Math.max(rs, startMin) < Math.min(re, endMin);
    if (overlaps) rowsOverlap.push(i);
  }
  return rowsOverlap;
}

function loadActiveFixedActivities() {
  // Preferred hook from daily_activities.js
  if (window.DailyActivities && typeof window.DailyActivities.prePlace === "function") {
    try {
      const list = window.DailyActivities.prePlace({ dryRun: true });
      return Array.isArray(list) ? list.filter(a => a && a.enabled) : [];
    } catch (e) {
      console.warn("DailyActivities.prePlace() failed; falling back to localStorage.", e);
    }
  }
  // Fallback keys
  let raw = localStorage.getItem("fixedActivities_v2");
  if (!raw) raw = localStorage.getItem("fixedActivities");
  try {
    const arr = JSON.parse(raw || "[]");
    return Array.isArray(arr) ? arr.filter(a => a && a.enabled) : [];
  } catch {
    return [];
  }
}

function activityKey(act) {
  if (!act) return null;
  if (act.sport && typeof act.sport === "string") return `sport:${norm(act.sport)}`;
  const fname = norm(act.field && act.field.name);
  return fname ? `special:${fname}` : null;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// -------------------- Fixed Activities: Pre-place with precedence --------------------
function prePlaceFixedActivities() {
  const fixed = loadActiveFixedActivities();
  const blockedRowsByDiv = {}; // { div: Set(rowIndex) }

  fixed.forEach(act => {
    const rows = findRowsForRange(act.start, act.end);
    if (rows.length === 0) return;

    const targetDivs = (Array.isArray(act.divisions) && act.divisions.length > 0)
      ? act.divisions
      : (availableDivisions || []);

    targetDivs.forEach(div => {
      const bunksInDiv = (divisions[div]?.bunks) || [];
      if (bunksInDiv.length === 0) return;

      blockedRowsByDiv[div] = blockedRowsByDiv[div] || new Set();
      rows.forEach(r => blockedRowsByDiv[div].add(r));

      bunksInDiv.forEach(bunk => {
        scheduleAssignments[bunk] = scheduleAssignments[bunk] || new Array(unifiedTimes.length);
        rows.forEach((r, idx) => {
          // Don't overwrite if already fixed (idempotent)
          if (scheduleAssignments[bunk][r]?.isFixed) return;
          scheduleAssignments[bunk][r] = {
            type: "fixed",
            field: { name: act.name },
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

// -------------------- Main: assignFieldsToBunks --------------------
function assignFieldsToBunks() {
  // Defensive guards
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

  if (unifiedTimes.length === 0) {
    alert("No time grid available. Generate schedule times first.");
    return;
  }
  if (allActivities.length === 0) {
    // It's ok if there are 0 normal activities; fixed-only day is possible.
    console.warn("No regular activities available; will schedule only fixed + placeholders.");
  }

  // Reset grid to empty arrays per bunk/row
  scheduleAssignments = {};
  availableDivisions.forEach(div => {
    (divisions[div]?.bunks || []).forEach(b => {
      scheduleAssignments[b] = new Array(unifiedTimes.length);
    });
  });

  const incEl = document.getElementById("increment");
  const inc = incEl ? parseInt(incEl.value, 10) : 15;
  const spanLen = Math.max(1, Math.ceil(activityDuration / inc));

  // 0) Pre-place FIXED (hard precedence)
  const blockedRowsByDiv = prePlaceFixedActivities();

  // -------------------- Resource Locks --------------------
  const globalResourceUsage = {}; // { fieldName: [{start,end}] }
  const occupiedFieldsBySlot = Array.from({ length: unifiedTimes.length }, () => new Set());
  const globalActivityLock = Array.from({ length: unifiedTimes.length }, () => new Set()); // per-slot sport lock
  const leagueTimeLocks = [];

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

  // Seed locks from any already-placed FIXED rows (they shouldn't block sports by field name,
  // but we need the cells to remain untouched; the "if (scheduleAssignments[b][s]) continue"
  // checks below are sufficient to protect them)

  // -------------------- 1) Reserve a League slot per division (respect fixed rows) --------------------
  const leagueSlotByDiv = {};
  const priorityDivs = [...availableDivisions]; // keep your natural order

  function divHasFixedAt(div, s) {
    const bunksInDiv = (divisions[div]?.bunks) || [];
    return bunksInDiv.some(b => scheduleAssignments[b]?.[s]?.isFixed);
  }

  priorityDivs.forEach(div => {
    const wantsLeague = !!(leagues && leagues[div] && leagues[div].enabled);
    if (!wantsLeague) return;

    const actives = Array.from(divisionActiveRows[div] || []);
    if (actives.length === 0) return;

    // Filter out any slot where *any* bunk in this division already has a fixed
    const forbidden = new Set(blockedRowsByDiv[div] || []);
    const candidates = actives.filter(s => !forbidden.has(s) && !divHasFixedAt(div, s));

    let chosenSlot = candidates.length ? candidates[0] : null;
    if (chosenSlot == null) {
      console.warn(`No free league row for ${div}; skipping league reservation (fixed activities block all).`);
      return;
    }

    leagueSlotByDiv[div] = chosenSlot;

    // Place "Leagues" for each bunk, but don't overwrite if somehow occupied
    (divisions[div]?.bunks || []).forEach(b => {
      if (scheduleAssignments[b][chosenSlot]) return; // respect fixed/anything pre-placed
      scheduleAssignments[b][chosenSlot] = {
        field: "Leagues",
        sport: null,
        continuation: false,
        isLeague: true
      };
      // Fill continuations
      for (let k = 1; k < spanLen; k++) {
        const idx = chosenSlot + k;
        if (idx >= unifiedTimes.length) break;
        if (!(divisionActiveRows[div] && divisionActiveRows[div].has(idx))) break;
        if (scheduleAssignments[b][idx]) break;
        scheduleAssignments[b][idx] = {
          field: "Leagues",
          sport: null,
          continuation: true,
          isLeague: true
        };
      }
    });

    // Reserve a synthetic resource for visibility (optional)
    const slotStart = unifiedTimes[chosenSlot].start;
    const slotEnd = new Date(slotStart.getTime() + activityDuration * 60000);
    reserveField(`LEAGUE-${div}`, slotStart, slotEnd, chosenSlot, "Leagues");
  });

  // -------------------- 2) Fill remaining cells --------------------
  const usedActivityKeysByBunk = {};
  const fieldsUsedByBunk = {};
  const PLACEHOLDER_NAME = "Special Activity Needed";

  // Seed used-sets from pre-placed cells (fixed counts as a special once per day)
  availableDivisions.forEach(div => {
    (divisions[div]?.bunks || []).forEach(b => {
      usedActivityKeysByBunk[b] = new Set();
      fieldsUsedByBunk[b] = new Set();
      const rowArr = scheduleAssignments[b] || [];
      rowArr.forEach(cell => {
        if (!cell) return;
        if (cell.isFixed) {
          const key = `special:${norm(cell.field?.name || "")}`;
          if (key) usedActivityKeysByBunk[b].add(key);
        } else if (cell.isLeague) {
          const key = `special:${norm("Leagues")}`;
          usedActivityKeysByBunk[b].add(key);
          fieldsUsedByBunk[b].add("Leagues");
        }
      });
    });
  });

  function baseFeasible(act, bunk, slotStart, slotEnd, s, allowFieldReuse) {
    const fieldName = act?.field?.name;
    if (!fieldName) return false;

    // Prevent two bunks on same field in same slot
    if (act.type === "field" && !canUseField(fieldName, slotStart, slotEnd, s)) return false;

    // Optional: avoid same sport used on multiple fields in same slot
    if (act.sport && globalActivityLock[s].has(norm(act.sport))) return false;

    // No repeats per bunk (same sport OR same special name)
    const key = activityKey(act);
    if (key && usedActivityKeysByBunk[bunk]?.has(key)) return false;

    // Soft: avoid same field for the same bunk (unless we must)
    if (!allowFieldReuse && fieldsUsedByBunk[bunk]?.has(fieldName)) return false;

    return true;
  }

  function chooseActivity(bunk, slotStart, slotEnd, s, isLeagueRow, div) {
    let candidates;
    if (isLeagueRow && leagues && leagues[div]?.enabled) {
      const sports = Array.isArray(leagues[div].sports) ? leagues[div].sports : [];
      const leagueActs = [];
      availFields.forEach(f => {
        f.activities.forEach(spt => {
          if (sports.includes(spt)) leagueActs.push({ type: "field", field: f, sport: spt });
        });
      });
      candidates = leagueActs.length ? leagueActs : allActivities;
    } else {
      candidates = allActivities;
    }

    // Tier A: strict (no field reuse)
    let pool = candidates.filter(a => baseFeasible(a, bunk, slotStart, slotEnd, s, false));
    if (pool.length > 0) return pool[Math.floor(Math.random() * pool.length)];

    // Tier B: allow field reuse
    pool = candidates.filter(a => baseFeasible(a, bunk, slotStart, slotEnd, s, true));
    if (pool.length > 0) return pool[Math.floor(Math.random() * pool.length)];

    return { type: "special", field: { name: PLACEHOLDER_NAME }, sport: null, _placeholder: true };
  }

  for (let s = 0; s < unifiedTimes.length; s++) {
    const slotStart = unifiedTimes[s].start;
    const slotEnd = new Date(slotStart.getTime() + activityDuration * 60000);

    availableDivisions.forEach(div => {
      if (!(divisionActiveRows[div] && divisionActiveRows[div].has(s))) return;

      const isLeagueRow = leagueSlotByDiv[div] === s;
      (divisions[div]?.bunks || []).forEach(bunk => {
        // Respect pre-placed cells (fixed/league/continuations)
        if (scheduleAssignments[bunk][s]) return;

        const chosen = chooseActivity(bunk, slotStart, slotEnd, s, isLeagueRow, div);

        scheduleAssignments[bunk][s] = {
          field: chosen.field.name,
          sport: chosen.sport,
          continuation: false,
          isLeague: false
        };

        if (!chosen._placeholder) {
          if (chosen.type === "field") reserveField(chosen.field.name, slotStart, slotEnd, s, chosen.sport);
          const key = activityKey(chosen);
          if (key) usedActivityKeysByBunk[bunk].add(key);
          fieldsUsedByBunk[bunk].add(chosen.field.name);
        }

        // Continuations (spanLen)
        for (let k = 1; k < spanLen; k++) {
          const idx = s + k;
          if (idx >= unifiedTimes.length) break;
          if (!(divisionActiveRows[div] && divisionActiveRows[div].has(idx))) break;
          if (scheduleAssignments[bunk][idx]) break;
          const contStart = unifiedTimes[idx].start;
          const contEnd = new Date(contStart.getTime() + activityDuration * 60000);

          scheduleAssignments[bunk][idx] = {
            field: chosen.field.name,
            sport: chosen.sport,
            continuation: true,
            isLeague: false
          };
          if (!chosen._placeholder && chosen.type === "field") {
            reserveField(chosen.field.name, contStart, contEnd, idx, chosen.sport);
          }
        }
      });
    });
  }

  saveSchedule();
  updateTable();
}

// -------------------- Rendering (writes ONLY into #scheduleTable) --------------------
function updateTable() {
  const host = document.getElementById("scheduleTable");
  if (!host) return;
  host.innerHTML = ""; // clear just the table container

  if (!Array.isArray(unifiedTimes) || unifiedTimes.length === 0) {
    host.textContent = "No time grid. Generate schedule times in Setup.";
    return;
  }

  // Clear prior _skip flags
  Object.keys(scheduleAssignments || {}).forEach(b => {
    (scheduleAssignments[b] || []).forEach(e => { if (e) delete e._skip; });
  });

  const table = document.createElement("table");
  table.className = "division-schedule";

  // Header rows
  const thead = document.createElement("thead");
  const row1 = document.createElement("tr");
  const thTime = document.createElement("th");
  thTime.textContent = "Time";
  row1.appendChild(thTime);

  availableDivisions.forEach(div => {
    const th = document.createElement("th");
    th.colSpan = (divisions[div]?.bunks || []).length;
    th.textContent = div;
    th.style.background = divisions[div]?.color || "#333";
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

  // Body
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

        const entry = scheduleAssignments[b]?.[s];
        if (entry && !entry.continuation) {
          let span = 1;
          for (let k = s + 1; k < unifiedTimes.length; k++) {
            const e2 = scheduleAssignments[b]?.[k];
            if (!e2 || !e2.continuation || e2.field !== entry.field || e2.sport !== entry.sport) break;
            span++;
            scheduleAssignments[b][k]._skip = true;
          }
          td.rowSpan = span;

          if (entry.isLeague) {
            td.innerHTML = `<span class="league-pill">Leagues</span>`;
          } else if (entry.field === "Special Activity Needed" && !entry.sport) {
            td.innerHTML = `<span class="need-special-pill">${entry.field}</span>`;
          } else if (entry.isFixed) {
            td.innerHTML = `<span class="fixed-pill">${entry.field?.name || "Fixed"}</span>`;
          } else {
            td.textContent = entry.sport ? `${entry.field} – ${entry.sport}` : entry.field;
          }
        } else if (!entry) {
          td.textContent = "";
        }
        tr.appendChild(td);
      });
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

// -------------------- Save / Load --------------------
function saveSchedule() {
  try {
    localStorage.setItem("scheduleAssignments", JSON.stringify(scheduleAssignments));
  } catch (e) {
    console.error("Failed to save schedule:", e);
  }
}

function initScheduleSystem() {
  try {
    const saved = localStorage.getItem("scheduleAssignments");
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && typeof parsed === "object") {
        window.scheduleAssignments = parsed;
      }
    }
  } catch (e) {
    console.error("Failed to load saved schedule:", e);
  }
  updateTable();
}

// -------------------- Expose + Auto-Init --------------------
window.assignFieldsToBunks = assignFieldsToBunks;
window.updateTable = updateTable;
window.initScheduleSystem = initScheduleSystem;

// Initialize once DOM is ready so #scheduleTable exists
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initScheduleSystem);
} else {
  initScheduleSystem();
}
