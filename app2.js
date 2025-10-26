// app2.js
// Scheduling Core: Guarantees league slots when enabled + unique league times per division
// Depends on globals defined in app1.js.

// -------------------- League Helpers --------------------
let leagueRowByDiv = {};         // { divName: rowIndex }
let leagueRowTaken = new Set();  // Set(rowIndex)

/**
 * Reserve one unique row (timeslot) for each division with leagues enabled.
 * Ensures no two league-enabled divisions share the same timeslot.
 */
function reserveLeagueRows() {
  leagueRowByDiv = {};
  leagueRowTaken.clear();

  const leagueDivs = (availableDivisions || []).filter(
    d => leagues && leagues[d] && leagues[d].enabled
  );

  if (leagueDivs.length === 0) return;

  if (!Array.isArray(unifiedTimes) || unifiedTimes.length === 0) {
    console.warn("No time rows to reserve for leagues.");
    return;
  }

  const N = unifiedTimes.length;
  // Build a spread-out order to reduce clustering
  const step = Math.max(1, Math.floor(N / Math.max(1, leagueDivs.length)));
  const candidateOrder = [];
  let start = Math.floor(N / 2);
  for (let i = 0; i < N; i++) candidateOrder.push((start + i * step) % N);

  // De-duplicate & clamp
  const seen = new Set();
  const orderedRows = [];
  for (const r of candidateOrder) {
    const rr = ((r % N) + N) % N;
    if (!seen.has(rr)) {
      seen.add(rr);
      orderedRows.push(rr);
    }
    if (orderedRows.length === N) break;
  }

  // If you want to prioritize certain divisions (e.g., older first), sort here.
  // Example (customize as needed):
  // const priorityIndex = { "5th": 1, "6th": 2, "7th": 3, "8th": 4, "9th": 5 };
  // leagueDivs.sort((a,b) => (priorityIndex[b]||0) - (priorityIndex[a]||0)); // older first

  let cursor = 0;
  for (const div of leagueDivs) {
    let picked = -1;

    // try preferred spread order
    for (let k = 0; k < orderedRows.length; k++) {
      const idx = orderedRows[(cursor + k) % orderedRows.length];
      if (!leagueRowTaken.has(idx)) { picked = idx; break; }
    }
    // fallback linear scan
    if (picked === -1) {
      for (let r = 0; r < N; r++) {
        if (!leagueRowTaken.has(r)) { picked = r; break; }
      }
    }

    if (picked === -1) {
      console.warn(`Unable to reserve unique league row for ${div}.`);
      continue;
    }
    leagueRowByDiv[div] = picked;
    leagueRowTaken.add(picked);
    cursor++;
  }
}

/** Return fields that can host any league sport and are available. */
function getLeagueCapableFields() {
  if (!Array.isArray(fields)) return [];
  return fields.filter(
    f =>
      f &&
      f.available &&
      Array.isArray(f.activities) &&
      f.activities.some(a => Array.isArray(leagueSports) && leagueSports.includes(a))
  );
}

/** Pick a league sport for a division, preferring ones actually hostable today. */
function pickLeagueSportForDivision(divName) {
  const hostable = new Set();
  for (const f of getLeagueCapableFields()) {
    for (const a of f.activities) hostable.add(a);
  }
  if (Array.isArray(leagueSports)) {
    for (const s of leagueSports) {
      if (hostable.has(s)) return s;
    }
    return leagueSports[0] || "League";
  }
  return "League";
}

// -------------------- Scheduling Core --------------------
/**
 * Main scheduler:
 * - If a division's Leagues toggle is ON, it MUST get a league slot that day.
 * - No two divisions run leagues in the same timeslot.
 * - No shortening of slots (uses unifiedTimes grid exactly).
 * - No bunk repeats same sport within the day.
 * - No two bunks use the same field at the same time.
 * - Fallback marks "Special Activity Needed" when no valid placement exists.
 */
function assignFieldsToBunks() {
  const availFields = (Array.isArray(fields) ? fields : []).filter(
    f => f && f.available && Array.isArray(f.activities) && f.activities.length > 0
  );
  const availSpecials = (Array.isArray(specialActivities) ? specialActivities : []).filter(
    s => s && s.available
  );

  // Build catalog of all possible activities
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

  // Reset schedule array per bunk x timeslot
  scheduleAssignments = {};
  (availableDivisions || []).forEach(div => {
    const bunksInDiv = (divisions[div]?.bunks) || [];
    bunksInDiv.forEach(b => {
      scheduleAssignments[b] = new Array(unifiedTimes.length);
    });
  });

  // 1) Reserve unique league rows for all league-enabled divisions
  reserveLeagueRows();

  // 2) Pre-place league blocks on the reserved rows
  const leagueFieldsPool = getLeagueCapableFields();
  const leagueDivs = (availableDivisions || []).filter(d => leagues && leagues[d] && leagues[d].enabled);

  leagueDivs.forEach(div => {
    const row = leagueRowByDiv[div];
    if (row == null) return; // nothing reserved

    const sport = pickLeagueSportForDivision(div);
    const divBunks = (divisions[div]?.bunks) || [];
    if (divBunks.length === 0) return;

    const rowFieldUse = new Set();
    let fieldIndex = 0;

    function nextLeagueFieldForSport() {
      // cycle through league-capable fields until we find one for this sport not yet used in this row
      for (let tries = 0; tries < leagueFieldsPool.length; tries++) {
        const f = leagueFieldsPool[fieldIndex % leagueFieldsPool.length];
        fieldIndex++;
        if (f.activities.includes(sport) && !rowFieldUse.has(f.name)) {
          rowFieldUse.add(f.name);
          return f;
        }
      }
      return null;
    }

    for (const bunk of divBunks) {
      const f = nextLeagueFieldForSport();
      if (!f) {
        // Not enough league-capable fields this row; still mark league, surface need.
        scheduleAssignments[bunk][row] = {
          field: { name: "Special Activity Needed" },
          sport: `LEAGUE (${sport})`,
          continuation: false,
          isLeague: true,
          _skip: false
        };
      } else {
        scheduleAssignments[bunk][row] = {
          field: { name: f.name },
          sport: `LEAGUE (${sport})`,
          continuation: false,
          isLeague: true,
          _skip: false
        };
      }
    }
  });

  // Helper: is a row a league row?
  function isLeagueRow(rowIdx) {
    return leagueRowTaken.has(rowIdx);
  }

  // 3) Fill remaining slots (non-league)
  const usedFieldAtRow = new Map(); // rowIdx -> Set(fieldName)

  // Seed fields already used by leagues
  for (const bunk in scheduleAssignments) {
    const arr = scheduleAssignments[bunk];
    if (!Array.isArray(arr)) continue;
    arr.forEach((cell, r) => {
      if (cell?.field?.name) {
        if (!usedFieldAtRow.has(r)) usedFieldAtRow.set(r, new Set());
        usedFieldAtRow.get(r).add(cell.field.name);
      }
    });
  }

  // Track sports used by each bunk (to prevent duplicates in the same day)
  const bunkUsedSports = {};
  for (const bunk in scheduleAssignments) {
    const cells = scheduleAssignments[bunk] || [];
    const used = new Set();
    for (const c of cells) {
      if (!c || !c.sport) continue;
      // Strip "LEAGUE (...)" wrapper if present for duplication purposes
      const normalized = c.sport.replace(/^LEAGUE\s*\(|\)$/g, "").trim();
      if (normalized) used.add(normalized);
    }
    bunkUsedSports[bunk] = used;
  }

  // Non-league activity pool
  const nonLeagueActivities = allActivities.filter(
    a => !(a.sport && Array.isArray(leagueSports) && leagueSports.includes(a.sport))
  );

  // fair rotation
  const rotate = (arr) => { if (arr.length) arr.push(arr.shift()); return arr; };

  for (let row = 0; row < unifiedTimes.length; row++) {
    const rowUsed = usedFieldAtRow.get(row) || new Set();

    for (const div of (availableDivisions || [])) {
      const bunksInDiv = (divisions[div]?.bunks) || [];

      for (const bunk of bunksInDiv) {
        // Skip if already assigned (e.g., league row)
        if (scheduleAssignments[bunk][row]) continue;

        let placed = false;
        let attempts = 0;

        while (!placed && attempts < nonLeagueActivities.length) {
          const act = nonLeagueActivities[0];
          rotate(nonLeagueActivities); // fairness
          attempts++;

          if (act.type === "field") {
            const fname = act.field.name;
            const sportName = act.sport;

            // No duplicate sport for same bunk within the day
            if (bunkUsedSports[bunk].has(sportName)) continue;

            // No two bunks on the same field at the same time
            if (rowUsed.has(fname)) continue;

            scheduleAssignments[bunk][row] = {
              field: { name: fname },
              sport: sportName,
              continuation: false,
              isLeague: false,
              _skip: false
            };
            rowUsed.add(fname);
            bunkUsedSports[bunk].add(sportName);
            placed = true;
          } else {
            // Special activity: not a sport, allowed anytime (no sport duplication rules)
            scheduleAssignments[bunk][row] = {
              field: { name: act.field.name }, // e.g., "Canteen", "Game Room"
              sport: null,
              continuation: false,
              isLeague: false,
              _skip: false
            };
            placed = true;
          }
        }

        if (!placed) {
          // No valid field/sport left that doesn't violate rules — show need
          scheduleAssignments[bunk][row] = {
            field: { name: "Special Activity Needed" },
            sport: null,
            continuation: false,
            isLeague: false,
            _skip: false
          };
        }
      }
    }

    if (rowUsed.size > 0) usedFieldAtRow.set(row, rowUsed);
  }

  // Optional: call renderer if present
  if (typeof rebuildScheduleTable === "function") {
    try { rebuildScheduleTable(); } catch (e) { console.warn(e); }
  }
}

// -------------------- Expose for other modules (optional) --------------------
window.assignFieldsToBunks = assignFieldsToBunks;
window.reserveLeagueRows = reserveLeagueRows;
window.getLeagueCapableFields = getLeagueCapableFields;
window.pickLeagueSportForDivision = pickLeagueSportForDivision;
