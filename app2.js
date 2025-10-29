// -------------------- Scheduling Core (Unified Grid: Guaranteed Leagues + Full Schedule + No Repeats for Sports & Specials) --------------------
function assignFieldsToBunks() {
  // Defensive guards against missing globals
  window.scheduleAssignments = window.scheduleAssignments || {};
  window.availableDivisions = Array.isArray(window.availableDivisions) ? window.availableDivisions : [];
  window.divisions = window.divisions || {};
  window.fields = Array.isArray(window.fields) ? window.fields : [];
  window.specialActivities = Array.isArray(window.specialActivities) ? window.specialActivities : [];
  window.unifiedTimes = Array.isArray(window.unifiedTimes) ? window.unifiedTimes : [];
  window.leagues = window.leagues || {};
  window.divisionActiveRows = window.divisionActiveRows || {}; // { div: Set(rowIdx) }

  const availFields = fields.filter(f => f?.available && Array.isArray(f.activities) && f.activities.length > 0);
  const availSpecials = specialActivities.filter(s => s?.available);

  const allActivities = [
    ...availFields.flatMap(f => f.activities.map(act => ({ type: "field", field: f, sport: act }))),
    ...availSpecials.map(sa => ({ type: "special", field: { name: sa.name }, sport: null }))
  ];

  if (allActivities.length === 0 || unifiedTimes.length === 0) {
    alert("No activities or time grid available.");
    scheduleAssignments = {};
    return;
  }

  // Reset schedule
  scheduleAssignments = {};
  availableDivisions.forEach(div => {
    (divisions[div]?.bunks || []).forEach(b => {
      scheduleAssignments[b] = new Array(unifiedTimes.length);
    });
  });

  // >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
  // NEW: Pre-place Fixed Daily Activities (Lunch, Tefillah, etc.) and lock them
  // Requires daily_activities.js to be loaded BEFORE this file.
  if (window.DailyActivities?.prePlace) {
    DailyActivities.prePlace({
      scheduleAssignments,
      unifiedTimes,
      divisions,
      availableDivisions
    });
  }
  // <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

  const incEl = document.getElementById("increment");
  const inc = incEl ? parseInt(incEl.value, 10) : 15;
  const spanLen = Math.max(1, Math.ceil(activityDuration / inc));

  // -------------------- Resource Locks --------------------
  const globalResourceUsage = {}; // { fieldName: [{start,end}] } (absolute time overlap guard across multi-slot spans)
  const occupiedFieldsBySlot = Array.from({ length: unifiedTimes.length }, () => new Set()); // per-slot uniqueness
  const globalActivityLock = Array.from({ length: unifiedTimes.length }, () => new Set()); // per-slot sport name lock (avoid same sport on two fields if desired)
  const leagueTimeLocks = []; // list of {start,end} to spread league rows across time

  // Normalizer
  const norm = (s) => (typeof s === "string" ? s.trim().toLowerCase() : null);

  // Per-bunk once-per-day tracker for both sports & specials (ABSOLUTE RULE)
  // Keys: "sport:basketball" or "special:game room" (normalized)
  const usedActivityKeysByBunk = {}; // { bunk: Set<string> }

  // Soft preference: avoid reusing same field for same bunk
  const fieldsUsedByBunk = {}; // { bunk: Set<fieldName> }

  // Build empty sets for all bunks; seed with any pre-placed (locked) items
  availableDivisions.forEach(div => {
    (divisions[div]?.bunks || []).forEach(b => {
      usedActivityKeysByBunk[b] = new Set();
      fieldsUsedByBunk[b] = new Set();
      // If fixed items already placed, mark their keys so we don't count them as repeatable options
      (scheduleAssignments[b] || []).forEach(slot => {
        if (!slot) return;
        const k = activityKeyFromEntry(slot);
        if (k) usedActivityKeysByBunk[b].add(k);
      });
    });
  });

  function activityKey(act) {
    if (!act) return null;
    if (act.sport && typeof act.sport === 'string') return `sport:${norm(act.sport)}`;
    const fname = norm(act.field && act.field.name);
    return fname ? `special:${fname}` : null;
  }

  function activityKeyFromEntry(entry) {
    if (!entry) return null;
    if (entry.sport) return `sport:${norm(entry.sport)}`;
    if (entry.field) return `special:${norm(entry.field)}`;
    return null;
  }

  function overlaps(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
  }

  function slotLocked(bunk, s) {
    const e = scheduleAssignments?.[bunk]?.[s];
    return !!(e && e._locked);
  }

  function anyLockedSpan(bunk, s) {
    for (let k = 0; k < spanLen; k++) {
      const idx = s + k;
      if (idx >= unifiedTimes.length) return true; // cannot complete full span
      if (slotLocked(bunk, idx)) return true;
    }
    return false;
  }

  function canUseField(fieldName, start, end, s) {
    if (!fieldName) return false;
    if (occupiedFieldsBySlot[s].has(fieldName)) return false;
    if (globalResourceUsage[fieldName]) {
      for (const r of globalResourceUsage[fieldName]) {
        if (overlaps(start, end, r.start, r.end)) return false;
      }
    }
    return true;
  }

  function reserveField(fieldName, start, end, s, sportName = null) {
    if (!fieldName) return;
    if (!globalResourceUsage[fieldName]) globalResourceUsage[fieldName] = [];
    globalResourceUsage[fieldName].push({ start, end });
    for (let k = 0; k < spanLen; k++) {
      const idx = s + k;
      if (idx >= unifiedTimes.length) break;
      occupiedFieldsBySlot[idx].add(fieldName);
      if (sportName) globalActivityLock[idx].add(norm(sportName));
    }
  }

  // Seed per-slot occupied fields from anything already placed (e.g., fixed/league from a previous run)
  for (let s = 0; s < unifiedTimes.length; s++) {
    Object.keys(scheduleAssignments).forEach(b => {
      const e = scheduleAssignments[b][s];
      if (!e) return;
      // If an entry explicitly uses a field (true field/league), reserve the field name
      if (e.field && e.sport) {
        const start = unifiedTimes[s].start;
        const end = new Date(start.getTime() + activityDuration * 60000);
        reserveField(e.field, start, end, s, e.sport);
      }
    });
  }

  // Helper: is any division toggled for leagues?
  function isGlobalLeaguesDay() {
    if (!leagues) return false;
    return Object.values(leagues).some(cfg => cfg && cfg.enabled === true);
  }

  // -------------------- 1) Schedule Guaranteed Leagues --------------------
  const leagueSlotByDiv = {};
  const priorityDivs = [...availableDivisions].reverse(); // older → younger priority

  const globalLeaguesOn = isGlobalLeaguesDay();

  for (const div of priorityDivs) {
    const activeSlots = Array.from(divisionActiveRows[div] || []);
    if (activeSlots.length === 0) continue;

    const wantsLeague = globalLeaguesOn || (leagues && leagues[div]?.enabled);
    if (!wantsLeague) continue;

    // Choose a spread-out league slot if possible
    let chosenSlot = null;
    for (const slot of activeSlots) {
      const slotStart = unifiedTimes[slot].start;
      const slotEnd = new Date(slotStart.getTime() + activityDuration * 60000);
      const clashing = leagueTimeLocks.some(l => overlaps(slotStart, slotEnd, l.start, l.end));
      if (!clashing) {
        chosenSlot = slot; leagueTimeLocks.push({ start: slotStart, end: slotEnd });
        break;
      }
    }
    if (chosenSlot === null) chosenSlot = activeSlots[0];
    leagueSlotByDiv[div] = chosenSlot;

    const slotStart = unifiedTimes[chosenSlot].start;
    const slotEnd = new Date(slotStart.getTime() + activityDuration * 60000);

    (divisions[div]?.bunks || []).forEach(b => {
      // NEW: don't overwrite fixed/locked
      if (slotLocked(b, chosenSlot) || anyLockedSpan(b, chosenSlot)) return;

      const leagueAct = { type: 'special', field: { name: 'Leagues' }, sport: null };
      const key = activityKey(leagueAct);

      scheduleAssignments[b][chosenSlot] = {
        field: 'Leagues',
        sport: null,
        continuation: false,
        isLeague: true
      };

      // Fill continuations
      for (let k = 1; k < spanLen; k++) {
        const idx = chosenSlot + k;
        if (idx >= unifiedTimes.length) break;
        if (!(divisionActiveRows[div] && divisionActiveRows[div].has(idx))) break;
        if (slotLocked(b, idx)) break; // NEW safeguard
        scheduleAssignments[b][idx] = {
          field: 'Leagues',
          sport: null,
          continuation: true,
          isLeague: true
        };
      }

      if (key) usedActivityKeysByBunk[b].add(key); // counts as special once per day
      fieldsUsedByBunk[b].add('Leagues');
    });

    // Reserve a synthetic field so leagues don’t collide cross-division
    reserveField(`LEAGUE-${div}`, slotStart, slotEnd, chosenSlot, 'Leagues');
  }

  // -------------------- 2) Fill Every Remaining Slot --------------------
  const PLACEHOLDER_NAME = 'Special Activity Needed';

  function baseFeasible(act, bunk, slotStart, slotEnd, s, allowFieldReuse) {
    const fieldName = act?.field?.name;
    if (!fieldName) return false;

    // NEW: cannot place if any row in span is locked by fixed (or otherwise)
    if (anyLockedSpan(bunk, s)) return false;

    // Prevent two bunks on the same physical field at the same time
    if (act.type === "field" && !canUseField(fieldName, slotStart, slotEnd, s)) return false;

    // Prevent same sport on multiple fields in the SAME slot (optional lock)
    if (act.sport && globalActivityLock[s].has(norm(act.sport))) return false;

    // ABSOLUTE RULE: never repeat the same sport OR same special for this bunk in the same day
    const key = activityKey(act);
    if (key && usedActivityKeysByBunk[bunk]?.has(key)) return false;

    // Soft: avoid reusing the same field for this bunk unless we must
    if (act.type === "field" && !allowFieldReuse && fieldsUsedByBunk[bunk]?.has(fieldName)) return false;

    return true;
  }

  function chooseActivity(bunk, slotStart, slotEnd, s) {
    // Tier A: all constraints, no field reuse
    let pool = allActivities.filter(a => baseFeasible(a, bunk, slotStart, slotEnd, s, false));
    if (pool.length > 0) return pool[Math.floor(Math.random() * pool.length)];

    // Tier B: allow field reuse (still no repeat keys)
    pool = allActivities.filter(a => baseFeasible(a, bunk, slotStart, slotEnd, s, true));
    if (pool.length > 0) return pool[Math.floor(Math.random() * pool.length)];

    // Nothing valid → placeholder that does NOT count toward repeats
    return { type: 'special', field: { name: PLACEHOLDER_NAME }, sport: null, _placeholder: true };
  }

  for (let s = 0; s < unifiedTimes.length; s++) {
    const slotStart = unifiedTimes[s].start;
    const slotEnd = new Date(slotStart.getTime() + activityDuration * 60000);

    for (const div of priorityDivs) {
      if (!(divisionActiveRows[div] && divisionActiveRows[div].has(s))) continue;

      for (const bunk of (divisions[div]?.bunks || [])) {
        // Skip if something already placed (league/fixed/continued)
        if (scheduleAssignments[bunk][s]) continue;

        const chosen = chooseActivity(bunk, slotStart, slotEnd, s);

        // NEW safeguard: if any locked in span, place placeholder instead
        const blocked = anyLockedSpan(bunk, s);
        const toPlace = blocked ? { type: 'special', field: { name: PLACEHOLDER_NAME }, sport: null, _placeholder: true } : chosen;

        // Write head
        scheduleAssignments[bunk][s] = {
          field: toPlace.field.name,
          sport: toPlace.sport,
          continuation: false,
          isLeague: false
        };

        // Reserve only for real field activities
        if (!toPlace._placeholder && toPlace.type === "field") {
          reserveField(toPlace.field.name, slotStart, slotEnd, s, toPlace.sport);
        }

        // Continuations over spanLen
        for (let k = 1; k < spanLen; k++) {
          const idx = s + k;
          if (idx >= unifiedTimes.length) break;
          if (!(divisionActiveRows[div] && divisionActiveRows[div].has(idx))) break;
          if (scheduleAssignments[bunk][idx]) break; // already filled by league/fixed etc.
          if (slotLocked(bunk, idx)) break; // NEW safeguard

          const contStart = unifiedTimes[idx].start;
          const contEnd = new Date(contStart.getTime() + activityDuration * 60000);

          scheduleAssignments[bunk][idx] = {
            field: toPlace.field.name,
            sport: toPlace.sport,
            continuation: true,
            isLeague: false
          };

          if (!toPlace._placeholder && toPlace.type === "field") {
            reserveField(toPlace.field.name, contStart, contEnd, idx, toPlace.sport);
          }
        }

        // Track per-bunk usage (skip placeholder)
        if (!toPlace._placeholder) {
          const key = activityKey(toPlace);
          if (key) usedActivityKeysByBunk[bunk].add(key);
          fieldsUsedByBunk[bunk].add(toPlace.field.name);
        }
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

  // clear helper flags from any prior render
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
    th.colSpan = (divisions[div]?.bunks || []).length;
    th.textContent = div;
    th.style.background = divisions[div]?.color || '#333';
    th.style.color = "#fff";
    row1.appendChild(th);
  });
  thead.appendChild(row1);

  const row2 = document.createElement("tr");
  const thB = document.createElement("th");
  thB.textContent = "Bunk";
  row2.appendChild(thB);
  availableDivisions.forEach(div => {
    (divisions[div]?.bunks || []).forEach(b => {
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
      (divisions[div]?.bunks || []).forEach(b => {
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

          // Render pills for leagues & needs-special, simple label for fixed/daily (e.g., Lunch)
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
