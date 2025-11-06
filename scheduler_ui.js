// -------------------- scheduler_ui.js --------------------
// UI-only: rendering, save/load, init, and window exports.
// Depends on helpers from scheduler_logic.js (parseTimeToMinutes, fieldLabel, etc.).

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
