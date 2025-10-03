// -------------------- Scheduling Core (Unified Grid) --------------------
function assignFieldsToBunks() {
  // Build activity universe
  const availFields = fields.filter(f => f.available && f.activities.length > 0);
  const availSpecials = specialActivities.filter(s => s.available);

  const allActivities = [
    ...availFields.flatMap(f => f.activities.map(act => ({ type: "field", field: f, sport: act }))),
    ...availSpecials.map(sa => ({ type: "special", field: { name: sa.name }, sport: null }))
  ];
  if (allActivities.length === 0) { 
    alert("No activities available."); 
    scheduleAssignments = {}; 
    return; 
  }

  // init schedules
  scheduleAssignments = {};
  availableDivisions.forEach(div => {
    divisions[div].bunks.forEach(b => { 
      scheduleAssignments[b] = new Array(unifiedTimes.length); 
    });
  });

  // Activity span in rows
  const inc = parseInt(document.getElementById("increment").value);
  const spanLen = Math.max(1, Math.ceil(activityDuration / inc));

  // Track global resource usage across all bunks
  const usedResources = Array.from({ length: unifiedTimes.length }, () => new Set());

  // Pick a league slot per division (must be in active rows)
  const leagueSlotByDiv = {};
  availableDivisions.forEach(div => {
    if (leagues[div] && leagues[div].enabled) {
      const active = Array.from(divisionActiveRows[div] || []);
      if (active.length > 0) {
        leagueSlotByDiv[div] = active[Math.floor(Math.random() * active.length)];
      }
    }
  });

  // Per unified time row
  for (let s = 0; s < unifiedTimes.length; s++) {
    // For each division, track used fields this row to avoid conflicts inside division
    const usedFieldsByDiv = {};
    availableDivisions.forEach(div => {
      usedFieldsByDiv[div] = new Set();
      divisions[div].bunks.forEach(bunk => {
        const entry = scheduleAssignments[bunk][s];
        if (entry && entry.continuation) usedFieldsByDiv[div].add(entry.field);
      });
    });

    for (let div of availableDivisions) {
      const isActiveRow = divisionActiveRows[div] && divisionActiveRows[div].has(s);
      if (!isActiveRow) continue;

      for (let bunk of divisions[div].bunks) {
        if (scheduleAssignments[bunk][s] && scheduleAssignments[bunk][s].continuation) continue;

        let lastIdx = s - 1, lastEntry = null;
        while (lastIdx >= 0 && !scheduleAssignments[bunk][lastIdx]) lastIdx--;
        if (lastIdx >= 0) lastEntry = scheduleAssignments[bunk][lastIdx];

        // ---- Leagues ----
        if (leagueSlotByDiv[div] === s && leagues[div] && leagues[div].enabled) {
          if (lastEntry && lastEntry.isLeague) {
            let next = s + 1;
            while (next < unifiedTimes.length && (!divisionActiveRows[div].has(next))) next++;
            leagueSlotByDiv[div] = Math.min(next, unifiedTimes.length - 1);
          }
          if (leagueSlotByDiv[div] === s) {
            scheduleAssignments[bunk][s] = { field: "Leagues", sport: null, continuation: false, isLeague: true };
            let placed = 1, k = 1;
            while (placed < spanLen && (s + k) < unifiedTimes.length && divisionActiveRows[div].has(s + k)) {
              scheduleAssignments[bunk][s + k] = { field: "Leagues", sport: null, continuation: true, isLeague: true };
              placed++; k++;
            }
            usedFieldsByDiv[div].add("Leagues");
            for (let k = 0; k < spanLen; k++) {
              if ((s + k) < unifiedTimes.length) {
                usedResources[s + k].add("Leagues");
              }
            }
            continue;
          }
        }

        // ---- Regular activities ----
        if (lastEntry && !lastEntry.continuation) {
          let countDone = 1;
          let t = lastIdx + 1;
          while (t < s && scheduleAssignments[bunk][t] && scheduleAssignments[bunk][t].continuation) { countDone++; t++; }
          if (countDone < spanLen) {
            scheduleAssignments[bunk][s] = { field: lastEntry.field, sport: lastEntry.sport, continuation: true, isLeague: lastEntry.isLeague || false };
            usedFieldsByDiv[div].add(lastEntry.field);
            continue;
          }
        }

        // Filter candidates (check division + global conflicts)
        let candidates = allActivities.filter(c => {
          if (usedFieldsByDiv[div].has(c.field.name)) return false;
          let resourceKey = c.field.name;
          for (let k = 0; k < spanLen; k++) {
            if ((s + k) < unifiedTimes.length && usedResources[s + k].has(resourceKey)) {
              return false; // globally booked
            }
          }
          return true;
        });

        candidates = candidates.filter(c => {
          if (!lastEntry) return true;
          if (lastEntry.isLeague) {
            if (c.field.name === "Leagues") return false;
            if (c.type === "field" && c.field.name === lastEntry.field) return false;
          }
          if (c.type === "field" && lastEntry.sport && c.sport === lastEntry.sport) return false;
          if (c.field.name === lastEntry.field) return false;
          return true;
        });

        scheduleAssignments.__done = scheduleAssignments.__done || {};
        scheduleAssignments.__done[bunk] = scheduleAssignments.__done[bunk] || new Set();
        const doneSet = scheduleAssignments.__done[bunk];
        const preferred = candidates.filter(c => !doneSet.has(c.type === "field" ? c.sport : c.field.name));
        let chosen = (preferred.length > 0 ? preferred : candidates)[Math.floor(Math.random() * (preferred.length > 0 ? preferred.length : candidates.length))];

        if (!chosen && allActivities.length > 0) {
          let tries = allActivities.slice();
          do {
            chosen = tries.splice(Math.floor(Math.random() * tries.length), 1)[0];
          } while (chosen && lastEntry && (chosen.field.name === lastEntry.field || chosen.sport === lastEntry.sport) && tries.length > 0);
        }
        if (!chosen) continue;

        scheduleAssignments[bunk][s] = { field: chosen.field.name, sport: chosen.sport, continuation: false, isLeague: false };
        usedFieldsByDiv[div].add(chosen.field.name);
        doneSet.add(chosen.type === "field" ? chosen.sport : chosen.field.name);

        // Reserve globally for all rows in this span
        let resourceKey = chosen.field.name;
        for (let k = 0; k < spanLen; k++) {
          if ((s + k) < unifiedTimes.length) {
            usedResources[s + k].add(resourceKey);
          }
        }

        let placed = 1, k = 1;
        while (placed < spanLen && (s + k) < unifiedTimes.length && divisionActiveRows[div].has(s + k)) {
          scheduleAssignments[bunk][s + k] = { field: chosen.field.name, sport: chosen.sport, continuation: true, isLeague: false };
          placed++; k++;
        }
      }
    }
  }
}

// -------------------- Rendering (Unified Grid + Merged Cells) --------------------
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
  const thTime = document.createElement("th"); thTime.textContent = "Time"; row1.appendChild(thTime);
  availableDivisions.forEach(div => {
    const th = document.createElement("th");
    th.colSpan = divisions[div].bunks.length || 1;
    th.textContent = div;
    th.style.background = divisions[div].color; th.style.color = "#fff";
    row1.appendChild(th);
  });
  thead.appendChild(row1);

  const row2 = document.createElement("tr");
  const thBunkLabel = document.createElement("th"); thBunkLabel.textContent = "Bunk"; row2.appendChild(thBunkLabel);
  availableDivisions.forEach(div => {
    divisions[div].bunks.forEach(b => {
      const th = document.createElement("th"); th.textContent = b; row2.appendChild(th);
    });
  });
  thead.appendChild(row2);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  for (let s = 0; s < unifiedTimes.length; s++) {
    const tr = document.createElement("tr");
    const tdTime = document.createElement("td"); tdTime.textContent = unifiedTimes[s].label; tr.appendChild(tdTime);

    availableDivisions.forEach(div => {
      const activeSet = divisionActiveRows[div] || new Set();
      divisions[div].bunks.forEach(bunk => {
        if (scheduleAssignments[bunk] && scheduleAssignments[bunk][s] && scheduleAssignments[bunk][s]._skip) return;

        const td = document.createElement("td");
        const isActive = activeSet.has(s);

        if (!isActive) {
          td.className = "grey-cell";
          tr.appendChild(td);
          return;
        }

        const entry = scheduleAssignments[bunk] ? scheduleAssignments[bunk][s] : null;
        if (entry && !entry.continuation) {
          let span = 1;
          for (let k = s + 1; k < unifiedTimes.length; k++) {
            const e2 = scheduleAssignments[bunk][k];
            if (!e2 || !e2.continuation || e2.field !== entry.field || e2.sport !== entry.sport || e2.isLeague !== entry.isLeague) break;
            span++;
            scheduleAssignments[bunk][k]._skip = true;
          }
          td.rowSpan = span;
          if (entry.isLeague) {
            td.innerHTML = `<span class="league-pill">Leagues</span>`;
          } else {
            td.textContent = entry.sport ? `${entry.field} – ${entry.sport}` : entry.field;
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
  scheduleTab.appendChild(table);
}

// -------------------- Init --------------------
document.getElementById("addFieldBtn").disabled = false;
