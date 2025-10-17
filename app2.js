/*******************************************************
 * app2.js — Camp Scheduler (Final Tight Version)
 * -----------------------------------------------------
 * ✅ Preserves full activity length (never shortened)
 * ✅ No bunk repeats (same sport/special only once/day)
 * ✅ No overlapping field/special usage
 * ✅ Smart fallback before "Special Activity Needed"
 * ✅ Older divisions get priority
 * ✅ Includes full Save / Load / Reset via localStorage
 *******************************************************/

// ---------- Helpers ----------
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

// ---------- Build All Activities ----------
function buildAllActivities() {
  const availFields = (window.fields || []).filter(f => f.available && Array.isArray(f.activities) && f.activities.length > 0);
  const availSpecials = (window.specialActivities || []).filter(s => s.available);

  const fieldActs = availFields.flatMap(f =>
    f.activities.map(sport => ({
      kind: "field",
      fieldName: f.name,
      sport,
      repeatKey: `SPORT:${sport}`,
      resourceKey: `FIELD:${f.name}:${sport}`,
    }))
  );

  const specialActs = availSpecials.map(s => ({
    kind: "special",
    specialName: s.name,
    sport: null,
    repeatKey: `SPECIAL:${s.name}`,
    resourceKey: `SPECIAL:${s.name}`,
  }));

  const all = [...fieldActs, ...specialActs];
  if (all.length === 0) alert("No activities available. Add fields/sports or specials.");
  return all;
}

// ---------- Schedule Data Structures ----------
function resetScheduleAssignments() {
  window.scheduleAssignments = {};
  const N = (window.unifiedTimes || []).length;
  (window.availableDivisions || []).forEach(div => {
    const bunks = (window.divisions && window.divisions[div] && window.divisions[div].bunks) || [];
    bunks.forEach(b => {
      window.scheduleAssignments[b] = new Array(N).fill(null);
    });
  });
}

function initResourceLocks() {
  const N = (window.unifiedTimes || []).length;
  const locks = new Array(N);
  for (let i = 0; i < N; i++) locks[i] = new Set();
  return locks;
}

function resourceSpanFree(resourceLocks, key, start, span) {
  const N = resourceLocks.length;
  if (start < 0 || start + span > N) return false;
  for (let t = start; t < start + span; t++) {
    if (resourceLocks[t].has(key)) return false;
  }
  return true;
}

function lockResourceSpan(resourceLocks, key, start, span) {
  for (let t = start; t < start + span; t++) resourceLocks[t].add(key);
}

function bunkSpanFree(bunk, start, span) {
  const row = window.scheduleAssignments[bunk];
  const N = row.length;
  if (start < 0 || start + span > N) return false;
  for (let t = start; t < start + span; t++) if (row[t] !== null) return false;
  return true;
}

function fillBunkSpan(bunk, start, span, assignment) {
  const row = window.scheduleAssignments[bunk];
  for (let t = start; t < start + span; t++) row[t] = assignment;
}

// ---------- Assignment Core ----------
function tryAssignBlockForBunk(bunk, start, span, allActivities, resourceLocks, bunkPlayed) {
  for (let i = 0; i < allActivities.length; i++) {
    const act = allActivities[i];
    if (bunkPlayed.has(act.repeatKey)) continue;
    if (!bunkSpanFree(bunk, start, span)) continue;
    if (!resourceSpanFree(resourceLocks, act.resourceKey, start, span)) continue;

    const assignment =
      act.kind === "field"
        ? { type: "field", field: act.fieldName, sport: act.sport, label: `${act.sport} @ ${act.fieldName}` }
        : { type: "special", special: act.specialName, label: act.specialName };

    fillBunkSpan(bunk, start, span, assignment);
    lockResourceSpan(resourceLocks, act.resourceKey, start, span);
    bunkPlayed.add(act.repeatKey);
    return true;
  }
  return false;
}

function placeSpecialNeeded(bunk, start, span) {
  fillBunkSpan(bunk, start, span, { type: "special_needed", label: "Special Activity Needed" });
}

// ---------- MAIN SCHEDULER ----------
function assignFieldsToBunks() {
  const times = window.unifiedTimes || [];
  if (!Array.isArray(times) || times.length === 0) {
    alert("No time grid found. Set Start/End/Increment first.");
    return;
  }

  const inc = getIncrementMinutes();
  const dur = getActivityDurationMinutes();
  const span = Math.max(1, Math.ceil(dur / inc));

  const allActivities = buildAllActivities();
  resetScheduleAssignments();
  const resourceLocks = initResourceLocks();

  const bunkPlayedMap = new Map();
  (window.availableDivisions || []).forEach(div => {
    const bunks = (window.divisions && window.divisions[div] && window.divisions[div].bunks) || [];
    bunks.forEach(b => bunkPlayedMap.set(b, new Set()));
  });

  const N = times.length;
  const blocks = Math.ceil(N / span);
  const divisionsPriority = (window.availableDivisions || []).slice().reverse();

  divisionsPriority.forEach(div => {
    const bunks = (window.divisions && window.divisions[div] && window.divisions[div].bunks) || [];
    bunks.forEach(bunk => {
      const playedSet = bunkPlayedMap.get(bunk) || new Set();
      for (let block = 0; block < blocks; block++) {
        const start = block * span;
        if (start >= N) break;
        const len = Math.min(span, N - start);
        if (!bunkSpanFree(bunk, start, len)) continue;

        const placed = tryAssignBlockForBunk(bunk, start, len, allActivities, resourceLocks, playedSet);
        if (!placed) placeSpecialNeeded(bunk, start, len);
      }
    });
  });

  if (typeof window.renderScheduleTable === "function") window.renderScheduleTable();
}

// ---------- SAVE / LOAD / RESET ----------
function saveAllData() {
  const data = {
    fields: window.fields,
    specialActivities: window.specialActivities,
    divisions: window.divisions,
    availableDivisions: window.availableDivisions,
    unifiedTimes: window.unifiedTimes,
    scheduleAssignments: window.scheduleAssignments,
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
  const data = JSON.parse(saved);
  window.fields = data.fields || [];
  window.specialActivities = data.specialActivities || [];
  window.divisions = data.divisions || {};
  window.availableDivisions = data.availableDivisions || [];
  window.unifiedTimes = data.unifiedTimes || [];
  window.scheduleAssignments = data.scheduleAssignments || {};

  if (typeof window.renderScheduleTable === "function") window.renderScheduleTable();
  if (typeof window.renderSetupUI === "function") window.renderSetupUI();
  alert("✅ Schedule and setup loaded!");
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
  if (typeof window.renderScheduleTable === "function") window.renderScheduleTable();
  if (typeof window.renderSetupUI === "function") window.renderSetupUI();
  alert("🗑️ All data cleared.");
}

// ---------- UI Hook ----------
window.assignFieldsToBunks = assignFieldsToBunks;
window.saveAllData = saveAllData;
window.loadAllData = loadAllData;
window.resetAllData = resetAllData;
