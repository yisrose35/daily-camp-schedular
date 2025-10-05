// -------------------- Scheduling Core (Unified Grid) --------------------
function assignFieldsToBunks() {
  const availFields = fields.filter(f => f.available && f.activities.length > 0);
  const availSpecials = specialActivities.filter(s => s.available);

  const allActivities = [
    ...availFields.flatMap(f =>
      f.activities.map(act => ({ type: "field", field: f, sport: act }))
    ),
    ...availSpecials.map(sa => ({
      type: "special",
      field: { name: sa.name },
      sport: null
    }))
  ];

  if (allActivities.length === 0) {
    alert("No activities available.");
    scheduleAssignments = {};
    return;
  }

  // Reset schedules
  scheduleAssignments = {};
  availableDivisions.forEach(div => {
    divisions[div].bunks.forEach(b => {
      scheduleAssignments[b] = new Array(unifiedTimes.length);
    });
  });

  const inc = parseInt(document.getElementById("increment").value, 10);
  const spanLen = Math.max(1, Math.ceil(activityDuration / inc));

  // -------------------- Resource Locks --------------------
  const globalResourceUsage = {};
  const divisionResourceUsage = {};
  const occupiedFieldsBySlot = Array.from(
    { length: unifiedTimes.length },
    () => new Set()
  );
  const leagueOccupiedBySlot = Array.from(
    { length: unifiedTimes.length },
    () => false
  );

  function overlaps(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
  }

  function canUseResource(div, resourceKey, startTime, endTime, s) {
    if (occupiedFieldsBySlot[s].has(resourceKey)) return false;

    if (globalResourceUsage[resourceKey]) {
      for (const r of globalResourceUsage[resourceKey]) {
        if (overlaps(startTime, endTime, r.start, r.end)) return false;
      }
    }

    if (divisionResourceUsage[div] && divisionResourceUsage[div][resourceKey]) {
      for (const r of divisionResourceUsage[div][resourceKey]) {
        if (overlaps(startTime, endTime, r.start, r.end)) return false;
      }
    }

    for (let k = 0; k < spanLen; k++) {
      const idx = s + k;
      if (idx >= unifiedTimes.length) break;
      if (divisionActiveRows[div] && !divisionActiveRows[div].has(idx)) break;
      if (occupiedFieldsBySlot[idx].has(resourceKey)) return false;
    }

    return true;
  }

  function reserveResource(div, resourceKey, startTime, endTime, s) {
    if (!globalResourceUsage[resourceKey])
      globalResourceUsage[resourceKey] = [];
    if (!divisionResourceUsage[div]) divisionResourceUsage[div] = {};
    if (!divisionResourceUsage[div][resourceKey])
      divisionResourceUsage[div][resourceKey] = [];

    globalResourceUsage[resourceKey].push({ start: startTime, end: endTime });
    divisionResourceUsage[div][resourceKey].push({ start: startTime, end: endTime });

    for (let k = 0; k < spanLen; k++) {
      const idx = s + k;
      if (idx >= unifiedTimes.length) break;
      if (divisionActiveRows[div] && !divisionActiveRows[div].has(idx)) break;
      occupiedFieldsBySlot[idx].add(resourceKey);
    }
  }

  // -------------------- One League Slot Per Enabled Division --------------------
  const leagueSlotByDiv = {};
  availableDivisions.forEach(div => {
    if (leagues[div] && leagues[div].enabled) {
      const active = Array.from(divisionActiveRows[div] || []);
      if (active.length > 0) {
        leagueSlotByDiv[div] =
          active[Math.floor(Math.random() * active.length)];
      }
    }
  });

  const lastActivityByBunk = {};
  const sportsUsedByBunk = {}; // tracks sports already done for the day

  // -------------------- Main Schedule Builder --------------------
  for (let s = 0; s < unifiedTimes.length; s++) {
    const slotStart = unifiedTimes[s].start;
    const slotEnd = new Date(slotStart.getTime() + activityDuration * 60000);

    const usedFieldsByDiv = {};
    availableDivisions.forEach(div => (usedFieldsByDiv[div] = new Set()));

    // 🟩 PRIORITY: younger divisions go first, older go last (older have priority)
    const orderedDivs = [...availableDivisions];

    for (let i = 0; i < orderedDivs.length; i++) {
      const div = orderedDivs[i];
      if (!(divisionActiveRows[div] && divisionActiveRows[div].has(s))) continue;

      for (const bunk of divisions[div].bunks) {
        if (scheduleAssignments[bunk][s] && scheduleAssignments[bunk][s].continuation)
          continue;

        // -------------------- League Logic --------------------
        if (leagueSlotByDiv[div] === s && !leagueOccupiedBySlot[s]) {
          scheduleAssignments[bunk][s] = {
            field: "Leagues",
            sport: null,
            continuation: false,
            isLeague: true
          };
          leagueOccupiedBySlot[s] = true;

          for (let k = 1; k < spanLen; k++) {
            const idx = s + k;
            if (idx >= unifiedTimes.length) break;
            if (!(divisionActiveRows[div] && divisionActiveRows[div].has(idx)))
              break;
            scheduleAssignments[bunk][idx] = {
              field: "Leagues",
              sport: null,
              continuation: true,
              isLeague: true
            };
          }

          lastActivityByBunk[bunk] = {
            field: "Leagues",
            sport: null,
            isLeague: true
          };
          continue;
        }

        // -------------------- Continuation --------------------
        const prev = lastActivityByBunk[bunk];
        if (prev && !prev.isLeague) {
          const prevIdx = s - 1;
          const prevCell = scheduleAssignments[bunk][prevIdx];
          if (prevCell && !prevCell.continuation) {
            let contCount = 1, t = prevIdx + 1;
            while (
              t < s &&
              scheduleAssignments[bunk][t] &&
              scheduleAssignments[bunk][t].continuation
            ) {
              contCount++;
              t++;
            }
            if (contCount < spanLen) {
              scheduleAssignments[bunk][s] = { ...prevCell, continuation: true };
              occupiedFieldsBySlot[s].add(prevCell.field);
              continue;
            }
          }
        }

        // -------------------- Build Candidates --------------------
        let candidates = allActivities.filter(a => {
          if (usedFieldsByDiv[div].has(a.field.name)) return false;
          if (!canUseResource(div, a.field.name, slotStart, slotEnd, s))
            return false;
          return true;
        });

        // Avoid same sport twice in a row OR twice in the same day
        if (prev) candidates = candidates.filter(c => c.sport !== prev.sport);
        if (sportsUsedByBunk[bunk])
          candidates = candidates.filter(
            c => !c.sport || !sportsUsedByBunk[bunk].has(c.sport)
          );

        // 🟧 If no candidate available -> mark as "Special Activity Needed"
        if (candidates.length === 0) {
          scheduleAssignments[bunk][s] = {
            field: "Special Activity Needed",
            sport: null,
            continuation: false,
            isLeague: false
          };
          lastActivityByBunk[bunk] = {
            field: "Special Activity Needed",
            sport: null,
            isLeague: false
          };
          continue;
        }

        // -------------------- Choose & Assign --------------------
        const chosen =
          candidates[Math.floor(Math.random() * candidates.length)];

        scheduleAssignments[bunk][s] = {
          field: chosen.field.name,
          sport: chosen.sport,
          continuation: false,
          isLeague: false
        };

        usedFieldsByDiv[div].add(chosen.field.name);
        if (chosen.type === "field")
          reserveResource(div, chosen.field.name, slotStart, slotEnd, s);
        else occupiedFieldsBySlot[s].add(chosen.field.name);

        // Continuation for activity spanning multiple increments
        for (let k = 1; k < spanLen; k++) {
          const idx = s + k;
          if (idx >= unifiedTimes.length) break;
          if (!(divisionActiveRows[div] && divisionActiveRows[div].has(idx)))
            break;

          scheduleAssignments[bunk][idx] = {
            field: chosen.field.name,
            sport: chosen.sport,
            continuation: true,
            isLeague: false
          };

          if (chosen.type === "field") {
            const contStart = unifiedTimes[idx].start;
            const contEnd = new Date(
              contStart.getTime() + activityDuration * 60000
            );
            reserveResource(div, chosen.field.name, contStart, contEnd, idx);
          } else occupiedFieldsBySlot[idx].add(chosen.field.name);
        }

        // Track sports used today
        if (!sportsUsedByBunk[bunk]) sportsUsedByBunk[bunk] = new Set();
        if (chosen.sport) sportsUsedByBunk[bunk].add(chosen.sport);

        lastActivityByBunk[bunk] = {
          field: chosen.field.name,
          sport: chosen.sport,
          isLeague: false
        };
      }
    }
  }

  updateTable();
}

// -------------------- Rendering (Unified Grid + Merged Cells) --------------------
function updateTable() {
  const scheduleTab = document.getElementById("schedule");
  scheduleTab.innerHTML = "";
  if (unifiedTimes.length === 0) return;

  Object.keys(scheduleAssignments).forEach(b => {
    if (Array.isArray(scheduleAssignments[b])) {
      scheduleAssignments[b].forEach(e => {
        if (e) delete e._skip;
      });
    }
  });

  const table = document.createElement("table");
  table.className = "division-schedule";

  // Header
  const thead = document.createElement("thead");
  const row1 = document.createElement("tr");
  const thTime = document.createElement("th");
  thTime.textContent = "Time";
  row1.appendChild(thTime);

  availableDivisions.forEach(div => {
    const th = document.createElement("th");
    th.colSpan = divisions[div].bunks.length;
    th.textContent = div;
    th.style.background = divisions[div].color;
    th.style.color = "#fff";
    row1.appendChild(th);
  });
  thead.appendChild(row1);

  const row2 = document.createElement("tr");
  const thB = document.createElement("th");
  thB.textContent = "Bunk";
  row2.appendChild(thB);
  availableDivisions.forEach(div => {
    divisions[div].bunks.forEach(b => {
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
      divisions[div].bunks.forEach(b => {
        if (scheduleAssignments[b] && scheduleAssignments[b][s] && scheduleAssignments[b][s]._skip)
          return;
        const td = document.createElement("td");
        const active = activeSet.has(s);

        if (!active) {
          td.className = "grey-cell";
          tr.appendChild(td);
          return;
        }

        const entry = scheduleAssignments[b][s];
        if (entry && !entry.continuation) {
          let span = 1;
          for (let k = s + 1; k < unifiedTimes.length; k++) {
            const e2 = scheduleAssignments[b][k];
            if (!e2 || !e2.continuation || e2.field !== entry.field || e2.sport !== entry.sport)
              break;
            span++;
            scheduleAssignments[b][k]._skip = true;
          }
          td.rowSpan = span;

          if (entry.isLeague)
            td.innerHTML = `<span class="league-pill">Leagues</span>`;
          else if (entry.field === "Special Activity Needed")
            td.innerHTML = `<span class="special-needed">Special Activity Needed</span>`;
          else
            td.textContent = entry.sport
              ? `${entry.field} – ${entry.sport}`
              : entry.field;
        } else if (!entry) td.textContent = "";

        tr.appendChild(td);
      });
    });

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  scheduleTab.appendChild(table);
}

// -------------------- Init --------------------
function initScheduleSystem() {
  const btn = document.getElementById("generateBtn");
  if (btn) btn.onclick = assignFieldsToBunks;

  const saved = localStorage.getItem("scheduleAssignments");
  if (saved) {
    try {
      scheduleAssignments = JSON.parse(saved);
      updateTable();
    } catch (e) {
      console.error("Failed to load saved schedule:", e);
    }
  }
}

function saveSchedule() {
  localStorage.setItem("scheduleAssignments", JSON.stringify(scheduleAssignments));
}

// Auto-save after generating
const originalAssign = assignFieldsToBunks;
assignFieldsToBunks = function() {
  originalAssign();
  saveSchedule();
};

// Initialize when DOM ready
window.addEventListener("DOMContentLoaded", initScheduleSystem);
