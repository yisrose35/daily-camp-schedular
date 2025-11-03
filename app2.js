// -------------------- app2.js --------------------
// Leagues render as merged cells per division+slot with per-matchup sports.
// Fixed activities show names properly; early/late times grey per division.
// 2025-11-02: Fix 15min increment vs 30min activity bug (per-division spans/blocks).

// ===== Helpers =====
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

// ===== Fixed Activities =====
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
  if (window.DailyActivities?.prePlace) {
    try {
      window.DailyActivities.prePlace();
    } catch (e) {
      console.error("DailyActivities.prePlace error:", e);
    }
  }
  return computeBlockedRowsByDiv();
}

// ===== League Helpers =====
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
  const result = {};
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

// ===== Round-Robin Generator =====
(function () {
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

// ===== League Sport Rotation =====
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

// ====== CORE ASSIGN ======
window.leagueAssignments = window.leagueAssignments || {};
// We'll also store spans to respect multi-increment activities on render.
window.leagueSpans = window.leagueSpans || {}; // { [div]: { [startRow]: spanLen } }

function assignFieldsToBunks() {
  window.scheduleAssignments = window.scheduleAssignments || {};
  window.leagueAssignments = {};
  window.leagueSpans = {};

  const inc = parseInt(document.getElementById("increment")?.value || "30", 10);
  const activityDuration = parseInt(
    document.getElementById("activityDuration")?.value || "30",
    10
  );
  const spanLen = Math.max(1, Math.ceil(activityDuration / inc));

  const availFields = (window.fields || []).filter(
    (f) => f?.available && Array.isArray(f.activities) && f.activities.length
  );
  const availSpecials = (window.specialActivities || []).filter((s) => s?.available);

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
  if (!allActivities.length || !window.unifiedTimes?.length) return;

  // Init grids
  window.scheduleAssignments = {};
  (window.availableDivisions || []).forEach((d) =>
    (window.divisions?.[d]?.bunks || []).forEach(
      (b) => (window.scheduleAssignments[b] = new Array(window.unifiedTimes.length))
    )
  );

  // Blocked rows come from fixed activities; we'll extend with league continuations.
  const blockedRowsByDivFixed = prePlaceFixedActivities();
  const blockedRowsByDiv = {}; // dynamic + fixed union queried ad-hoc

  // Per-division league mapping + per-division taken slots (so divisions don't fight)
  const enabledByDiv = getEnabledLeaguesByDivision();
  const takenLeagueSlotsByDiv = {}; // { [div]: Set(rows) }

  // Helper to check if a row is blocked for a division
  const isBlocked = (div, row) =>
    (blockedRowsByDivFixed?.[div]?.has(row)) ||
    (blockedRowsByDiv?.[div]?.has(row));

  // Place one league block per enabled division (if possible)
  for (const div of (window.availableDivisions || [])) {
    const lg = enabledByDiv[div];
    if (!lg) continue;
    const actSet = window.divisionActiveRows?.[div];
    const actSlots =
      actSet && actSet.size
        ? Array.from(actSet)
        : window.unifiedTimes.map((_, i) => i);

    const takenSet = (takenLeagueSlotsByDiv[div] = takenLeagueSlotsByDiv[div] || new Set());
    const candidates = actSlots.filter((s) => {
      // Need a contiguous span for this division
      for (let k = 0; k < spanLen; k++) {
        const idx = s + k;
        if (idx >= window.unifiedTimes.length) return false;
        if (isBlocked(div, idx)) return false;
        if (takenSet.has(idx)) return false;
      }
      return true;
    });

    if (!candidates.length) continue;

    const chosen = candidates[0];

    const teams = (lg.data.teams || []).map((t) => String(t).trim()).filter(Boolean);
    if (teams.length < 2) continue;

    const matchups = window.getLeagueMatchups?.(lg.name, teams) || [];
    if (!matchups.length) continue;

    const games = assignSportsToMatchups(lg.name, matchups, lg.data.sports);

    window.leagueAssignments[div] = window.leagueAssignments[div] || {};
    window.leagueSpans[div] = window.leagueSpans[div] || {};
    window.leagueAssignments[div][chosen] = { games, leagueName: lg.name };
    window.leagueSpans[div][chosen] = spanLen;

    // Reserve the entire span for this division so general fill won't creep in
    blockedRowsByDiv[div] = blockedRowsByDiv[div] || new Set();
    for (let k = 0; k < spanLen; k++) {
      const idx = chosen + k;
      if (idx >= window.unifiedTimes.length) break;
      takenSet.add(idx);
      blockedRowsByDiv[div].add(idx);
    }
  }

  // Fill general activities
  for (let s = 0; s < window.unifiedTimes.length; s++) {
    for (const div of (window.availableDivisions || [])) {
      if (window.leagueAssignments?.[div]?.[s]) continue;       // league start row
      if (isBlocked(div, s)) continue;                          // fixed or league continuation
      const active = window.divisionActiveRows?.[div]?.has(s) ?? true;
      if (!active) continue;

      for (const bunk of window.divisions?.[div]?.bunks || []) {
        if (window.scheduleAssignments[bunk][s]) continue;
        const pick =
          allActivities[Math.floor(Math.random() * allActivities.length)];
        window.scheduleAssignments[bunk][s] = {
          field: fieldLabel(pick.field),
          sport: pick.sport,
          continuation: false,
        };
      }
    }
  }

  updateTable();
  saveSchedule();
}

// ===== RENDERING (per-division grey-out + league continuations) =====
function updateTable() {
  const container = document.getElementById("schedule");
  if (!container) return;
  container.innerHTML = "";
  if (!window.unifiedTimes?.length) return;

  const table = document.createElement("table");

  // Header
  const thead = document.createElement("thead");
  const tr1 = document.createElement("tr");
  const thTime = document.createElement("th");
  thTime.textContent = "Time";
  tr1.appendChild(thTime);
  (window.availableDivisions || []).forEach((div) => {
    const th = document.createElement("th");
    th.colSpan = (window.divisions?.[div]?.bunks || []).length;
    th.textContent = div;
    th.style.background = window.divisions?.[div]?.color || "#333";
    th.style.color = "#fff";
    tr1.appendChild(th);
  });
  thead.appendChild(tr1);

  const tr2 = document.createElement("tr");
  const bunkTh = document.createElement("th");
  bunkTh.textContent = "Bunk";
  tr2.appendChild(bunkTh);
  (window.availableDivisions || []).forEach((div) => {
    (window.divisions?.[div]?.bunks || []).forEach((b) => {
      const th = document.createElement("th");
      th.textContent = b;
      tr2.appendChild(th);
    });
  });
  thead.appendChild(tr2);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  // cache start/end per division
  const divTimeRanges = {};
  (window.availableDivisions || []).forEach((div) => {
    const s = parseTimeToMinutes(window.divisions?.[div]?.start);
    const e = parseTimeToMinutes(window.divisions?.[div]?.end);
    divTimeRanges[div] = { start: s, end: e };
  });

  // helper: is this row inside a league continuation for a division?
  function leagueContinuationAt(div, row) {
    const spans = window.leagueSpans?.[div] || {};
    for (const startRowStr of Object.keys(spans)) {
      const startRow = parseInt(startRowStr, 10);
      const span = spans[startRow];
      if (row > startRow && row < startRow + span) return { startRow, span };
    }
    return null;
  }

  for (let i = 0; i < window.unifiedTimes.length; i++) {
    const tr = document.createElement("tr");
    const tdTime = document.createElement("td");
    tdTime.textContent = window.unifiedTimes[i].label;
    tr.appendChild(tdTime);

    const mid =
      (window.unifiedTimes[i].start.getHours() * 60 +
        window.unifiedTimes[i].start.getMinutes() +
        window.unifiedTimes[i].end.getHours() * 60 +
        window.unifiedTimes[i].end.getMinutes()) / 2;

    (window.availableDivisions || []).forEach((div) => {
      const { start, end } = divTimeRanges[div];
      const bunks = window.divisions?.[div]?.bunks || [];
      const outside =
        (start != null && mid < start) || (end != null && mid >= end);
      const league = window.leagueAssignments?.[div]?.[i];
      const cont = leagueContinuationAt(div, i);

      if (outside) {
        const td = document.createElement("td");
        td.colSpan = bunks.length;
        td.className = "grey-cell";
        td.style.background = "#ddd";
        td.textContent = "—";
        tr.appendChild(td);
        return;
      }

      if (league) {
        const td = document.createElement("td");
        td.colSpan = bunks.length;
        td.style.background = window.divisions?.[div]?.color || "#4CAF50";
        td.style.color = "#fff";
        td.style.fontWeight = "600";
        const list = league.games
          .map((g) => `${g.teams[0]} vs ${g.teams[1]} (${g.sport})`)
          .join(" • ");
        td.innerHTML = `<div class="league-pill">${list}<br><span style="font-size:0.85em;">${league.leagueName}</span></div>`;
        tr.appendChild(td);
        return;
      }

      if (cont) {
        const td = document.createElement("td");
        td.colSpan = bunks.length;
        // slightly lighter continuation shade from division color
        td.style.background = "#f3f6fa";
        td.style.color = "#666";
        td.style.fontStyle = "italic";
        td.textContent = "—";
        tr.appendChild(td);
        return;
      }

      // Normal cells
      bunks.forEach((b) => {
        const entry = window.scheduleAssignments[b]?.[i];
        const td = document.createElement("td");
        if (!entry) {
          tr.appendChild(td);
          return;
        }
        if (entry._fixed) {
          td.textContent = fieldLabel(entry.field);
          td.style.background = "#f1f1f1";
          td.style.fontWeight = "600";
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

// ===== Save/Init =====
function saveSchedule() {
  try {
    localStorage.setItem("scheduleAssignments", JSON.stringify(window.scheduleAssignments));
    localStorage.setItem("leagueAssignments", JSON.stringify(window.leagueAssignments || {}));
    localStorage.setItem("leagueSpans", JSON.stringify(window.leagueSpans || {}));
  } catch (e) {
    console.error("Save schedule failed:", e);
  }
}
function reconcileOrRenderSaved() {
  try {
    window.scheduleAssignments = JSON.parse(localStorage.getItem("scheduleAssignments") || "{}") || {};
    window.leagueAssignments = JSON.parse(localStorage.getItem("leagueAssignments") || "{}") || {};
    window.leagueSpans = JSON.parse(localStorage.getItem("leagueSpans") || "{}") || {};
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
