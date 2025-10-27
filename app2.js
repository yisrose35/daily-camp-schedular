// -------------------- Scheduling Core (Unified Grid: Guaranteed Leagues + Full Schedule + No Repeats for Sports & Specials) --------------------
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

  // Normalizers
  const norm = (s) => (typeof s === "string" && s.trim() ? s.trim().toLowerCase() : null);

  // Unified per-bunk once-per-day tracker for both sports & specials
  // Keys look like: "sport:basketball" or "special:game room"
  const usedActivityKeysByBunk = {}; // { bunk: Set<string> }

  // Soft field reuse tracker (kept as a soft preference)
  const fieldsUsedByBunk = {}; // { bunk: Set<fieldName> }

  function activityKey(act) {
    if (!act) return null;
    if (act.sport) return `sport:${norm(act.sport)}`;
    // specials / leagues use field name
    const fname = norm(act.field && act.field.name);
    return fname ? `special:${fname}` : null;
  }

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
    return Object.values(leagues).some(cfg => cfg && cfg.enabled === true);
  }

  // -------------------- 1. Schedule Guaranteed Leagues --------------------
  const leagueSlotByDiv = {};
  const priorityDivs = [...availableDivisions].reverse(); // older → younger

  const globalLeaguesOn = isGlobalLeaguesDay();

  for (const div of priorityDivs) {
    const activeSlots = Array.from(divisionActiveRows[div] || []);
    if (activeSlots.length === 0) continue;

    const wantsLeague = globalLeaguesOn || (leagues && leagues[div]?.enabled);
    if (!wantsLeague) continue;

    // Pick a unique (non-overlapping) league row if possible
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
      if (!usedActivityKeysByBunk[b]) usedActivityKeysByBunk[b] = new Set();
      if (!fieldsUsedByBunk[b]) fieldsUsedByBunk[b] = new Set();

      const leagueAct = { field: { name: "Leagues" }, sport: null };
      const key = activityKey(leagueAct);

      scheduleAssignments[b][chosenSlot] = {
        field: "Leagues",
        sport: null,
        continuation: false,
        isLeague: true
      };
      // Extend to activityDuration
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

      // mark leagues as used (counts as a special key)
      if (key) usedActivityKeysByBunk[b].add(key);
      fieldsUsedByBunk[b].add("Leagues");
    });

    reserveField(`LEAGUE-${div}`, slotStart, slotEnd, chosenSlot, "Leagues");
  }

  // -------------------- 2. Fill Every Remaining Slot --------------------
  const lastActivityByBunk = {};
  const PLACEHOLDER_NAME = "Special Activity Needed";

  function baseFeasible(act, bunk, prev, slotStart, slotEnd, s, allowFieldReuse) {
    if (!canUseField(act.field.name, slotStart, slotEnd, s)) return false;
    if (act.sport && globalActivityLock[s].has(act.sport)) return false;

    // ABSOLUTE: no repeat of the same sport OR the same special for this bunk today
    const key = activityKey(act);
    if (key && usedActivityKeysByBunk[bunk]?.has(key)) return false;

    // Soft: avoid reusing the same field for the same bunk (can be relaxed)
    if (!allowFieldReuse && fieldsUsedByBunk[bunk]?.has(act.field.name)) return false;

    return true;
  }

  function chooseActivity(bunk, prev, slotStart, slotEnd, s) {
    // Tier A: all constraints (no field reuse)
    let pool = allActivities.filter(a => baseFeasible(a, bunk, prev, slotStart, slotEnd, s, false));
    if (pool.length > 0) return pool[Math.floor(Math.random() * pool.length)];

    // Tier B: allow field reuse (still no same sport/special repeats)
    pool = allActivities.filter(a => baseFeasible(a, bunk, prev, slotStart, slotEnd, s, true));
    if (pool.length > 0) return pool[Math.floor(Math.random() * pool.length)];

    // Final: nothing valid → placeholder (doesn't count as used)
    return { type: "special", field: { name: PLACEHOLDER_NAME }, sport: null, _placeholder: true };
  }

  for (let s = 0; s < unifiedTimes.length; s++) {
    const slotStart = unifiedTimes[s].start;
    const slotEnd = new Date(slotStart.getTime() + activityDuration * 60000);

    for (const div of priorityDivs) {
      if (!(divisionActiveRows[div] && divisionActiveRows[div].has(s))) continue;

      for (const bunk of divisions[div].bunks) {
        if (scheduleAssignments[bunk][s]) continue; // skip leagues/continuations

        if (!usedActivityKeysByBunk[bunk]) usedActivityKeysByBunk[bunk] = new Set();
        if (!fieldsUsedByBunk[bunk]) fieldsUsedByBunk[bunk] = new Set();

        const chosen = chooseActivity(bunk, lastActivityByBunk[bunk], slotStart, slotEnd, s);

        scheduleAssignments[bunk][s] = {
          field: chosen.field.name,
          sport: chosen.sport,
          continuation: false,
          isLeague: false
        };

        // Reserve only for real activities
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

        // Track usage (skip placeholder)
        if (!chosen._placeholder) {
          const key = activityKey(chosen);
          if (key) usedActivityKeysByBunk[bunk].add(key);
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

          if (entry.isLeague) {
            td.innerHTML = `<span class="league-pill">Leagues</span>`;
          } else if (entry.field === "Special Activity Needed" && !entry.sport) {
            td.innerHTML = `<span class="need-special-pill">${entry.field}</span>`;
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
