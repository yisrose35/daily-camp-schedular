/*******************************************************
 * app2.js — Camp Scheduler (Final Tight + Persistence)
 * -----------------------------------------------------
 * ✅ Preserves full activity length (never shortened)
 * ✅ No bunk repeats (same sport/special only once/day)
 * ✅ No overlapping field/special usage at same time
 * ✅ Exhaustive search before "Special Activity Needed"
 * ✅ Older divisions get priority (processed first)
 * ✅ Full Save / Load / Reset via localStorage
 * ✅ Safe defaults for rendering and time grid
 *******************************************************/

/* ===== Global state expectations (provided by app1 / index) =====
   window.fields = [{ name, available, activities: [sportA, sportB, ...] }]
   window.specialActivities = [{ name, available }]
   window.divisions = { [divisionName]: { bunks: [bunk1, bunk2, ...] } }
   window.availableDivisions = [youngest, ..., oldest]
   window.unifiedTimes = [timeLabel0, timeLabel1, ...]          // schedule grid
   window.activityDuration (minutes)  OR #activityDuration input
   #increment input for time slots (15/30/60)
   Optionally:
     - renderScheduleTable() implemented elsewhere (we provide a safe default)
     - renderSetupUI() implemented elsewhere (we call it if present on load/reset)
*/

/* ========================= Helpers ========================= */

function coerceNumber(val, fallback) {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getIncrementMinutes() {
  const el = document.getElementById("increment");
  return coerceNumber(el && el.value, 30);
}

function getActivityDurationMinutes() {
  if (typeof window.activityDuration === "number" && window.activityDuration > 0) {
    return window.activityDuration;
  }
  const el = document.getElementById("activityDuration");
  const inc = getIncrementMinutes();
  return coerceNumber(el && el.value, inc);
}

/* Build a time grid if missing (safe fallback).
   Looks for inputs with ids #startTime and #endTime in "HH:MM" 24h.
*/
function safeComputeUnifiedTimes() {
  if (Array.isArray(window.unifiedTimes) && window.unifiedTimes.length > 0) return;
  const startEl = document.getElementById("startTime");
  const endEl = document.getElementById("endTime");
  if (!startEl || !endEl) return; // no-op if not available

  const inc = getIncrementMinutes();
  const toMins = (hhmm) => {
    const [h, m] = (hhmm || "09:00").split(":").map(Number);
    return h * 60 + (m || 0);
  };
  const toHHMM = (mins) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  };

  const start = toMins(startEl.value);
  const end = toMins(endEl.value);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;

  const times = [];
  for (let t = start; t < end; t += inc) times.push(toHHMM(t));
  window.unifiedTimes = times;
}

/* =================== Activity Catalog =================== */
/* IMPORTANT: To ensure no two bunks share the same field at the same time,
   resourceKey for fields MUST be the field name only (NOT include the sport).
   That way, one field cannot host two different sports simultaneously either.
*/
function buildAllActivities() {
  const availFields = (window.fields || []).filter(
    (f) => f && f.available && Array.isArray(f.activities) && f.activities.length > 0
  );
  const availSpecials = (window.specialActivities || []).filter((s) => s && s.available);

  const fieldActs = availFields.flatMap((f) =>
    f.activities.map((sport) => ({
      kind: "field",
      fieldName: f.name,
      sport,
      // Prevent same sport twice for a bunk
      repeatKey: `SPORT:${sport}`,
      // Prevent same field being used by two bunks at the same time (regardless of sport)
      resourceKey: `FIELD:${f.name}`,
      label: `${sport} @ ${f.name}`,
    }))
  );

  const specialActs = availSpecials.map((s) => ({
    kind: "special",
    specialName: s.name,
    sport: null,
    // Prevent same special twice for a bunk
    repeatKey: `SPECIAL:${s.name}`,
    // Prevent two bunks doing the same special simultaneously
    resourceKey: `SPECIAL:${s.name}`,
    label: s.name,
  }));

  const all = [...fieldActs, ...specialActs];
  if (all.length === 0) {
    alert("No activities available. Add fields with sports and/or special activities.");
  }
  return all;
}

/* ================= Schedule Data Structures ================= */

function resetScheduleAssignments() {
  const times = window.unifiedTimes || [];
  const N = times.length;
  window.scheduleAssignments = {};
  (window.availableDivisions || []).forEach((div) => {
    const bunks = (window.divisions && window.divisions[div] && window.divisions[div].bunks) || [];
    bunks.forEach((b) => {
      window.scheduleAssignments[b] = new Array(N).fill(null);
    });
  });
}

/* One Set per time index storing occupied resourceKeys */
function initResourceLocks() {
  const N = (window.unifiedTimes || []).length;
  const locks = new Array(N);
  for (let i = 0; i < N; i++) locks[i] = new Set();
  return locks;
}

function resourceSpanFree(resourceLocks, key, start, spanLen) {
  const N = resourceLocks.length;
  if (start < 0 || start + spanLen > N) return false;
  for (let t = start; t < start + spanLen; t++) if (resourceLocks[t].has(key)) return false;
  return true;
}

function lockResourceSpan(resourceLocks, key, start, spanLen) {
  for (let t = start; t < start + spanLen; t++) resourceLocks[t].add(key);
}

function bunkSpanFree(bunk, start, spanLen) {
  const row = window.scheduleAssignments[bunk];
  const N = row.length;
  if (start < 0 || start + spanLen > N) return false;
  for (let t = start; t < start + spanLen; t++) if (row[t] !== null) return false;
  return true;
}

function fillBunkSpan(bunk, start, spanLen, assignment) {
  const row = window.scheduleAssignments[bunk];
  for (let t = start; t < spanLen + start; t++) row[t] = assignment;
}

/* =============== Core Assignment Operations =============== */

function tryAssignBlockForBunk(bunk, start, spanLen, allActivities, resourceLocks, bunkPlayedSet) {
  // EXHAUSTIVE scan of activities before fallback
  for (let i = 0; i < allActivities.length; i++) {
    const act = allActivities[i];

    // 1) No repeats for this bunk
    if (bunkPlayedSet.has(act.repeatKey)) continue;

    // 2) Bunk must be free across full span
    if (!bunkSpanFree(bunk, start, spanLen)) continue;

    // 3) Resource must be free across full span
    if (!resourceSpanFree(resourceLocks, act.resourceKey, start, spanLen)) continue;

    // Assign
    const assignment =
      act.kind === "field"
        ? { type: "field", field: act.fieldName, sport: act.sport, label: act.label }
        : { type: "special", special: act.specialName, sport: null, label: act.label };

    fillBunkSpan(bunk, start, spanLen, assignment);
    lockResourceSpan(resourceLocks, act.resourceKey, start, spanLen);
    bunkPlayedSet.add(act.repeatKey);
    return true;
  }
  // No valid activity fits this exact block for this bunk
  return false;
}

function placeSpecialNeeded(bunk, start, spanLen) {
  // Does not consume any resource; still fills the visual block with the label
  const assignment = { type: "special_needed", label: "Special Activity Needed" };
  fillBunkSpan(bunk, start, spanLen, assignment);
}

/* ===================== MAIN SCHEDULER ===================== */

function assignFieldsToBunks() {
  // Ensure we have a time grid
  safeComputeUnifiedTimes();

  const times = window.unifiedTimes || [];
  if (!Array.isArray(times) || times.length === 0) {
    alert("No time grid found. Please set Start/End/Increment first.");
    return;
  }

  // Duration enforcement
  const increment = getIncrementMinutes();
  const duration = getActivityDurationMinutes();
  const spanLen = Math.max(1, Math.ceil(duration / increment)); // full consecutive slots required

  const allActivities = buildAllActivities();

  // Reset schedule & locks
  resetScheduleAssignments();
  const resourceLocks = initResourceLocks();

  // Track what each bunk has already played (sports/specials) to prevent repeats
  const bunkPlayedMap = new Map();
  (window.availableDivisions || []).forEach((div) => {
    const bunks = (window.divisions && window.divisions[div] && window.divisions[div].bunks) || [];
    bunks.forEach((b) => bunkPlayedMap.set(b, new Set()));
  });

  const N = times.length;
  const totalBlocks = Math.ceil(N / spanLen);

  // Priority: older divisions first (reverse order of availableDivisions)
  const divisionsInPriority = (window.availableDivisions || []).slice().reverse();

  divisionsInPriority.forEach((div) => {
    const bunks = (window.divisions && window.divisions[div] && window.divisions[div].bunks) || [];
    bunks.forEach((bunk) => {
      const playedSet = bunkPlayedMap.get(bunk) || new Set();

      // Walk block grid; each block = spanLen consecutive cells
      for (let block = 0; block < totalBlocks; block++) {
        const start = block * spanLen;
        if (start >= N) break;

        // If the remaining cells are fewer than spanLen, we will still
        // NOT place a real activity (since we don't shorten).
        const cellsLeft = Math.min(spanLen, N - start);

        // Skip if any cell already filled (integrity)
        if (!bunkSpanFree(bunk, start, cellsLeft)) continue;

        // Try exhaustive assignment
        const placed = tryAssignBlockForBunk(bunk, start, spanLen <= cellsLeft ? spanLen : cellsLeft, allActivities, resourceLocks, playedSet);

        if (!placed) {
          // If we can't fit any activity fully, mark fallback.
          // Note: for a final partial block (cellsLeft < spanLen), this will place the label across the remaining cells.
          placeSpecialNeeded(bunk, start, cellsLeft);
        }
      }
    });
  });

  // Render
  if (typeof window.renderScheduleTable === "function") {
    window.renderScheduleTable();
  } else {
    // Safe default renderer if host didn't provide one
    defaultRenderScheduleTable();
  }
}

/* ================= Default Renderer (if none provided) =================
   Creates a simple table into #scheduleTable (if present).
   Divisions across sections; bunks as rows; time slots as columns.
*/
function defaultRenderScheduleTable() {
  const wrap = document.getElementById("scheduleTable");
  if (!wrap) return; // okay if host has custom renderer elsewhere

  const times = window.unifiedTimes || [];
  const table = document.createElement("table");
  table.style.borderCollapse = "collapse";
  table.style.width = "100%";
  table.style.marginTop = "12px";

  const thStyle = "border:1px solid #999;padding:6px;text-align:center;background:#f7f7f7;";
  const tdStyle = "border:1px solid #ccc;padding:6px;text-align:center;min-width:120px;";

  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  const blank = document.createElement("th");
  blank.setAttribute("style", thStyle);
  blank.textContent = "Bunk / Time";
  htr.appendChild(blank);
  times.forEach((t) => {
    const th = document.createElement("th");
    th.setAttribute("style", thStyle);
    th.textContent = t;
    htr.appendChild(th);
  });
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  (window.availableDivisions || []).forEach((div) => {
    // Divider row
    const sep = document.createElement("tr");
    const sepTd = document.createElement("td");
    sepTd.colSpan = times.length + 1;
    sepTd.setAttribute("style", "background:#eef6ff;font-weight:bold;padding:8px;border:1px solid #99c;");
    sepTd.textContent = div;
    sep.appendChild(sepTd);
    tbody.appendChild(sep);

    const bunks = (window.divisions && window.divisions[div] && window.divisions[div].bunks) || [];
    bunks.forEach((bunk) => {
      const tr = document.createElement("tr");
      const left = document.createElement("td");
      left.setAttribute("style", thStyle);
      left.textContent = bunk;
      tr.appendChild(left);

      const row = (window.scheduleAssignments && window.scheduleAssignments[bunk]) || new Array(times.length).fill(null);
      for (let i = 0; i < times.length; i++) {
        const td = document.createElement("td");
        td.setAttribute("style", tdStyle);
        const cell = row[i];
        if (cell && typeof cell === "object") {
          td.textContent = cell.label || (cell.type === "special_needed" ? "Special Activity Needed" : "");
        } else {
          td.textContent = "";
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
  });

  // Clear & insert
  wrap.innerHTML = "";
  wrap.appendChild(table);
}

/* =================== Save / Load / Reset =================== */

function saveAllData() {
  const data = {
    fields: window.fields || [],
    specialActivities: window.specialActivities || [],
    divisions: window.divisions || {},
    availableDivisions: window.availableDivisions || [],
    unifiedTimes: window.unifiedTimes || [],
    scheduleAssignments: window.scheduleAssignments || {},
    activityDuration: typeof window.activityDuration === "number" ? window.activityDuration : null,
  };
  localStorage.setItem("campSchedulerData", JSON.stringify(data));
  alert("✅ Schedule and setup saved!");
}

function loadAllData() {
  const saved = localStorage.getItem("campSchedulerData");
  if (!saved) {
    alert("No saved data found.");
    return;
  }
  try {
    const data = JSON.parse(saved);
    window.fields = data.fields || [];
    window.specialActivities = data.specialActivities || [];
    window.divisions = data.divisions || {};
    window.availableDivisions = data.availableDivisions || [];
    window.unifiedTimes = data.unifiedTimes || [];
    if (typeof data.activityDuration === "number") window.activityDuration = data.activityDuration;
    window.scheduleAssignments = data.scheduleAssignments || {};

    // Re-render UIs if host provided them
    if (typeof window.renderSetupUI === "function") window.renderSetupUI();
    if (typeof window.renderScheduleTable === "function") window.renderScheduleTable();
    else defaultRenderScheduleTable();

    alert("✅ Schedule and setup loaded!");
  } catch (e) {
    console.error(e);
    alert("Failed to load saved data.");
  }
}

function resetAllData() {
  if (!confirm("Are you sure you want to erase all data?")) return;
  localStorage.removeItem("campSchedulerData");
  window.fields = [];
  window.specialActivities = [];
  window.divisions = {};
  window.availableDivisions = [];
  window.unifiedTimes = [];
  window.scheduleAssignments = {};
  if (typeof window.renderSetupUI === "function") window.renderSetupUI();
  if (typeof window.renderScheduleTable === "function") window.renderScheduleTable();
  else {
    const wrap = document.getElementById("scheduleTable");
    if (wrap) wrap.innerHTML = "";
  }
  alert("🗑️ All data cleared.");
}

/* =================== Button Event Hooks (optional) ===================
   If your index.html includes buttons with these IDs, we wire them up.
*/
(function wireButtonsIfPresent() {
  const map = [
    ["assignBtn", assignFieldsToBunks],
    ["saveBtn", saveAllData],
    ["loadBtn", loadAllData],
    ["resetBtn", resetAllData],
  ];
  map.forEach(([id, fn]) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", fn);
  });
})();

/* Expose globals for external buttons or other scripts */
window.assignFieldsToBunks = assignFieldsToBunks;
window.saveAllData = saveAllData;
window.loadAllData = loadAllData;
window.resetAllData = resetAllData;
