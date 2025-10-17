// -------------------- Scheduling Core (Unified Grid: No Daily Repeats — strict) --------------------
function assignFieldsToBunks() {
  const availFields = fields.filter(f => f.available && f.activities.length > 0);
  const availSpecials = specialActivities.filter(s => s.available);

  // For strict daily no-repeat, we normalize specials to have a sport key equal to their name
  const allActivities = [
    ...availFields.flatMap(f =>
      f.activities.map(act => ({ type: "field", field: f, sport: act }))
    ),
    ...availSpecials.map(sa => ({
      type: "special",
      field: { name: sa.name },
      sport: sa.name
    }))
  ];

  if (allActivities.length === 0) {
    alert("No activities available.");
    scheduleAssignments = {};
    return;
  }

  // Reset schedule slots per bunk
  scheduleAssignments = {};
  availableDivisions.forEach(div => {
    divisions[div].bunks.forEach(b => {
      scheduleAssignments[b] = new Array(unifiedTimes.length);
    });
  });

  const inc = parseInt(document.getElementById("increment").value, 10);
  const spanLen = Math.max(1, Math.ceil(activityDuration / inc));

  // -------------------- Locks & Trackers (we will tighten field-at-same-time later) --------------------
  const globalResourceUsage = {};
  const occupiedFieldsBySlot = Array.from({ length: unifiedTimes.length }, () => new Set());
  const globalActivityLock = Array.from({ length: unifiedTimes.length }, () => new Set());
  const usedActivitiesByTime = Array.from({ length: unifiedTimes.length }, () => new Set()); // field|sport
  const leagueTimeLocks = [];

  // STRICT: per-bunk daily activity usage (by sport name or special name)
  const activitiesUsedByBunk = {}; // { bunk: Set(sportKey) }

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

  // -------------------- 1) Guaranteed one Leagues block per enabled division (unchanged) --------------------
  const priorityDivs = [...availableDivisions].reverse(); // older → younger
  for (const div of priorityDivs) {
    const activeSlots = Array.from(divisionActiveRows[div] || []);
    if (activeSlots.length === 0) continue;
    const leagueToggle = leagues[div]?.enabled;
    if (!leagueToggle) continue;

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
    if (chosenSlot === null) chosenSlot = activeSlots[0];

    const slotStart = unifiedTimes[chosenSlot].start;
    const slotEnd = new Date(slotStart.getTime() + activityDuration * 60000);

    divisions[div].bunks.forEach(b => {
      if (!activitiesUsedByBunk[b]) activitiesUsedByBunk[b] = new Set();
      scheduleAssignments[b][chosenSlot] = {
        field: "Leagues",
        sport: "Leagues",
        continuation: false,
        isLeague: true
      };
      // mark continuation cells
      for (let k = 1; k < spanLen; k++) {
        const idx = chosenSlot + k;
        if (idx >= unifiedTimes.length) break;
        if (!(divisionActiveRows[div] && divisionActiveRows[div].has(idx))) break;
        scheduleAssignments[b][idx] = {
          field: "Leagues",
          sport: "Leagues",
          continuation: true,
          isLeague: true
        };
      }
      activitiesUsedByBunk[b].add("Leagues");
    });

    // Reserve a pseudo-resource for league time so spacing holds; fields aren't used here
    reserveField(`LEAGUE-${div}`, slotStart, slotEnd, chosenSlot, "Leagues");
  }

  // -------------------- 2) Fill remaining with STRICT no-daily-repeat per bunk --------------------
  const lastActivityByBunk = {};

  for (let s = 0; s < unifiedTimes.length; s++) {
    const slotStart = unifiedTimes[s].start;
    const slotEnd = new Date(slotStart.getTime() + activityDuration * 60000);

    for (const div of priorityDivs) {
      if (!(divisionActiveRows[div] && divisionActiveRows[div].has(s))) continue;

      for (const bunk of divisions[div].bunks) {
        if (scheduleAssignments[bunk][s]) continue; // skip pre-filled leagues/continuations
        if (!activitiesUsedByBunk[bunk]) activitiesUsedByBunk[bunk] = new Set();
        if (!usedActivitiesByTime[s]) usedActivitiesByTime[s] = new Set();

        const prev = lastActivityByBunk[bunk];

        // PHASE A: strict filter (no daily repeat + respect current locks if possible)
        let candidates = allActivities.filter(a => {
          const key = a.sport; // sport or special name
          if (activitiesUsedByBunk[bunk].has(key)) return false; // STRICT ban
          if (!canUseField(a.field.name, slotStart, slotEnd, s)) return false;
          if (a.sport && globalActivityLock[s].has(a.sport)) return false;
          if (usedActivitiesByTime[s].has(`${a.field.name}|${a.sport}`)) return false;
          if (prev && a.sport === prev.sport) return false; // avoid immediate back-to-back same sport
          return true;
        });

        // PHASE B: relax time-slot global locks, but NEVER the daily repeat
        if (candidates.length === 0) {
          candidates = allActivities.filter(a => {
            const key = a.sport;
            if (activitiesUsedByBunk[bunk].has(key)) return false; // still STRICT
            // Ignore globalActivityLock / usedActivitiesByTime here; still respect field availability window
            return canUseField(a.field.name, slotStart, slotEnd, s);
          });
        }

        // PHASE C: if still nothing, relax field window too, but NEVER daily repeat
        if (candidates.length === 0) {
          candidates = allActivities.filter(a => !activitiesUsedByBunk[bunk].has(a.sport));
        }

        // FINAL: if still nothing, DO NOT double — insert a placeholder instead
        if (candidates.length === 0) {
          scheduleAssignments[bunk][s] = {
            field: "Special Activity Needed",
            sport: "Special Activity Needed",
            continuation: false,
            isLeague: false
          };
          // do NOT add to activitiesUsedByBunk — we want to allow real activities later
          // do NOT reserve a field — it's a placeholder
          lastActivityByBunk[bunk] = { field: "Special Activity Needed", sport: "Special Activity Needed", isLeague: false };
          continue;
        }

        // Choose and assign
        const chosen = candidates[Math.floor(Math.random() * candidates.length)];
        const sportKey = chosen.sport; // normalized

        // (We will re-tighten per-slot field/dup locks in the next pass; for now keep lightweight)
        usedActivitiesByTime[s].add(`${chosen.field.name}|${sportKey}`);

        scheduleAssignments[bunk][s] = {
          field: chosen.field.name,
          sport: chosen.sport,
          continuation: false,
          isLeague: false
        };

        // Reserve/lock field window (kept; next pass we'll ensure strict slot exclusivity)
        reserveField(chosen.field.name, slotStart, slotEnd, s, chosen.sport);

        // Continuation cells
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

        // STRICT: mark this activity as used for the bunk for the entire day
        activitiesUsedByBunk[bunk].add(sportKey);

        lastActivityByBunk[bunk] = {
          field: chosen.field.name,
          sport: chosen.sport,
          isLeague: false
        };
      }
    }
  }

  updateTable();
  saveSchedule();
}

// -------------------- Rendering (unchanged) --------------------
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

// -------------------- Schedule Save / Load (unchanged) --------------------
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
