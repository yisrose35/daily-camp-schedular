// ===== BEGIN APP2.JS =====
// -------------------- Scheduling Core (Unified Grid: Strict Full-Length Activities + No Field/Special Overlaps) --------------------
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
      sport: sa.name // specials track by name
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

  // -------------------- Global Trackers --------------------
  const usedFieldsByTime = Array.from({ length: unifiedTimes.length }, () => new Set());
  const usedActivitiesByTime = Array.from({ length: unifiedTimes.length }, () => new Set());
  const leagueTimeLocks = [];
  const activitiesUsedByBunk = {};
  const lastActivityByBunk = {};

  function reserveField(fieldName, startSlot) {
    for (let k = 0; k < spanLen; k++) {
      const idx = startSlot + k;
      if (idx >= unifiedTimes.length) break;
      usedFieldsByTime[idx].add(fieldName);
    }
  }

  function canFitFullActivity(startSlot) {
    for (let k = 0; k < spanLen; k++) {
      const idx = startSlot + k;
      if (idx >= unifiedTimes.length) return false;
    }
    return true;
  }

  // -------------------- 1) Leagues --------------------
  const priorityDivs = [...availableDivisions].reverse();
  for (const div of priorityDivs) {
    const activeSlots = Array.from(divisionActiveRows[div] || []);
    if (activeSlots.length === 0) continue;
    const leagueToggle = leagues[div]?.enabled;
    if (!leagueToggle) continue;

    let chosenSlot = null;
    for (const slot of activeSlots) {
      if (!canFitFullActivity(slot)) continue;
      const slotStart = unifiedTimes[slot].start;
      const slotEnd = new Date(slotStart.getTime() + activityDuration * 60000);
      const overlapsExisting = leagueTimeLocks.some(l => slotStart < l.end && l.start < slotEnd);
      if (!overlapsExisting) {
        chosenSlot = slot;
        leagueTimeLocks.push({ start: slotStart, end: slotEnd });
        break;
      }
    }
    if (chosenSlot === null) continue;

    divisions[div].bunks.forEach(b => {
      if (!activitiesUsedByBunk[b]) activitiesUsedByBunk[b] = new Set();
      scheduleAssignments[b][chosenSlot] = {
        field: "Leagues",
        sport: "Leagues",
        continuation: false,
        isLeague: true
      };
      for (let k = 1; k < spanLen; k++) {
        const idx = chosenSlot + k;
        scheduleAssignments[b][idx] = {
          field: "Leagues",
          sport: "Leagues",
          continuation: true,
          isLeague: true
        };
      }
      activitiesUsedByBunk[b].add("Leagues");
    });
    reserveField(`LEAGUE-${div}`, chosenSlot);
  }

  // -------------------- 2) Regular Activities --------------------
  for (let s = 0; s < unifiedTimes.length; s++) {
    for (const div of priorityDivs) {
      if (!(divisionActiveRows[div] && divisionActiveRows[div].has(s))) continue;

      for (const bunk of divisions[div].bunks) {
        if (scheduleAssignments[bunk][s]) continue;
        if (!activitiesUsedByBunk[bunk]) activitiesUsedByBunk[bunk] = new Set();
        const prev = lastActivityByBunk[bunk];

        // skip if not enough time left for full-length activity
        if (!canFitFullActivity(s)) continue;

        // Filter valid candidates
        let candidates = allActivities.filter(a => {
          const fieldName = a.field.name;
          const sportKey = a.sport;
          // check full-length overlap across all spanLen slots
          for (let k = 0; k < spanLen; k++) {
            const idx = s + k;
            if (idx >= unifiedTimes.length) return false;
            if (usedFieldsByTime[idx].has(fieldName)) return false;
          }
          if (activitiesUsedByBunk[bunk].has(sportKey)) return false;
          if (usedActivitiesByTime[s].has(`${fieldName}|${sportKey}`)) return false;
          if (prev && a.sport === prev.sport) return false;
          return true;
        });

        if (candidates.length === 0) {
          scheduleAssignments[bunk][s] = {
            field: "Special Activity Needed",
            sport: "Special Activity Needed",
            continuation: false,
            isLeague: false
          };
          lastActivityByBunk[bunk] = { field: "Special Activity Needed", sport: "Special Activity Needed" };
          continue;
        }

        const chosen = candidates[Math.floor(Math.random() * candidates.length)];
        const fieldName = chosen.field.name;
        const sportKey = chosen.sport;

        // Reserve entire duration before placing
        reserveField(fieldName, s);
        usedActivitiesByTime[s].add(`${fieldName}|${sportKey}`);

        // Assign full-length activity
        scheduleAssignments[bunk][s] = {
          field: fieldName,
          sport: sportKey,
          continuation: false,
          isLeague: false
        };
        for (let k = 1; k < spanLen; k++) {
          const idx = s + k;
          scheduleAssignments[bunk][idx] = {
            field: fieldName,
            sport: sportKey,
            continuation: true,
            isLeague: false
          };
          usedFieldsByTime[idx].add(fieldName);
          usedActivitiesByTime[idx].add(`${fieldName}|${sportKey}`);
        }

        activitiesUsedByBunk[bunk].add(sportKey);
        lastActivityByBunk[bunk] = { field: fieldName, sport: sportKey };
      }
    }
  }

  updateTable();
  saveSchedule();
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

// -------------------- Schedule Save / Load --------------------
function initScheduleSystem() {
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
// ===== END APP2.JS =====
