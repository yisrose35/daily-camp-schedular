// app2.js
// Fixed Activities (hard precedence) + Leagues (unique across grades, prefers first free after fixed)
// Auto-rebuilds on constraint changes; no per-bunk repeats; no field clashes; safe render; save/load.

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

  // Misaligned: include any overlappers (we do NOT shorten fixed)
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

// ------------ Constraint Hashing (detect changes -> rebuild) ------------
function stableStringify(obj) {
  const seen = new WeakSet();
  return JSON.stringify(obj, function (key, value) {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return;
      seen.add(value);
      if (value instanceof Set) return { __type: "Set", v: [...value].sort() };
      if (value instanceof Map) return { __type: "Map", v: [...value.entries()].sort() };
      return Object.keys(value).sort().reduce((acc, k) => (acc[k] = value[k], acc), {});
    }
    return value;
  });
}

function normalizeFixedForHash() {
  const list = loadActiveFixedActivities();
  return list.map(a => ({
    name: String(a.name || "").trim(),
    start: String(a.start || "").trim(),
    end: String(a.end || "").trim(),
    divisions: Array.isArray(a.divisions) ? [...a.divisions].sort() : "__ALL__"
  })).sort((a, b) => (a.name + a.start + a.end).localeCompare(b.name + b.start + b.end));
}

function normalizeLeaguesForHash() {
  const out = {};
  (availableDivisions || []).forEach(d => {
    const cfg = (leagues && leagues[d]) || {};
    out[d] = {
      enabled: !!cfg.enabled,
      sports: Array.isArray(cfg.sports) ? [...cfg.sports].sort() : []
    };
  });
  return out;
}

function normalizeActiveRowsForHash() {
  const o = {};
  (availableDivisions || []).forEach(d => {
    const s = divisionActiveRows[d] || new Set();
    o[d] = [...s].sort((x, y) => x - y);
  });
  return o;
}

function normalizeTimeGridForHash() {
  return (unifiedTimes || []).map(r => ({
    label: r.label,
    startM: r.start.getHours() * 60 + r.start.getMinutes(),
    endM: r.end.getHours() * 60 + r.end.getMinutes()
  }));
}

function computeConstraintHash() {
  const incEl = document.getElementById("increment");
  const inc = incEl ? parseInt(incEl.value, 10) : 15;

  const core = {
    divisions: (availableDivisions || []).slice().sort(),
    activeRows: normalizeActiveRowsForHash(),
    leagues: normalizeLeaguesForHash(),
    fixed: normalizeFixedForHash(),
    fields: (fields || []).map(f => ({
      name: f.name, available: !!f.available,
      acts: Array.isArray(f.activities) ? [...f.activities].sort() : []
    })).sort((a, b) => a.name.localeCompare(b.name)),
    specials: (specialActivities || []).map(s => ({
      name: s.name, available: !!s.available
    })).sort((a, b) => a.name.localeCompare(b.name)),
    timeGrid: normalizeTimeGridForHash(),
    activityDuration: activityDuration || 30,
    increment: inc
  };
  return stableStringify(core);
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
          if (scheduleAssignments[bunk][r]?.isFixed) return; // idempotent
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

// -------------------- Main scheduler --------------------
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

  // Reset grid
  scheduleAssignments = {};
  (availableDivisions || []).forEach(div => {
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

  // -------------------- 1) Assign Leagues with NO cross-division overlap
  // Prefer earliest slot AFTER each division's last fixed block --------------------
  const leagueDivs = (availableDivisions || []).filter(d => leagues && leagues[d] && leagues[d].enabled);

  function spanValid(div, s) {
    for (let k = 0; k < spanLen; k++) {
      const idx = s + k;
      if (idx >= unifiedTimes.length) return false;
      if (!(divisionActiveRows[div] && divisionActiveRows[div].has(idx))) return false;
      if (blockedRowsByDiv[div] && blockedRowsByDiv[div].has(idx)) return false;
    }
    return true;
  }

  // Build fixed rows lookup for "prefer-after-fixed"
  const fixedRowsByDiv = (() => {
    const out = {};
    const fixed = loadActiveFixedActivities();
    fixed.forEach(a => {
      const rows = findRowsForRange(a.start, a.end);
      const divs = (Array.isArray(a.divisions) && a.divisions.length) ? a.divisions : (availableDivisions || []);
      divs.forEach(d => {
        out[d] = out[d] || new Set();
        rows.forEach(r => out[d].add(r));
      });
    });
    return out;
  })();

  function lastFixedBefore(div, rowIdx) {
    const set = fixedRowsByDiv[div] || new Set();
    let last = -1;
    set.forEach(r => { if (r < rowIdx && r > last) last = r; });
    return last;
  }

  // Candidate slots per division (ordered to prefer earliest AFTER fixed)
  const candList = leagueDivs.map(div => {
    const actives = Array.from(divisionActiveRows[div] || []);
    const filtered = actives.filter(s => spanValid(div, s));
    const scored = filtered.map(s => {
      const last = lastFixedBefore(div, s);
      const score = (last === -1 ? 1_000_000 : (s - last)); // smaller = closer after fixed
      return { s, score };
    }).sort((a, b) => a.score - b.score || a.s - b.s);
    return { div, slots: scored.map(x => x.s) };
  }).sort((a, b) => a.slots.length - b.slots.length); // fewest options first

  // Backtracking to assign UNIQUE spans to as many divisions as possible
  const usedRows = new Set();
  const leagueSlotByDiv = {};
  let bestMap = null;

  function tryAll(i) {
    if (i === candList.length) {
      bestMap = { ...leagueSlotByDiv };
      return true; // full assignment
    }
    const { div, slots } = candList[i];

    for (const s of slots) {
      let ok = true;
      for (let k = 0; k < spanLen; k++) {
        if (usedRows.has(s + k)) { ok = false; break; }
      }
      if (!ok) continue;

      leagueSlotByDiv[div] = s;
      for (let k = 0; k < spanLen; k++) usedRows.add(s + k);

      if (tryAll(i + 1)) return true;

      delete leagueSlotByDiv[div];
      for (let k = 0; k < spanLen; k++) usedRows.delete(s + k);
    }

    // If we can't place this division without overlap, skip it (no overlaps, per your rule)
    // but still let others be placed.
    const snapshot = { ...leagueSlotByDiv };
    const usedSnap = new Set([...usedRows]);
    if (tryAll(i + 1)) return true; // keep the "best" we found

    // Restore (not strictly necessary due to scopes)
    for (const k in snapshot) leagueSlotByDiv[k] = snapshot[k];
    usedRows.clear(); usedSnap.forEach(v => usedRows.add(v));
    return false;
  }

  tryAll(0);
  const finalLeagueSlots = bestMap || leagueSlotByDiv;

  // Place leagues for divisions that got a unique slot (no overlap ever)
  (leagueDivs || []).forEach(div => {
    const s = finalLeagueSlots[div];
    if (s == null) return; // skipped due to impossibility, will be filled normally

    (divisions[div]?.bunks || []).forEach(b => {
      if (scheduleAssignments[b][s]) return; // respect fixed
      scheduleAssignments[b][s] = {
        field: "Leagues",
        sport: null,
        continuation: false,
        isLeague: true
      };
      // Continuations across spanLen
      for (let k = 1; k < spanLen; k++) {
        const idx = s + k;
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

    // Optional synthetic lock (visual separation)
    const slotStart = unifiedTimes[s].start;
    const slotEnd = new Date(slotStart.getTime() + activityDuration * 60000);
    reserveField(`LEAGUE-${div}`, slotStart, slotEnd, s, "Leagues");
  });

  // -------------------- 2) Fill remaining cells --------------------
  const usedActivityKeysByBunk = {};
  const fieldsUsedByBunk = {};
  const PLACEHOLDER_NAME = "Special Activity Needed";

  // Seed from pre-placed (fixed & leagues)
  (availableDivisions || []).forEach(div => {
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

    if (act.type === "field" && !canUseField(fieldName, slotStart, slotEnd, s)) return false;
    if (act.sport && globalActivityLock[s].has(norm(act.sport))) return false;

    const key = activityKey(act);
    if (key && usedActivityKeysByBunk[bunk]?.has(key)) return false;

    if (!allowFieldReuse && fieldsUsedByBunk[bunk]?.has(fieldName)) return false;

    return true;
  }

  function chooseActivity(bunk, slotStart, slotEnd, s, isLeagueRow, div) {
    let candidatesList;
    if (isLeagueRow && leagues && leagues[div]?.enabled) {
      const sports = Array.isArray(leagues[div].sports) ? leagues[div].sports : [];
      const leagueActs = [];
      availFields.forEach(f => f.activities.forEach(spt => {
        if (sports.includes(spt)) leagueActs.push({ type: "field", field: f, sport: spt });
      }));
      candidatesList = leagueActs.length ? leagueActs : allActivities;
    } else {
      candidatesList = allActivities;
    }

    let pool = candidatesList.filter(a => baseFeasible(a, bunk, slotStart, slotEnd, s, false));
    if (pool.length > 0) return pool[Math.floor(Math.random() * pool.length)];

    pool = candidatesList.filter(a => baseFeasible(a, bunk, slotStart, slotEnd, s, true));
    if (pool.length > 0) return pool[Math.floor(Math.random() * pool.length)];

    return { type: "special", field: { name: PLACEHOLDER_NAME }, sport: null, _placeholder: true };
  }

  for (let s = 0; s < unifiedTimes.length; s++) {
    const slotStart = unifiedTimes[s].start;
    const slotEnd = new Date(slotStart.getTime() + activityDuration * 60000);

    (availableDivisions || []).forEach(div => {
      if (!(divisionActiveRows[div] && divisionActiveRows[div].has(s))) return;
      const isLeagueRow = (leagues && leagues[div]?.enabled) && (finalLeagueSlots[div] === s);

      (divisions[div]?.bunks || []).forEach(bunk => {
        if (scheduleAssignments[bunk][s]) return; // respect pre-placed

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

  // Guard: if constraints changed since last save, rebuild now
  try {
    const currentHash = computeConstraintHash();
    const savedHash = localStorage.getItem("scheduleConstraintHash");
    if (currentHash !== savedHash) {
      console.warn("[Schedule] Constraints changed → regenerating.");
      assignFieldsToBunks();
      return;
    }
  } catch {}

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

  (availableDivisions || []).forEach(div => {
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
  (availableDivisions || []).forEach(div => {
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

    (availableDivisions || []).forEach(div => {
      const activeSet = divisionActiveRows[div] || new Set();
      (divisions[div]?.bunks || []).forEach(b => {
        if (scheduleAssignments[b] && scheduleAssignments[b][s] && scheduleAssignments[b][s]._skip) return;

        const td = document.createElement("td");
        const active = activeSet.has(s);
        if (!active) { td.className = "grey-cell"; tr.appendChild(td); return; }

        const entry = scheduleAssignments[b]?.[s];
        if (entry && !entry.continuation) {
          const rawField = entry.field;
          const fieldName = (typeof rawField === "string") ? rawField : (rawField?.name || "");

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

// -------------------- Save / Load (+ constraint-aware init) --------------------
function saveSchedule() {
  try {
    localStorage.setItem("scheduleAssignments", JSON.stringify(scheduleAssignments));
    localStorage.setItem("scheduleConstraintHash", computeConstraintHash());
  } catch (e) {
    console.error("Failed to save schedule:", e);
  }
}

function loadSavedScheduleIfValid() {
  const saved = localStorage.getItem("scheduleAssignments");
  const savedHash = localStorage.getItem("scheduleConstraintHash");
  if (!saved || !savedHash) return false;

  let parsed;
  try { parsed = JSON.parse(saved); } catch { return false; }

  const currentHash = computeConstraintHash();
  if (savedHash !== currentHash) return false; // constraints changed -> rebuild

  window.scheduleAssignments = parsed;
  return true;
}

function initScheduleSystem() {
  try {
    if (!loadSavedScheduleIfValid()) {
      assignFieldsToBunks(); // builds fresh and saves
    } else {
      updateTable();
    }
  } catch (e) {
    console.error("Init error:", e);
    assignFieldsToBunks();
  }
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

// Optional: quick console diag
window.debugSchedule = function () {
  const incEl = document.getElementById("increment");
  const inc = incEl ? parseInt(incEl.value, 10) : 15;
  const spanLen = Math.max(1, Math.ceil(activityDuration / inc));
  const fixed = loadActiveFixedActivities();
  const blocked = {};
  fixed.forEach(a => {
    const rows = findRowsForRange(a.start, a.end);
    const divs = (Array.isArray(a.divisions) && a.divisions.length) ? a.divisions : (availableDivisions || []);
    divs.forEach(d => {
      blocked[d] = blocked[d] || new Set();
      rows.forEach(r => blocked[d].add(r));
    });
  });
  const rowsByDiv = {};
  (availableDivisions || []).forEach(d => {
    const actives = Array.from(divisionActiveRows[d] || []);
    const candidates = actives.filter(s => {
      for (let k = 0; k < spanLen; k++) {
        const idx = s + k;
        if (idx >= unifiedTimes.length) return false;
        if (!(divisionActiveRows[d] && divisionActiveRows[d].has(idx))) return false;
        if (blocked[d] && blocked[d].has(idx)) return false;
      }
      return true;
    });
    rowsByDiv[d] = { candidates, blocked: [...(blocked[d] || new Set())].sort((a, b) => a - b) };
  });
  console.table(Object.entries(rowsByDiv).map(([div, info]) => ({
    division: div,
    candidate_rows: info.candidates.join(","),
    blocked_rows: info.blocked.join(",")
  })));
};
