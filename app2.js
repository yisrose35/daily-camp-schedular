// -------------------- Scheduling Core (Unified Grid: Guaranteed Leagues + Full Schedule + No Bunk Repeats) --------------------
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

  // Bunk-level tracking to prevent repeats
  const sportsUsedByBunk = {}; // { bunk: Set(sports) }
  const fieldsUsedByBunk = {}; // { bunk: Set(fields) }

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

  // Helper: is "Leagues day" globally?
  function isGlobalLeaguesDay() {
    if (!leagues) return false;
    // If ANY division has leagues enabled, then everyone should get leagues
    return Object.values(leagues).some(cfg => cfg && cfg.enabled === true);
  }

  // -------------------- 1. Schedule Guaranteed Leagues --------------------
  const leagueSlotByDiv = {};
  const priorityDivs = [...availableDivisions].reverse(); // older → younger

  const globalLeaguesOn = isGlobalLeaguesDay();

  for (const div of priorityDivs) {
    const activeSlots = Array.from(divisionActiveRows[div] || []);
    if (activeSlots.length === 0) continue;

    // If global leagues is on, every division gets leagues.
    // Otherwise only divisions explicitly toggled on get leagues.
    const wantsLeague = globalLeaguesOn || (leagues && leagues[div]?.enabled);
    if (!wantsLeague) continue;

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

    if (chosenSlot === null) chosenSlot = activeSlots[0];
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
      // mark league as used so they don't get it again
      if (!sportsUsedByBunk[b]) sportsUsedByBunk[b] = new Set();
      if (!fieldsUsedByBunk[b]) fieldsUsedByBunk[b] = new Set();
      sportsUsedByBunk[b].add("Leagues");
      fieldsUsedByBunk[b].add("Leagues");
    });
    reserveField(`LEAGUE-${div}`, slotStart, slotEnd, chosenSlot, "Leagues");
  }

  // -------------------- 2. Fill Every Remaining Slot --------------------
  const lastActivityByBunk = {};
  const PLACEHOLDER_NAME = "Special Activity Needed";

  function notBackToBack(prev, act) {
    // Block only when both are real sports and identical (no back-to-back same sport)
    if (!prev || !prev.sport || !act.sport) return true;
    return act.sport !== prev.sport;
  }

  function baseFeasible(act, bunk, prev, slotStart, slotEnd, s, allowFieldReuse) {
    if (!canUseField(act.field.name, slotStart, slotEnd, s)) return false;
    if (act.sport && globalActivityLock[s].has(act.sport)) return false;

    // absolute: no back-to-back same sport
    if (!notBackToBack(prev, act)) return false;

    // absolute: no daily repeat of sport for this bunk
    if (act.sport && sportsUsedByBunk[bunk]?.has(act.sport)) return false;

    // soft: avoid reusing the same field for the same bunk (can be relaxed)
    if (!allowFieldReuse && fieldsUsedByBunk[bunk]?.has(act.field.name)) return false;

    return true;
  }

  function chooseActivity(bunk, prev, slotStart, slotEnd, s) {
    // TIERED PICKER (never violates back-to-back or daily sport-unique rules)
    // Tier A: all constraints (no field reuse)
    let pool = allActivities.filter(a => baseFeasible(a, bunk, prev, slotStart, slotEnd, s, false));
    if (pool.length > 0) return pool[Math.floor(Math.random() * pool.length)];

    // Tier B: allow field reuse, but still forbid back-to-back and daily sport repeats
    pool = allActivities.filter(a => baseFeasible(a, bunk, prev, slotStart, slotEnd, s, true));
    if (pool.length > 0) return pool[Math.floor(Math.random() * pool.length)];

    // Final: no valid non-repeating sport exists → use placeholder block
    return { type: "special", field: { name: PLACEHOLDER_NAME }, sport: null, _placeholder: true };
  }

  for (let s = 0; s < unifiedTimes.length; s++) {
    const slotStart = unifiedTimes[s].start;
    const slotEnd = new Date(slotStart.getTime() + activityDuration * 60000);

    for (const div of priorityDivs) {
      if (!(divisionActiveRows[div] && divisionActiveRows[div].has(s))) continue;

      for (const bunk of divisions[div].bunks) {
        if (scheduleAssignments[bunk][s]) continue; // skip leagues or continuations
        const prev = lastActivityByBunk[bunk];

        if (!sportsUsedByBunk[bunk]) sportsUsedByBunk[bunk] = new Set();
        if (!fieldsUsedByBunk[bunk]) fieldsUsedByBunk[bunk] = new Set();

        const chosen = chooseActivity(bunk, prev, slotStart, slotEnd, s);

        scheduleAssignments[bunk][s] = {
          field: chosen.field.name,
          sport: chosen.sport,
          continuation: false,
          isLeague: false
        };

        // Only reserve/lock if it's a real resource (not the placeholder)
        if (!chosen._placeholder) {
          reserveField(chosen.field.name, slotStart, slotEnd, s, chosen.sport);
        }

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
          if (!chosen._placeholder) {
            reserveField(chosen.field.name, contStart, contEnd, idx, chosen.sport);
          }
        }

        // Track bunk-level usage (do NOT add placeholder to used sets)
        if (!chosen._placeholder) {
          if (chosen.sport) sportsUsedByBunk[bunk].add(chosen.sport);
          fieldsUsedByBunk[bunk].add(chosen.field.name);
        }

        lastActivityByBunk[bunk] = {
          field: chosen.field.name,
          sport: chosen.sport,
          isLeague: false
        };
      }
    }
  }

  updateTable();
  saveSchedule(); // auto-save each new schedule
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

          // Style placeholder distinctly
          if (entry.field === "Special Activity Needed" && !entry.sport) {
            td.innerHTML = `<span class="need-special-pill">${entry.field}</span>`;
          } else if (entry.isLeague) {
            td.innerHTML = `<span class="league-pill">Leagues</span>`;
          } else {
            td.textContent = entry.sport ? `${entry.field} – ${entry.sport}` : entry.field;
          }
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
