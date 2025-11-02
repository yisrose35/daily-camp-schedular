// -------------------- app2.js --------------------
// Leagues (teams != bunks) render as merged cells per division+slot.
// Ensures no two divisions have leagues at the same time (span-aware).

// ===== Helpers: time / labels =====
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

// ===== Fixed activities =====
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
  if (window.DailyActivities && typeof window.DailyActivities.prePlace === "function") {
    try {
      window.DailyActivities.prePlace();
    } catch (e) {
      console.error("DailyActivities.prePlace error:", e);
    }
  }
  return computeBlockedRowsByDiv();
}

// ===== League helpers =====
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
  const result = {}; // { [div]: { name, data } }
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

// Round-robin (teams are league teams, not bunks)
(function () {
  "use strict";
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

// ===== League Sport Rotation Tracker =====
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

/**
 * Assigns sports to each matchup, aiming for variety within a single round.
 * Persists per-league rotation state so variety continues between days.
 */
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

// ====== CORE STATE ======
window.leagueAssignments = window.leagueAssignments || {};

function assignFieldsToBunks() {
  // ... setup globals & basic structures ...
  window.scheduleAssignments = window.scheduleAssignments || {};
  window.availableDivisions = Array.isArray(window.availableDivisions)
    ? window.availableDivisions
    : [];
  window.divisions = window.divisions || {};
  window.fields = Array.isArray(window.fields) ? window.fields : [];
  window.specialActivities = Array.isArray(window.specialActivities)
    ? window.specialActivities
    : [];
  window.unifiedTimes = Array.isArray(window.unifiedTimes)
    ? window.unifiedTimes
    : [];
  window.divisionActiveRows = window.divisionActiveRows || {};
  window.leagueAssignments = {};

  const incEl = document.getElementById("increment");
  const inc = incEl ? parseInt(incEl.value, 10) : 30;
  const durationEl = document.getElementById("activityDuration");
  const activityDuration = durationEl
    ? parseInt(durationEl.value, 10)
    : 30;
  const spanLen = Math.max(1, Math.ceil(activityDuration / inc));

  const availFields = fields.filter(
    (f) => f?.available && Array.isArray(f.activities) && f.activities.length > 0
  );
  const availSpecials = specialActivities.filter((s) => s?.available);

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
  if (allActivities.length === 0 || unifiedTimes.length === 0) {
    console.warn("No activities or time grid available. Aborting.");
    scheduleAssignments = {};
    return;
  }

  // Reset per-bunk grid
  scheduleAssignments = {};
  availableDivisions.forEach((div) => {
    (divisions[div]?.bunks || []).forEach((b) => {
      scheduleAssignments[b] = new Array(unifiedTimes.length);
    });
  });

  const priorityDivs = [...availableDivisions].reverse();
  const globalResourceUsage = {};
  const occupiedFieldsBySlot = Array.from(
    { length: unifiedTimes.length },
    () => new Set()
  );
  const globalActivityLock = Array.from(
    { length: unifiedTimes.length },
    () => new Set()
  );

  const usedActivityKeysByBunk = {};
  const fieldsUsedByBunk = {};
  availableDivisions.forEach((div) => {
    (divisions[div]?.bunks || []).forEach((b) => {
      usedActivityKeysByBunk[b] = new Set();
      fieldsUsedByBunk[b] = new Set();
    });
  });

  function canUseField(fieldName, start, end, s) {
    if (!fieldName) return false;
    for (let k = 0; k < spanLen; k++) {
      const idx = s + k;
      if (idx >= unifiedTimes.length) break;
      if (occupiedFieldsBySlot[idx].has(fieldName)) return false;
    }
    if (globalResourceUsage[fieldName]) {
      for (const r of globalResourceUsage[fieldName])
        if (start < r.end && end > r.start) return false;
    }
    return true;
  }
  function reserveField(fieldName, start, end, s, sportName = null, len = spanLen) {
    if (!fieldName) return;
    if (!globalResourceUsage[fieldName]) globalResourceUsage[fieldName] = [];
    globalResourceUsage[fieldName].push({ start, end });
    for (let k = 0; k < len; k++) {
      const idx = s + k;
      if (idx >= unifiedTimes.length) break;
      occupiedFieldsBySlot[idx].add(fieldName);
      if (sportName) globalActivityLock[idx].add(sportName.toLowerCase());
    }
  }

  const blockedRowsByDiv = prePlaceFixedActivities();

  // ===== 1) PLACE LEAGUES (per-division) =====
  const enabledByDiv = getEnabledLeaguesByDivision();
  const takenLeagueSlots = new Set();
  const slotConflict = (s) => {
    for (let k = 0; k < spanLen; k++) if (takenLeagueSlots.has(s + k)) return true;
    return false;
  };
  const markTaken = (s) => {
    for (let k = 0; k < spanLen; k++) takenLeagueSlots.add(s + k);
  };

  for (const div of priorityDivs) {
    const lg = enabledByDiv[div];
    if (!lg) continue;

    const actSet = window.divisionActiveRows?.[div];
    const actSlots =
      actSet && actSet.size > 0
        ? Array.from(actSet)
        : window.unifiedTimes.map((_, i) => i);

    const candidates = actSlots.filter((s) => {
      if (blockedRowsByDiv[div]?.has(s)) return false;
      if ((divisions[div]?.bunks || []).some((b) => scheduleAssignments[b]?.[s]))
        return false;
      return !slotConflict(s);
    });
    if (candidates.length === 0) continue;

    const chosenSlot = candidates[0];
    const teams = (lg.data.teams || []).map((t) => String(t || "").trim()).filter(Boolean);
    if (teams.length < 2) continue;

    const matchups = window.getLeagueMatchups?.(lg.name, teams) || [];
    if (matchups.length === 0) continue;

    const assignedGames = assignSportsToMatchups(lg.name, matchups, lg.data.sports);
    window.leagueAssignments[div] = window.leagueAssignments[div] || {};
    window.leagueAssignments[div][chosenSlot] = { games: assignedGames, leagueName: lg.name };

    blockedRowsByDiv[div] = blockedRowsByDiv[div] || new Set();
    for (let k = 0; k < spanLen; k++) blockedRowsByDiv[div].add(chosenSlot + k);
    markTaken(chosenSlot);
  }

  // ===== 2) Fill general activities =====
  const PLACEHOLDER_NAME = "Special Activity Needed";
  const baseFeasible = (act, bunk, s, start, end) => {
    const fname = fieldLabel(act.field);
    if (!fname || !canUseField(fname, start, end, s)) return false;
    if (act.sport && globalActivityLock[s].has(act.sport.toLowerCase())) return false;
    return true;
  };
  function chooseActivity(bunk, start, end, s) {
    const pool = allActivities.filter((a) => baseFeasible(a, bunk, s, start, end));
    return pool.length
      ? pool[Math.floor(Math.random() * pool.length)]
      : { type: "special", field: { name: PLACEHOLDER_NAME } };
  }

  for (let s = 0; s < unifiedTimes.length; s++) {
    const start = unifiedTimes[s].start;
    const end = new Date(start.getTime() + activityDuration * 60000);
    for (const div of priorityDivs) {
      if (window.leagueAssignments?.[div]?.[s]) continue;
      if (blockedRowsByDiv[div]?.has(s)) continue;
      const active = window.divisionActiveRows?.[div]?.has(s) ?? true;
      if (!active) continue;

      for (const bunk of divisions[div]?.bunks || []) {
        if (scheduleAssignments[bunk][s]) continue;
        const chosen = chooseActivity(bunk, start, end, s);
        const fname = fieldLabel(chosen.field);
        scheduleAssignments[bunk][s] = { field: fname, sport: chosen.sport || null, continuation: false };
        if (fname !== PLACEHOLDER_NAME) reserveField(fname, start, end, s, chosen.sport);
      }
    }
  }

  updateTable();
  saveSchedule();
}

// ===== Rendering =====
function updateTable() {
  const container = document.getElementById("schedule");
  if (!container) return;
  container.innerHTML = "";
  if (!unifiedTimes.length) return;

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const tr1 = document.createElement("tr");
  const timeTh = document.createElement("th");
  timeTh.textContent = "Time";
  tr1.appendChild(timeTh);
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
  for (let i = 0; i < unifiedTimes.length; i++) {
    const tr = document.createElement("tr");
    const tdTime = document.createElement("td");
    tdTime.textContent = unifiedTimes[i].label;
    tr.appendChild(tdTime);

    availableDivisions.forEach((div) => {
      const league = window.leagueAssignments?.[div]?.[i];
      const bunks = divisions[div]?.bunks || [];
      if (league) {
        const td = document.createElement("td");
        td.colSpan = bunks.length;
        td.style.background = divisions[div]?.color || "#4CAF50";
        td.style.color = "#fff";
        td.style.fontWeight = "600";
        const list = league.games
          .map((g) => `${g.teams[0]} vs ${g.teams[1]} (${g.sport})`)
          .join(" • ");
        td.innerHTML = `<div class="league-pill">${list}<br><span style="font-size:0.85em;">${league.leagueName}</span></div>`;
        tr.appendChild(td);
      } else {
        bunks.forEach((b) => {
          const entry = scheduleAssignments[b]?.[i];
          const td = document.createElement("td");
          if (entry?.field === "Special Activity Needed")
            td.innerHTML = `<span style="color:#c0392b;">${entry.field}</span>`;
          else if (entry?.sport)
            td.textContent = `${entry.field} – ${entry.sport}`;
          else td.textContent = entry?.field || "";
          tr.appendChild(td);
        });
      }
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

function saveSchedule() {
  try {
    localStorage.setItem("scheduleAssignments", JSON.stringify(scheduleAssignments));
    localStorage.setItem("leagueAssignments", JSON.stringify(window.leagueAssignments || {}));
  } catch (e) {
    console.error("Save schedule failed:", e);
  }
}
function reconcileOrRenderSaved() {
  try {
    window.scheduleAssignments = JSON.parse(localStorage.getItem("scheduleAssignments") || "{}") || {};
    window.leagueAssignments = JSON.parse(localStorage.getItem("leagueAssignments") || "{}") || {};
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
