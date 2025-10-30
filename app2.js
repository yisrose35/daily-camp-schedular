// app2.js
// Scheduling Core: Fixed Activities take precedence (no shortening) + League guarantees + No resource overlaps
// Depends on globals from app1.js: bunks, divisions, availableDivisions, fields, specialActivities,
// leagues, timeTemplates, activityDuration, scheduleAssignments, unifiedTimes, divisionActiveRows

// -------------------- League Row Reservation --------------------
let leagueRowByDiv = {};         // { divName: rowIndex }
let leagueRowTaken = new Set();  // Set(rowIndex)

/**
 * Reserve one unique row (timeslot) for each division with leagues enabled.
 * Skips any rows blocked by fixed activities for that division.
 * @param {Object<string, Set<number>>} blockedRowsByDiv - rows taken by fixed activities per division
 */
function reserveLeagueRows(blockedRowsByDiv = {}) {
  leagueRowByDiv = {};
  leagueRowTaken.clear();

  const leagueDivs = (availableDivisions || []).filter(
    d => leagues && leagues[d] && leagues[d].enabled
  );

  if (leagueDivs.length === 0) return;
  if (!Array.isArray(unifiedTimes) || unifiedTimes.length === 0) {
    console.warn("No unifiedTimes to reserve for leagues.");
    return;
  }

  const N = unifiedTimes.length;
  const step = Math.max(1, Math.floor(N / Math.max(1, leagueDivs.length))); // spread out
  let startIdx = Math.floor(N / 3); // bias to middle third

  leagueDivs.forEach((div, pos) => {
    const forbidden = blockedRowsByDiv[div] || new Set();

    // try a spread index, then fall back to any free row
    let candidateOrder = [];
    for (let k = 0; k < N; k++) {
      candidateOrder.push((startIdx + k * step + pos) % N);
    }
    candidateOrder = Array.from(new Set(candidateOrder)); // unique order

    let chosen = null;
    for (const r of candidateOrder) {
      if (!leagueRowTaken.has(r) && !forbidden.has(r)) {
        chosen = r;
        break;
      }
    }
    if (chosen == null) {
      // last resort: first row not forbidden/taken
      for (let r = 0; r < N; r++) {
        if (!leagueRowTaken.has(r) && !forbidden.has(r)) {
          chosen = r;
          break;
        }
      }
    }

    if (chosen != null) {
      leagueRowByDiv[div] = chosen;
      leagueRowTaken.add(chosen);
    } else {
      console.warn(`Could not reserve a league row for division "${div}" (all rows blocked).`);
    }
  });
}

// -------------------- Fixed Activities Integration --------------------
/**
 * Parse "12:00", "12:00pm", "12:00 PM" -> minutes since midnight.
 */
function parseTimeToMinutes(str) {
  if (!str || typeof str !== "string") return null;
  let s = str.trim().toLowerCase();
  let mer = null;
  if (s.endsWith("am") || s.endsWith("pm")) {
    mer = s.endsWith("am") ? "am" : "pm";
    s = s.replace(/am|pm/g, "").trim();
  }
  const m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (Number.isNaN(hh) || Number.isNaN(mm) || mm < 0 || mm > 59) return null;

  if (mer) {
    if (hh === 12) hh = (mer === "am") ? 0 : 12;
    else if (mer === "pm") hh += 12;
  }
  return hh * 60 + mm;
}

/**
 * Find all row indices whose [row.start,row.end) lies fully inside [startMin,endMin).
 * If the fixed time does not align perfectly to grid, we include rows with any overlap,
 * but we NEVER shorten the fixed activity — it occupies the union of overlapping rows.
 */
function findRowsForRange(startStr, endStr) {
  if (!Array.isArray(unifiedTimes) || unifiedTimes.length === 0) return [];
  const startMin = parseTimeToMinutes(startStr);
  const endMin = parseTimeToMinutes(endStr);
  if (startMin == null || endMin == null || endMin <= startMin) return [];

  // unifiedTimes rows should each have .start and .end as Date objects of the same day.
  // Convert them to minutes since midnight.
  const rows = [];
  for (let i = 0; i < unifiedTimes.length; i++) {
    const r = unifiedTimes[i];
    const rs = r.start.getHours() * 60 + r.start.getMinutes();
    const re = r.end.getHours() * 60 + r.end.getMinutes();

    // If row fully inside fixed window, include
    if (rs >= startMin && re <= endMin) {
      rows.push(i);
    }
  }

  // If no fully-inside rows (misaligned), include any overlapping rows instead
  if (rows.length === 0) {
    for (let i = 0; i < unifiedTimes.length; i++) {
      const r = unifiedTimes[i];
      const rs = r.start.getHours() * 60 + r.start.getMinutes();
      const re = r.end.getHours() * 60 + r.end.getMinutes();
      const overlaps = Math.max(rs, startMin) < Math.min(re, endMin);
      if (overlaps) rows.push(i);
    }
  }
  return rows;
}

/**
 * Load active fixed activities from DailyActivities or localStorage.
 * Returns normalized array:
 * { id, name, start:"HH:MM", end:"HH:MM", divisions:[string], enabled:boolean }
 */
function loadActiveFixedActivities() {
  // Preferred: use exported helper if available
  if (window.DailyActivities && typeof window.DailyActivities.prePlace === "function") {
    try {
      const list = window.DailyActivities.prePlace({ dryRun: true });
      return Array.isArray(list) ? list.filter(a => a && a.enabled) : [];
    } catch (e) {
      console.warn("DailyActivities.prePlace() dryRun failed; falling back to localStorage.", e);
    }
  }

  // Fallback: try v2 key, then legacy
  let raw = localStorage.getItem("fixedActivities_v2");
  if (!raw) raw = localStorage.getItem("fixedActivities");
  try {
    const arr = JSON.parse(raw || "[]");
    return Array.isArray(arr) ? arr.filter(a => a && a.enabled) : [];
  } catch {
    return [];
  }
}

/**
 * Pre-place fixed activities into scheduleAssignments and mark blocked rows per division.
 * Returns { blockedRowsByDiv }
 */
function applyFixedActivities() {
  window.scheduleAssignments = window.scheduleAssignments || {};
  window.divisionActiveRows = window.divisionActiveRows || {}; // { div: Set(rowIdx) }

  const fixed = loadActiveFixedActivities();
  const blockedRowsByDiv = {};

  if (!Array.isArray(unifiedTimes) || unifiedTimes.length === 0) {
    console.warn("Fixed Activities: unifiedTimes not ready; skipping pre-place.");
    return { blockedRowsByDiv };
  }

  // Helper: get targeted divisions (empty array means "all")
  const targetDivisions = act => {
    if (Array.isArray(act.divisions) && act.divisions.length > 0) return act.divisions;
    return availableDivisions.slice(); // all divisions
  };

  fixed.forEach(act => {
    const rows = findRowsForRange(act.start, act.end);
    if (rows.length === 0) return;

    targetDivisions(act).forEach(div => {
      if (!divisions[div] || !Array.isArray(divisions[div].bunks)) return;

      // mark blocked rows for this division
      blockedRowsByDiv[div] = blockedRowsByDiv[div] || new Set();
      divisionActiveRows[div] = divisionActiveRows[div] || new Set();

      rows.forEach(r => {
        blockedRowsByDiv[div].add(r);
        divisionActiveRows[div].add(r);
      });

      // place into each bunk cell for those rows
      divisions[div].bunks.forEach(bunk => {
        scheduleAssignments[bunk] = scheduleAssignments[bunk] || new Array(unifiedTimes.length);
        rows.forEach((r, idx) => {
          // Do not overwrite if already fixed (idempotent)
          if (scheduleAssignments[bunk][r]?.isFixed) return;

          scheduleAssignments[bunk][r] = {
            type: "fixed",
            field: { name: act.name },
            sport: null,
            continuation: idx > 0, // visually mark continuation segments
            isFixed: true,
            _skip: false // retained for compatibility with any renderers that use _skip
          };
        });
      });
    });
  });

  return { blockedRowsByDiv };
}

// -------------------- Scheduling Core (No Repeats + No Resource Clashes) --------------------
/**
 * Assign remaining (non-fixed) activities to bunks across unifiedTimes.
 * - Skips cells already filled by fixed activities.
 * - Ensures no two bunks use the same field at the same time.
 * - Ensures no bunk repeats the same activity twice in a day.
 * - Honors league rows per-division (if reserved).
 */
function assignFieldsToBunks() {
  // Defensive guards for globals
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

  if (allActivities.length === 0 && (!window.DailyActivities)) {
    alert("No activities available.");
    scheduleAssignments = {};
    return;
  }

  // Reset schedule grid first (we will pre-place fixed next)
  scheduleAssignments = {};
  availableDivisions.forEach(div => {
    const list = (divisions[div]?.bunks) || [];
    list.forEach(b => {
      scheduleAssignments[b] = new Array(unifiedTimes.length);
    });
  });

  // 1) Pre-place Fixed Activities (highest precedence)
  const { blockedRowsByDiv } = applyFixedActivities();

  // 2) Reserve League Rows, avoiding fixed rows for each division
  reserveLeagueRows(blockedRowsByDiv);

  // 3) Build per-row resource locks (fields used at row r)
  const fieldUseByRow = Array.from({ length: unifiedTimes.length }, () => new Set());

  // 4) Per-bunk set of activities already played (prevent repeats)
  const playedByBunk = {};
  availableDivisions.forEach(div => {
    (divisions[div]?.bunks || []).forEach(b => {
      playedByBunk[b] = new Set(
        (scheduleAssignments[b] || [])
          .filter(Boolean)
          .map(cell => (cell.type === "fixed" ? `fixed:${cell.field?.name || ""}` : `${cell.field?.name || ""}|${cell.sport || ""}`))
      );
    });
  });

  // 5) Assign remaining slots
  for (let r = 0; r < unifiedTimes.length; r++) {
    availableDivisions.forEach(div => {
      const bunksInDiv = (divisions[div]?.bunks) || [];
      const isLeagueRow = leagueRowByDiv[div] === r;

      bunksInDiv.forEach(bunk => {
        // Skip if fixed already occupies this cell
        if (scheduleAssignments[bunk][r]) return;

        // Determine candidate pool:
        // If league row, restrict to enabled league sports for this division.
        let candidates;
        if (isLeagueRow && leagues && leagues[div]?.enabled) {
          const sports = Array.isArray(leagues[div].sports) ? leagues[div].sports : [];
          // map league sports to available fields that can host them
          const leagueActs = [];
          availFields.forEach(f => {
            f.activities.forEach(s => {
              if (sports.includes(s)) leagueActs.push({ type: "field", field: f, sport: s });
            });
          });
          candidates = leagueActs;
        } else {
          candidates = allActivities;
        }

        // Try to pick an activity that:
        //  - doesn't repeat for this bunk
        //  - its field is not already in use at row r
        //  - if it's a multi-row activity (duration), we do NOT shorten; but the unified grid
        //    already encodes duration in row length, so we just place at this row.
        let chosen = null;
        for (const act of candidates) {
          const key = act.type === "field"
            ? `${act.field.name}|${act.sport}`
            : `${act.field.name}|special`;

          if (playedByBunk[bunk].has(key)) continue; // no repeats
          if (act.type === "field" && fieldUseByRow[r].has(act.field.name)) continue; // resource clash

          chosen = act;
          break;
        }

        if (chosen) {
          // Place
          scheduleAssignments[bunk][r] = {
            type: chosen.type,
            field: { name: chosen.field.name },
            sport: chosen.sport,
            continuation: false,
            isFixed: false,
            _skip: false
          };
          // Lock resource
          if (chosen.type === "field") fieldUseByRow[r].add(chosen.field.name);
          // Mark as played to avoid repeats later
          const playedKey = chosen.type === "field"
            ? `${chosen.field.name}|${chosen.sport}`
            : `${chosen.field.name}|special`;
          playedByBunk[bunk].add(playedKey);
        }
        // If nothing fits, we leave the slot empty; fixed activities + constraints can make some rows intentionally blank.
      });
    });
  }
}

// -------------------- Expose Core --------------------
window.assignFieldsToBunks = assignFieldsToBunks;
window.reserveLeagueRows = reserveLeagueRows;
