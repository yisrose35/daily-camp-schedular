// -------------------- Scheduling Core (Unified Grid: Guaranteed Leagues + Full Schedule + No Repeats + No Empty Slots) --------------------
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

  // Reset schedule
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
  const occupiedFieldsBySlot = Array.from({ length: unifiedTimes.length }, () => new Set());
  const globalActivityLock = Array.from({ length: unifiedTimes.length }, () => new Set());
  const leagueTimeLocks = [];

  function overlaps(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
  }

  function canUseField(fieldName, start, end, s) {
    if (occupiedFieldsBySlot[s].has(fieldName)) return false;
    if (globalResourceUsage[fieldName]) {
      for (const r of globalResourceUsage[fieldName]) {
        if (overlaps(start, end, r.start, r.end)) return false;
      }
    }
    return true;
  }

  function reserveField(fieldName, start, end, s, sportName = null) {
    if (!globalResourceUsage[fieldName]) globalResourceUsage[fieldName] = [];
    globalResourceUsage[fieldName].push({ start, end });
    for (let k = 0; k < spanLen; k++) {
      const idx = s + k;
      if (idx >= unifiedTimes.length) break;
      occupiedFieldsBySlot[idx].add(fieldName);
      if (sportName) globalActivityLock[idx].add(sportName);
    }
  }

  // -------------------- 1. Schedule Guaranteed Leagues --------------------
  const leagueSlotByDiv = {};
  const priorityDivs = [...availableDivisions].reverse(); // older → younger

  for (const div of priorityDivs) {
    const activeSlots = Array.from(divisionActiveRows[div] || []);
    if (activeSlots.length === 0) continue;

    const leagueToggle = leagues[div]?.enabled;
    if (!leagueToggle) continue;

    // Always assign one league slot per division
    let chosenSlot = null;
    for (const slot of activeSlots) {
      const slotStart = unifiedTimes[slot].start;
      const slotEnd = new Date(slotStart.getTime() + activityDuration * 60000);
      const overlapsExisting = leagueTimeLocks.some(l =>
        overlaps(slotStart, slotEnd, l.start, l.end)
      );
      if (!overlapsExisting) {
        chosenSlot = slot;
        leagueTimeLocks.push({ start: slotStart, end: slotEnd });
        break;
      }
    }

    if (chosenSlot === null) chosenSlot = activeSlots[0]; // fallback if all overlap
    leagueSlotByDiv[div] = chosenSlot;

    const slotStart = unifiedTimes[chosenSlot].start;
    const slotEnd = new Date(slotStart.getTime() + activityDuration * 60000);

    divisions[div].bunks.forEach(b => {
      scheduleAssignments[b][chosenSlot] = {
        field: "Leagues",
        sport: null,
        continuation: false,
        isLeague: true
      };

      // multi-slot leagues
      for (let k = 1; k < spanLen; k++) {
        const idx = chosenSlot + k;
        if (idx >= unifiedTimes.length) break;
        if (!(divisionActiveRows[div] && divisionActiveRows[div].has(idx))) break;
        scheduleAssignments[b][idx] = {
          field: "Leagues",
          sport: null,
          continuation: true,
          isLeague: true
        };
      }
    });

    reserveField(`LEAGUE-${div}`, slotStart, slotEnd, chosenSlot, "Leagues");
  }

  // -------------------- 2. Fill Every Remaining Slot --------------------
  const lastActivityByBunk = {};
  const sportsUsedByBunk = {};
  const fieldsUsedByBunk = {};

  for (let s = 0; s < unifiedTimes.length; s++) {
    const slotStart = unifiedTimes[s].start;
    const slotEnd = new Date(slotStart.getTime() + activityDuration * 60000);

    for (const div of priorityDivs) {
      if (!(divisionActiveRows[div] && divisionActiveRows[div].has(s))) continue;

      for (const bunk of divisions[div].bunks) {
        if (scheduleAssignments[bunk][s]) continue; // skip leagues or continuations
        const prev = lastActivityByBunk[bunk];

        // build valid activities
        let candidates = allActivities.filter(a => {
          if (!canUseField(a.field.name, slotStart, slotEnd, s)) return false;
          if (a.sport && globalActivityLock[s].has(a.sport)) return false;
          if (prev && a.sport === prev.sport) return false;
          return true;
        });

        // fallback (if nothing valid left)
        if (candidates.length === 0) {
          candidates = allActivities.filter(a => canUseField(a.field.name, slotStart, slotEnd, s));
        }

        // if still empty, pick any available activity
        if (candidates.length === 0) candidates = allActivities;

        const chosen = candidates[Math.floor(Math.random() * candidates.length)];

        scheduleAssignments[bunk][s] = {
          field: chosen.field.name,
          sport: chosen.sport,
          continuation: false,
          isLeague: false
        };

        reserveField(chosen.field.name, slotStart, slotEnd, s, chosen.sport);

        // continuation logic
        for (let k = 1; k < spanLen; k++) {
          const idx = s + k;
          if (idx >= unifiedTimes.length) break;
          if (!(divisionActiveRows[div] && divisionActiveRows[div].has(idx))) break;
          if (scheduleAssignments[bunk][idx]) break;
          scheduleAssignments[bunk][idx] = {
            field: chosen.field.name,
            sport: chosen.sport,
            continuation: true,
            isLeague: false
          };
          const contStart = unifiedTimes[idx].start;
          const contEnd = new Date(contStart.getTime() + activityDuration * 60000);
          reserveField(chosen.field.name, contStart, contEnd, idx, chosen.sport);
        }

        if (!sportsUsedByBunk[bunk]) sportsUsedByBunk[bunk] = new Set();
        if (!fieldsUsedByBunk[bunk]) fieldsUsedByBunk[bunk] = new Set();
        if (chosen.sport) sportsUsedByBunk[bunk].add(chosen.sport);
        fieldsUsedByBunk[bunk].add(chosen.field.name);

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

// -------------------- Rendering --------------------
function updateTable() {
  const scheduleTab = document.getElementById("schedule");
  scheduleTab.innerHTML = "";
  if (unifiedTimes.length === 0) return;

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

  const tbody = document.createElement("tbody");
  for (let s = 0; s < unifiedTimes.length; s++) {
    const tr = document.createElement("tr");
    const tdTime = document.createElement("td");
    tdTime.textContent = unifiedTimes[s].label;
    tr.appendChild(tdTime);

    availableDivisions.forEach(div => {
      const activeSet = divisionActiveRows[div] || new Set();
      divisions[div].bunks.forEach(b => {
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
          if (entry.isLeague) td.innerHTML = `<span class="league-pill">Leagues</span>`;
          else td.textContent = entry.sport ? `${entry.field} – ${entry.sport}` : entry.field;
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
    } catch (e) { console.error("Failed to load saved schedule:", e); }
  }
}

function saveSchedule() {
  localStorage.setItem("scheduleAssignments", JSON.stringify(scheduleAssignments));
}

const originalAssign = assignFieldsToBunks;
assignFieldsToBunks = function () {
  originalAssign();
  saveSchedule();
};

window.addEventListener("DOMContentLoaded", initScheduleSystem);
