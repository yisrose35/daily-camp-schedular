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

  // Reset schedules for all bunks
  scheduleAssignments = {};
  availableDivisions.forEach(div => {
    divisions[div].bunks.forEach(b => { scheduleAssignments[b] = new Array(unifiedTimes.length); });
  });

  const inc = parseInt(document.getElementById("increment").value, 10);
  const spanLen = Math.max(1, Math.ceil(activityDuration / inc));

  // -------------------- Global & Divisional Reservations --------------------
  // Time-interval reservations (Date-based) to prevent staggered overlaps.
  const globalResourceUsage = {};       // { fieldName: [ {start,end} ] }
  const divisionResourceUsage = {};     // { divName: { fieldName: [ {start,end} ] } }

  // Slot-level locks (index-based) to hard-stop duplicates within the grid cells.
  const occupiedFieldsBySlot = Array.from({ length: unifiedTimes.length }, () => new Set()); // [Set(fieldName)]
  const leagueOccupiedBySlot = Array.from({ length: unifiedTimes.length }, () => false);

  function overlaps(aStart, aEnd, bStart, bEnd) { return aStart < bEnd && bStart < aEnd; }

  function canUseResource(div, resourceKey, startTime, endTime, s) {
    // Slot-level hard lock for the starting slot
    if (occupiedFieldsBySlot[s].has(resourceKey)) return false;

    // Global (all divisions) time check
    if (globalResourceUsage[resourceKey]) {
      for (const r of globalResourceUsage[resourceKey]) {
        if (overlaps(startTime, endTime, r.start, r.end)) return false;
      }
    }
    // Division-level time check (avoid two bunks in same division sharing a field)
    if (divisionResourceUsage[div] && divisionResourceUsage[div][resourceKey]) {
      for (const r of divisionResourceUsage[div][resourceKey]) {
        if (overlaps(startTime, endTime, r.start, r.end)) return false;
      }
    }

    // Also ensure the field is free across ALL covered slots for this activity span
    for (let k = 0; k < spanLen; k++) {
      const idx = s + k;
      if (idx >= unifiedTimes.length) break;
      // Only consider if division is active for that slot
      if (divisionActiveRows[div] && !divisionActiveRows[div].has(idx)) break;
      if (occupiedFieldsBySlot[idx].has(resourceKey)) return false;
    }

    return true;
  }

  function reserveResource(div, resourceKey, startTime, endTime, s) {
    if (!globalResourceUsage[resourceKey]) globalResourceUsage[resourceKey] = [];
    if (!divisionResourceUsage[div]) divisionResourceUsage[div] = {};
    if (!divisionResourceUsage[div][resourceKey]) divisionResourceUsage[div][resourceKey] = [];
    globalResourceUsage[resourceKey].push({ start: startTime, end: endTime });
    divisionResourceUsage[div][resourceKey].push({ start: startTime, end: endTime });

    // Also lock all covered slots for this span
    for (let k = 0; k < spanLen; k++) {
      const idx = s + k;
      if (idx >= unifiedTimes.length) break;
      if (divisionActiveRows[div] && !divisionActiveRows[div].has(idx)) break;
      occupiedFieldsBySlot[idx].add(resourceKey);
    }
  }

  // -------------------- Choose exactly ONE league slot per enabled division --------------------
  // AND choose exactly TWO bunks to play that league game (others do regular activities).
  const leagueSlotByDiv = {};
  const leaguePlayersByDiv = {};
  availableDivisions.forEach(div => {
    if (leagues[div] && leagues[div].enabled) {
      const active = Array.from(divisionActiveRows[div] || []);
      if (active.length > 0) {
        leagueSlotByDiv[div] = active[Math.floor(Math.random() * active.length)];
        // pick 2 bunks for the game; if only one bunk exists, it will just mark that bunk
        const bunks = divisions[div].bunks.slice();
        // Simple deterministic choice for now; can be randomized if desired
        leaguePlayersByDiv[div] = bunks.slice(0, Math.min(2, bunks.length));
      }
    }
  });

  // -------------------- Track last activity per bunk to avoid back-to-back repeats --------------------
  const lastActivityByBunk = {}; // { bunkName: { field, sport, isLeague } }

  // -------------------- Build schedule --------------------
  for (let s = 0; s < unifiedTimes.length; s++) {
    const slotStart = unifiedTimes[s].start;
    const slotEnd = new Date(slotStart.getTime() + activityDuration * 60000);

    // Within each slot, keep a per-division set to avoid reusing a field twice in the same division simultaneously
    const usedFieldsByDiv = {};
    availableDivisions.forEach(div => { usedFieldsByDiv[div] = new Set(); });

    for (let div of availableDivisions) {
      if (!(divisionActiveRows[div] && divisionActiveRows[div].has(s))) continue;

      for (let bunk of divisions[div].bunks) {
        // Skip if this cell is a continuation already set
        if (scheduleAssignments[bunk][s] && scheduleAssignments[bunk][s].continuation) continue;

        // ---- League handling (only for selected two bunks at the league slot) ----
        if (leagueSlotByDiv[div] === s && leaguePlayersByDiv[div] && leaguePlayersByDiv[div].includes(bunk)) {
          // Ensure only one league "resource" per slot globally
          const leagueKey = "Leagues_Global";
          if (leagueOccupiedBySlot[s]) {
            // Another division already booked league this exact slot; fall back to normal activity
          } else {
            scheduleAssignments[bunk][s] = { field: "Leagues", sport: null, continuation: false, isLeague: true };
            leagueOccupiedBySlot[s] = true;

            // Continuations across span
            for (let k = 1; k < spanLen; k++) {
              const idx = s + k;
              if (idx >= unifiedTimes.length) break;
              if (!(divisionActiveRows[div] && divisionActiveRows[div].has(idx))) break;
              scheduleAssignments[bunk][idx] = { field: "Leagues", sport: null, continuation: true, isLeague: true };
            }

            lastActivityByBunk[bunk] = { field: "Leagues", sport: null, isLeague: true };
            continue;
          }
        }

        // ---- Continuation logic (continue prior activity if not finished) ----
        let lastIdx = s - 1, lastEntry = null;
        while (lastIdx >= 0 && !scheduleAssignments[bunk][lastIdx]) lastIdx--;
        if (lastIdx >= 0) lastEntry = scheduleAssignments[bunk][lastIdx];

        if (lastEntry && !lastEntry.continuation) {
          // Count how many placed so far in this activity block
          let countDone = 1, t = lastIdx + 1;
          while (t < s && scheduleAssignments[bunk][t] && scheduleAssignments[bunk][t].continuation) { countDone++; t++; }
          if (countDone < spanLen) {
            scheduleAssignments[bunk][s] = {
              field: lastEntry.field,
              sport: lastEntry.sport,
              continuation: true,
              isLeague: lastEntry.isLeague || false
            };
            // lock slot for field if it's a real field (not league/special)
            if (!lastEntry.isLeague && lastEntry.field && fields.some(f => f.name === lastEntry.field)) {
              occupiedFieldsBySlot[s].add(lastEntry.field);
            }
            continue;
          }
        }

        // ---- Pick a new activity ----
        const prev = lastActivityByBunk[bunk];

        // Build candidate pool: resource free globally, divisionally, and across the span's slots
        let candidates = allActivities.filter(c => {
          // Don't reuse a field within this division at this slot
          if (usedFieldsByDiv[div].has(c.field.name)) return false;

          // Hard stop if any covered slot already has this field booked
          if (!canUseResource(div, c.field.name, slotStart, slotEnd, s)) return false;

          return true;
        });

        // Prevent back-to-back same field/sport/leagues
        candidates = candidates.filter(c => {
          if (!prev) return true;
          if (prev.isLeague) {
            // After leagues, force a different activity
            if (c.field.name === "Leagues") return false;
          }
          if (prev.field === c.field.name) return false;
          if (prev.sport && c.sport && prev.sport === c.sport) return false;
          return true;
        });

        // Guaranteed fill: if nothing is available, try specials, then Free Play
        if (candidates.length === 0) {
          const specials = allActivities.filter(a => a.type === "special");
          candidates = specials.length > 0 ? specials : [{ type: "special", field: { name: "Free Play" }, sport: null }];
        }

        // Choose and assign
        const chosen = candidates[Math.floor(Math.random() * candidates.length)];
        scheduleAssignments[bunk][s] = { field: chosen.field.name, sport: chosen.sport, continuation: false, isLeague: false };

        // Mark field as in-use for this division at this slot and lock globally across span
        usedFieldsByDiv[div].add(chosen.field.name);
        if (chosen.type === "field") {
          reserveResource(div, chosen.field.name, slotStart, slotEnd, s);
        } else {
          // Special/Free Play: just mark the current slot as occupied for that "name" so we don't duplicate visually in this slot
          occupiedFieldsBySlot[s].add(chosen.field.name);
        }

        // Continuations: fill and lock all covered slots
        for (let k = 1; k < spanLen; k++) {
          const idx = s + k;
          if (idx >= unifiedTimes.length) break;
          if (!(divisionActiveRows[div] && divisionActiveRows[div].has(idx))) break;

          scheduleAssignments[bunk][idx] = { field: chosen.field.name, sport: chosen.sport, continuation: true, isLeague: false };

          if (chosen.type === "field") {
            const contStart = unifiedTimes[idx].start;
            const contEnd = new Date(contStart.getTime() + activityDuration * 60000);
            reserveResource(div, chosen.field.name, contStart, contEnd, idx);
          } else {
            occupiedFieldsBySlot[idx].add(chosen.field.name);
          }
        }

        lastActivityByBunk[bunk] = { field: chosen.field.name, sport: chosen.sport, isLeague: false };
      }
    }
  }
}

// -------------------- Rendering (Unified Grid + Merged Cells) --------------------
function updateTable() {
  const scheduleTab = document.getElementById("schedule");
  scheduleTab.innerHTML = "";
  if (unifiedTimes.length === 0) return;

  // clear previous skip flags
  Object.keys(scheduleAssignments).forEach(b => {
    if (Array.isArray(scheduleAssignments[b])) {
      scheduleAssignments[b].forEach(e => { if (e) delete e._skip; });
    }
  });

  const table = document.createElement("table");
  table.className = "division-schedule";

  // Header rows
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

  // Body
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
          // compute rowspan across continuations
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
