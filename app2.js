// -------------------- Scheduling Core (Unified Grid) --------------------
function assignFieldsToBunks() {
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

  // Reset schedules
  scheduleAssignments = {};
  availableDivisions.forEach(div => {
    divisions[div].bunks.forEach(b => {
      scheduleAssignments[b] = new Array(unifiedTimes.length);
    });
  });

  const inc = parseInt(document.getElementById("increment").value, 10);
  const spanLen = Math.max(1, Math.ceil(activityDuration / inc));

  // -------------------- Resource Reservations (Global + Divisional) --------------------
  const globalResourceUsage = {}; // { fieldName: [ {start,end} ] }
  const divisionResourceUsage = {}; // { divName: { fieldName: [ {start,end} ] } }

  function overlaps(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
  }

  function canUseResource(div, resourceKey, startTime, endTime) {
    // Prevent conflicts across ALL divisions
    if (globalResourceUsage[resourceKey]) {
      for (const r of globalResourceUsage[resourceKey]) {
        if (overlaps(startTime, endTime, r.start, r.end)) return false;
      }
    }
    // Prevent conflicts WITHIN the same division
    if (divisionResourceUsage[div] && divisionResourceUsage[div][resourceKey]) {
      for (const r of divisionResourceUsage[div][resourceKey]) {
        if (overlaps(startTime, endTime, r.start, r.end)) return false;
      }
    }
    return true;
  }

  function reserveResource(div, resourceKey, startTime, endTime) {
    if (!globalResourceUsage[resourceKey]) globalResourceUsage[resourceKey] = [];
    if (!divisionResourceUsage[div]) divisionResourceUsage[div] = {};
    if (!divisionResourceUsage[div][resourceKey]) divisionResourceUsage[div][resourceKey] = [];

    globalResourceUsage[resourceKey].push({ start: startTime, end: endTime });
    divisionResourceUsage[div][resourceKey].push({ start: startTime, end: endTime });
  }

  // -------------------- Choose exactly ONE league slot per enabled division --------------------
  const leagueSlotByDiv = {};
  availableDivisions.forEach(div => {
    if (leagues[div] && leagues[div].enabled) {
      const active = Array.from(divisionActiveRows[div] || []);
      if (active.length > 0) leagueSlotByDiv[div] = active[Math.floor(Math.random() * active.length)];
    }
  });

  // Track last activity per bunk
  const lastActivityByBunk = {};

  // -------------------- Build schedule --------------------
  for (let s = 0; s < unifiedTimes.length; s++) {
    const startTime = unifiedTimes[s].start;
    const endTime = new Date(startTime.getTime() + activityDuration * 60000);

    const usedFieldsByDiv = {};
    availableDivisions.forEach(div => {
      usedFieldsByDiv[div] = new Set();
    });

    for (let div of availableDivisions) {
      if (!(divisionActiveRows[div] && divisionActiveRows[div].has(s))) continue;

      for (let bunk of divisions[div].bunks) {
        if (scheduleAssignments[bunk][s] && scheduleAssignments[bunk][s].continuation) continue;

        // ---- Handle League Slot ----
        if (leagueSlotByDiv[div] === s) {
          const leagueKey = "Leagues_Global";
          if (!canUseResource(div, leagueKey, startTime, endTime)) continue; // skip if already booked globally

          scheduleAssignments[bunk][s] = { field: "Leagues", sport: null, continuation: false, isLeague: true };
          reserveResource(div, leagueKey, startTime, endTime);

          // Continuations
          let placed = 1;
          while (placed < spanLen && (s + placed) < unifiedTimes.length && divisionActiveRows[div].has(s + placed)) {
            scheduleAssignments[bunk][s + placed] = { field: "Leagues", sport: null, continuation: true, isLeague: true };
            placed++;
          }

          lastActivityByBunk[bunk] = { field: "Leagues", sport: null };
          continue;
        }

        // ---- Normal Activities ----
        const prev = lastActivityByBunk[bunk];
        let candidates = allActivities.filter(c => {
          if (usedFieldsByDiv[div].has(c.field.name)) return false;
          return canUseResource(div, c.field.name, startTime, endTime);
        });

        // Prevent back-to-back same field or sport
        candidates = candidates.filter(c => {
          if (!prev) return true;
          if (prev.field === c.field.name) return false;
          if (prev.sport && c.sport && prev.sport === c.sport) return false;
          return true;
        });

        // Fallbacks
        if (candidates.length === 0) {
          const specials = allActivities.filter(a => a.type === "special");
          candidates = specials.length > 0 ? specials : [{ type: "special", field: { name: "Free Play" }, sport: null }];
        }

        // Choose and assign
        const chosen = candidates[Math.floor(Math.random() * candidates.length)];
        scheduleAssignments[bunk][s] = {
          field: chosen.field.name,
          sport: chosen.sport,
          continuation: false,
          isLeague: false
        };
        usedFieldsByDiv[div].add(chosen.field.name);

        // Reserve field for entire span before marking continuations
        if (chosen.type === "field") reserveResource(div, chosen.field.name, startTime, endTime);

        // Continuations
        let placed = 1;
        while (placed < spanLen && (s + placed) < unifiedTimes.length && divisionActiveRows[div].has(s + placed)) {
          const contStart = unifiedTimes[s + placed].start;
          const contEnd = new Date(contStart.getTime() + activityDuration * 60000);
          scheduleAssignments[bunk][s + placed] = {
            field: chosen.field.name,
            sport: chosen.sport,
            continuation: true,
            isLeague: false
          };
          if (chosen.type === "field") reserveResource(div, chosen.field.name, contStart, contEnd);
          placed++;
        }

        lastActivityByBunk[bunk] = { field: chosen.field.name, sport: chosen.sport };
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
