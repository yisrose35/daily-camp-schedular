// app2.js
// Fixed Activities (hard precedence) + Unique League Slots (no cross-division overlap)
// + No Repeats per Bunk + No Field Clashes + Save/Load + Safe Rendering

// -------------------- Small helpers --------------------
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

  const inside = [];
  for (let i = 0; i < unifiedTimes.length; i++) {
    const r = unifiedTimes[i];
    const rs = r.start.getHours() * 60 + r.start.getMinutes();
    const re = r.end.getHours() * 60 + r.end.getMinutes();
    if (rs >= startMin && re <= endMin) inside.push(i);
  }
  if (inside.length) return inside;

  // Misaligned: occupy any overlapping rows
  const overlap = [];
  for (let i = 0; i < unifiedTimes.length; i++) {
    const r = unifiedTimes[i];
    const rs = r.start.getHours() * 60 + r.start.getMinutes();
    const re = r.end.getHours() * 60 + r.end.getMinutes();
    if (Math.max(rs, startMin) < Math.min(re, endMin)) overlap.push(i);
  }
  return overlap;
}

function loadActiveFixedActivities() {
  if (window.DailyActivities && typeof window.DailyActivities.prePlace === "function") {
    try {
      const list = window.DailyActivities.prePlace({ dryRun: true });
      return Array.isArray(list) ? list.filter(a => a && a.enabled) : [];
    } catch (e) {
      console.warn("DailyActivities.prePlace() failed; falling back to localStorage.", e);
    }
  }
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

// -------------------- Pre-place Fixed Activities (hard precedence) --------------------
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
          if (scheduleAssignments[bunk][r]?.isFixed) return; // idempotent
          scheduleAssignments[bunk][r] = {
            type: "fixed",
            field: { name: act.name },    // keep object; we normalize on render
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

// -------------------- Main scheduler --------------------
function assignFieldsToBunks() {
  // Defensive guards for globals
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

  // Reset grid
  scheduleAssignments = {};
  availableDivisions.forEach(div => {
    (divisions[div]?.bunks || []).forEach(b => {
      scheduleAssignments[b] = new Array(unifiedTimes.length);
    });
  });

  const incEl = document.getElementById("increment");
  const inc = incEl ? parseInt(incEl.value, 10) : 15;
  const spanLen = Math.max(1, Math.ceil(activityDuration / inc));

  // 0) Pre-place FIXED
  const blockedRowsByDiv = prePlaceFixedActivities();

  // -------------------- Resource locks --------------------
  const globalResourceUsage = {}; // { fieldName: [{start,end}] }
  const occupiedFieldsBySlot = Array.from({ length: unifiedTimes.length }, () => new Set());
  const globalActivityLock = Array.from({ length: unifiedTimes.length }, () => new Set()); // per-slot sport lock

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

  // -------------------- 1) Reserve a UNIQUE League slot per division --------------------
  const leagueSlotByDiv = {};
  const takenLeagueSlots = new Set(); // enforce global uniqueness (no overlaps across grades)

  // We’ll iterate in the order they appear in availableDivisions.
  availableDivisions.forEach(div => {
    const wantsLeague = !!(leagues && leagues[div] && leagues[div].enabled);
    if (!wantsLeague) return;

    const actives = Array.from(divisionActiveRows[div] || []);
    if (actives.length === 0) return;

    const forbidden = new Set(blockedRowsByDiv[div] || []);
    let chosen = null;

    // Prefer earliest valid slot: active, not fixed, not already taken by another division
    for (const s of actives) {
      if (forbidden.has(s)) continue;
      if (takenLeagueSlots.has(s)) continue; // <-- this enforces the "no overlap between grades" rule
      chosen = s;
      break;
    }

    if (chosen == null) {
      console.warn(`No unique league row available for ${div} (blocked by fixed or other leagues).`);
      return; // skip league for this division if we truly can't place it uniquely
    }

    takenLeagueSlots.add(chosen);
    leagueSlotByDiv[div] = chosen;

    // Place league cells for each bunk in this division (respect what's already fixed)
    (divisions[div]?.bunks || []).forEach(b => {
      if (scheduleAssignments[b][chosen]) return; // fixed has precedence
      scheduleAssignments[b][chosen] = {
        field: "Leagues",
        sport: null,
        continuation: false,
        isLeague: true
      };
      // Continuations for spanLen (if your grid encodes longer activities)
      for (let k = 1; k < spanLen; k++) {
        const idx = chosen + k;
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

    // Optional synthetic resource lock (visual separation only)
    const slotStart = unifiedTimes[chosen].start;
    const slotEnd = new Date(slotStart.getTime() + activityDuration * 60000);
    reserveField(`LEAGUE-${div}`, slotStart, slotEnd, chosen, "Leagues");
  });

  // -------------------- 2) Fill remaining cells --------------------
  const usedActivityKeysByBunk = {};
  const fieldsUsedByBunk = {};
  const PLACEHOLDER_NAME = "Special Activity Needed";

  // Seed from pre-placed (fixed & leagues)
  availableDivisions.forEach(div => {
    (divisions[div]?.bunks || []).forEach(b => {
      usedActivityKeysByBunk[b] = new Set();
      fieldsUsedByBunk[b] = new Set();
      (scheduleAssignments[b] || []).forEach(cell => {
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

    // One field per slot globally
    if (act.type === "field" && !canUseField(fieldName, slotStart, slotEnd, s)) return false;

    // Optional per-slot sport uniqueness across fields
    if (act.sport && globalActivityLock[s].has(norm(act.sport))) return false;

    // No repeats per bunk (same sport OR same special)
    const key = activityKey(act);
    if (key && usedActivityKeysByBunk[bunk]?.has(key)) return false;

    // Soft: avoid field reuse for same bunk unless necessary
    if (!allowFieldReuse && fieldsUsedByBunk[bunk]?.has(fieldName)) return false;

    return true;
  }

  function chooseActivity(bunk, slotStart, slotEnd, s, isLeagueRow, div) {
    let candidates;
    if (isLeagueRow && leagues && leagues[div]?.enabled) {
      // Restrict to league sports when in the division's league row
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

    // Nothing valid → placeholder that doesn't affect repeats
    return { type: "special", field: { name: PLACEHOLDER_NAME }, sport: null, _placeholder: true };
  }

  for (let s = 0; s < unifiedTimes.length; s++) {
    const slotStart = unifiedTimes[s].start;
    const slotEnd = new Date(slotStart.getTime() + activityDuration * 60000);

    availableDivisions.forEach(div => {
      if (!(divisionActiveRows[div] && divisionActiveRows[div].has(s))) return;
      const isLeagueRow = leagueSlotByDiv[div] === s;

      (divisions[div]?.bunks || []).forEach(bunk => {
        // Respect pre-placed cells
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

        // Continuations
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

// -------------------- Rendering (ONLY inside #scheduleTable) --------------------
function updateTable() {
  const host = document.getElementById("scheduleTable");
  if (!host) return;
  host.innerHTML = "";

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
          // Normalize field name to handle fixed objects vs strings
          const rawField = entry.field;
          const fieldName = (typeof rawField === "string") ? rawField : (rawField?.name || "");

          // Determine rowSpan by scanning continuations with normalized compare
          let span = 1;
          for (let k = s + 1; k < unifiedTimes.length; k++) {
            const e2 = scheduleAssignments[b]?.[k];
            const e2FieldName = (typeof e2?.field === "string") ? e2.field : (e2?.field?.name || "");
            if (!e2 || !e2.continuation || e2FieldName !== fieldName || e2.sport !== entry.sport) break;
            span++;
            scheduleAssignments[b][k]._skip = true;
          }
          td.rowSpan = span;

          if (entry.isLeague) {
            td.innerHTML = `<span class="league-pill">Leagues</span>`;
          } else if (entry.isFixed) {
            td.innerHTML = `<span class="fixed-pill">${fieldName}</span>`;
          } else if (fieldName === "Special Activity Needed" && !entry.sport) {
            td.innerHTML = `<span class="need-special-pill">${fieldName}</span>`;
          } else {
            td.textContent = entry.sport ? `${fieldName} – ${entry.sport}` : fieldName;
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

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initScheduleSystem);
} else {
  initScheduleSystem();
}
