// -------------------- scheduler_ui.js --------------------
//
// ... (previous changelog) ...
//
// --- "LEAGUE MIRRORING" FIX (11/13) ---
// - **UPDATED:** The `renderStaggeredView` function for
//   league blocks has been rewritten.
// - It no longer tries to "find" games by looping
//   over bunks in the division.
// - It now gets the schedule entry for the *first bunk*
//   and looks for the new `_allMatchups` list.
// - If that list exists, it prints it. This ensures
//   that all divisions in a league (e.g., Div 5 and Div 6)
//   show the identical, complete, "mirrored" list of
//   all games for that block.
//
// --- NEW FEATURE (USER REQUEST): POST-GENERATION EDITING ---
// - **NEW:** Added `findSlotsForRange` helper to find all unified slots in a block.
// - **NEW:** Added `editCell` function. This is triggered by `onclick`.
//   - It opens a `prompt()` to get a new activity name.
//   - It overwrites the schedule for all slots in that block for that bunk.
//   - The new entry is marked as `_fixed: true`.
//   - It saves and re-renders the table.
// - **UPDATED:** `renderStaggeredView` now adds an `onclick` handler to all
//   individual (non-league) activity cells to trigger `editCell`.
//
// --- NEW FIX (Closest Slot) ---
// - **FIXED:** `findFirstSlotForTime` now finds the 30-minute
//   slot that is *closest* to the custom block's start time,
//   preventing the "off-by-one" display bug.
//
// --- NEW FIX (Dismissal Handling) ---
// - **NEW:** Blocks whose event is "Dismissal" are rendered as
//   "Dismissal" for every bunk in that division, non-editable,
//   and visually highlighted.
// -----------------------------------------------------------------

// ===== HELPERS =====
const INCREMENT_MINS = 30; // Base optimizer grid size

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
    if (hh === 12) hh = mer === "am" ? 0 : 12; // 12am -> 0, 12pm -> 12
    else if (mer === "pm") hh += 12; // 1pm -> 13
  } else {
    return null; // AM/PM is required
  }

  return hh * 60 + mm;
}

function fieldLabel(f) {
  if (typeof f === "string") return f;
  if (f && typeof f === "object" && typeof f.name === "string") return f.name;
  return "";
}

function fmtTime(d) {
  if (!d) return "";
  if (typeof d === "string") {
    d = new Date(d);
  }
  let h = d.getHours(),
    m = d.getMinutes().toString().padStart(2, "0"),
    ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}

/**
 * Helper: Converts minutes (e.g., 740) to a 12-hour string (e.g., "12:20 PM")
 */
function minutesToTimeLabel(min) {
  if (min == null || Number.isNaN(min)) return "Invalid Time"; // <-- SAFETY CHECK
  let h = Math.floor(min / 60);
  const m = (min % 60).toString().padStart(2, "0");
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}

// ===== NEW EDITING FUNCTIONS =====

/**
 * NEW Helper: Finds all unified slot indices within a time range.
 */
function findSlotsForRange(startMin, endMin) {
  const slots = [];
  if (!window.unifiedTimes) return slots;
  for (let i = 0; i < window.unifiedTimes.length; i++) {
    const slot = window.unifiedTimes[i];
    const slotStart =
      new Date(slot.start).getHours() * 60 +
      new Date(slot.start).getMinutes();
    // Slot starts within the block
    if (slotStart >= startMin && slotStart < endMin) {
      slots.push(i);
    }
  }
  return slots;
}

/**
 * Handles the editing of a single schedule cell.
 */
function editCell(bunkName, startMin, endMin, currentActivity) {
  if (!bunkName) return;

  const newActivityName = prompt(
    `Edit activity for ${bunkName}\n(${minutesToTimeLabel(
      startMin
    )} - ${minutesToTimeLabel(
      endMin
    )}):\n\n(Enter 'CLEAR' or 'FREE' to empty the slot)`,
    currentActivity
  );

  // User cancelled
  if (newActivityName === null) return;

  const finalActivityName = newActivityName.trim();
  const slotsToUpdate = findSlotsForRange(startMin, endMin);

  if (slotsToUpdate.length === 0) {
    console.error("Could not find slots to update for", startMin, endMin);
    return;
  }

  if (!window.scheduleAssignments[bunkName]) {
    window.scheduleAssignments[bunkName] = new Array(
      window.unifiedTimes.length
    );
  }

  if (
    finalActivityName === "" ||
    finalActivityName.toUpperCase() === "CLEAR" ||
    finalActivityName.toUpperCase() === "FREE"
  ) {
    // Clear the slots by setting to "Free"
    slotsToUpdate.forEach((slotIndex, idx) => {
      window.scheduleAssignments[bunkName][slotIndex] = {
        field: "Free",
        sport: null,
        continuation: idx > 0, // "Free" can also be a block
        _fixed: true, // Mark as manually set
        _h2h: false,
        _activity: "Free",
      };
    });
  } else {
    // Set the new activity
    slotsToUpdate.forEach((slotIndex, idx) => {
      window.scheduleAssignments[bunkName][slotIndex] = {
        field: finalActivityName,
        sport: null, // It's a custom pin, not a sport/field combo
        continuation: idx > 0, // Mark as continuation
        _fixed: true, // Mark as a manual override
        _h2h: false,
        vs: null,
        _activity: finalActivityName,
      };
    });
  }

  // Save and re-render
  saveSchedule();
  updateTable();
}

// ===== Main updateTable function =====
/**
 * UPDATED: This function no longer checks for a toggle
 * and *only* calls renderStaggeredView.
 */
function updateTable() {
  const container = document.getElementById("scheduleTable");
  if (!container) return;

  // Always render the Staggered View
  renderStaggeredView(container);
}

/**
 * Helper function to get the schedule entry for a slot.
 */
function getEntry(bunk, slotIndex) {
  const assignments = window.scheduleAssignments || {};
  if (bunk && assignments[bunk] && assignments[bunk][slotIndex]) {
    return assignments[bunk][slotIndex];
  }
  return null; // Return null if empty or bunk is invalid
}

/**
 * Helper to format a schedule entry into text.
 */
function formatEntry(entry) {
  if (!entry) return "";

  // 🔹 Dismissal safety: if core marked it as dismissal, show "Dismissal"
  if (entry._isDismissal) {
    return "Dismissal";
  }

  const label = fieldLabel(entry.field) || "";

  if (entry._h2h) {
    // This is a league game, but being shown in an
    // individual cell (e.g. split activity).
    // The 'sport' field contains the full matchup label.
    return entry.sport || "League Game";
  } else if (entry._fixed) {
    // Fixed/pinned activities (Lunch, Learning, etc.)
    return label || entry._activity || "";
  } else if (entry.sport) {
    return `${label} – ${entry.sport}`;
  } else {
    return label;
  }
}

/**
 * Helper: Finds the *first* 30-min slot index
 * that matches the start time of a custom block.
 */
function findFirstSlotForTime(startMin) {
  if (startMin === null || !window.unifiedTimes) return -1; // <-- SAFETY CHECK
  for (let i = 0; i < window.unifiedTimes.length; i++) {
    const slot = window.unifiedTimes[i];
    const slotStart =
      new Date(slot.start).getHours() * 60 +
      new Date(slot.start).getMinutes();
    // Failsafe: find the closest one
    if (slotStart >= startMin && slotStart < startMin + INCREMENT_MINS) {
      return i;
    }
  }
  return -1;
}

/**
 * Renders the "Staggered" (YKLI) view
 * --- one table PER DIVISION ---
 * --- with LEAGUE MIRRORING & EDIT-ON-CLICK ---
 * --- and explicit Dismissal handling ---
 */
function renderStaggeredView(container) {
  container.innerHTML = "";

  const availableDivisions = window.availableDivisions || [];
  const divisions = window.divisions || {};
  const scheduleAssignments = window.scheduleAssignments || {};

  const dailyData = window.loadCurrentDailyData?.() || {};
  const manualSkeleton = dailyData.manualSkeleton || [];

  // --- NEW: Load previous day's counters ---
  const prevDailyData = window.loadPreviousDailyData?.() || {};
  const prevCounters = prevDailyData.leagueDayCounters || {};
  const todayCounters = {}; // This will be saved at the end

  if (manualSkeleton.length === 0) {
    container.innerHTML =
      "<p>No schedule built for this day. Go to the 'Daily Adjustments' tab to build one.</p>";
    return;
  }

  // --- NEW: Add a wrapper for side-by-side styling ---
  const wrapper = document.createElement("div");
  wrapper.className = "schedule-view-wrapper";
  container.appendChild(wrapper);

  // --- 1. Loop over each division and create a separate table ---
  availableDivisions.forEach((div) => {
    const bunks = (divisions[div]?.bunks || []).sort();
    if (bunks.length === 0) return; // Don't render a table for a division with no bunks

    const table = document.createElement("table");
    table.className = "schedule-division-table"; // NEW CLASS
    table.style.borderCollapse = "collapse";

    // --- 2. Build Header for this division ---
    const thead = document.createElement("thead");
    const tr1 = document.createElement("tr"); // Division name
    const tr2 = document.createElement("tr"); // Column titles (Time, Bunk 1, Bunk 2...)

    const thDiv = document.createElement("th");
    thDiv.colSpan = 1 + bunks.length; // 1 for Time, N for bunks
    thDiv.textContent = div; // Division name
    thDiv.style.background = divisions[div]?.color || "#333";
    thDiv.style.color = "#fff";
    thDiv.style.border = "1px solid #999";
    tr1.appendChild(thDiv);

    const thTime = document.createElement("th");
    thTime.textContent = "Time";
    thTime.style.minWidth = "100px";
    thTime.style.border = "1px solid #999";
    tr2.appendChild(thTime);

    bunks.forEach((b) => {
      const thBunk = document.createElement("th");
      thBunk.textContent = b;
      thBunk.style.border = "1px solid #999";
      thBunk.style.minWidth = "120px";
      tr2.appendChild(thBunk);
    });
    thead.appendChild(tr1);
    thead.appendChild(tr2);
    table.appendChild(thead);

    // --- 3. Build Body for this division (Event-based) ---
    const tbody = document.createElement("tbody");

    // --- Pre-filter, validate, and sort blocks for this division ---
    const tempSortedBlocks = [];
    manualSkeleton.forEach((item) => {
      if (item.division === div) {
        const startMin = parseTimeToMinutes(item.startTime);
        const endMin = parseTimeToMinutes(item.endTime);

        if (startMin === null || endMin === null) {
          return; // Invalid time
        }

        const divData = divisions[div];
        if (divData) {
          const divStartMin = parseTimeToMinutes(divData.startTime);
          const divEndMin = parseTimeToMinutes(divData.endTime);

          if (divStartMin !== null && endMin <= divStartMin) {
            return; // Block too early
          }
          if (divEndMin !== null && startMin >= divEndMin) {
            return; // Block too late
          }
        }

        tempSortedBlocks.push({ item, startMin, endMin });
      }
    });

    // Sort by start time, so counters are sequential
    tempSortedBlocks.sort((a, b) => a.startMin - b.startMin);

    // --- Build final blocks WITH counters for leagues/specialty ---
    const prevDivCounts = prevCounters[div] || { league: 0, specialty: 0 };
    let todayLeagueCount = prevDivCounts.league;
    let todaySpecialtyCount = prevDivCounts.specialty;

    const divisionBlocks = [];

    tempSortedBlocks.forEach((block) => {
      const { item, startMin, endMin } = block;

      let eventName = item.event;

      // League & specialty counters only, do NOT change Dismissal
      if (item.event === "League Game") {
        todayLeagueCount++;
        eventName = `League Game ${todayLeagueCount}`;
      } else if (item.event === "Specialty League") {
        todaySpecialtyCount++;
        eventName = `Specialty League ${todaySpecialtyCount}`;
      }

      divisionBlocks.push({
        label: `${minutesToTimeLabel(startMin)} - ${minutesToTimeLabel(
          endMin
        )}`,
        startMin: startMin,
        endMin: endMin,
        event: eventName,
        type: item.type,
      });
    });

    // Store the *final* new counts to be saved
    todayCounters[div] = {
      league: todayLeagueCount,
      specialty: todaySpecialtyCount,
    };

    const uniqueBlocks = divisionBlocks.filter(
      (block, index, self) =>
        index === self.findIndex((t) => t.label === block.label)
    );

    // --- "Flatten" split blocks into two half-blocks ---
    const flattenedBlocks = [];
    uniqueBlocks.forEach((block) => {
      if (
        block.type === "split" &&
        block.startMin !== null &&
        block.endMin !== null
      ) {
        const midMin = Math.round(
          block.startMin + (block.endMin - block.startMin) / 2
        );

        // First half
        flattenedBlocks.push({
          ...block,
          label: `${minutesToTimeLabel(block.startMin)} - ${minutesToTimeLabel(
            midMin
          )}`,
          startMin: block.startMin,
          endMin: midMin,
          splitPart: 1,
        });
        // Second half
        flattenedBlocks.push({
          ...block,
          label: `${minutesToTimeLabel(midMin)} - ${minutesToTimeLabel(
            block.endMin
          )}`,
          startMin: midMin,
          endMin: block.endMin,
          splitPart: 2,
        });
      } else {
        flattenedBlocks.push(block);
      }
    });

    // --- 4. Render rows for this division ---
    if (flattenedBlocks.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = bunks.length + 1;
      td.textContent =
        "No schedule blocks found for this division in the template.";
      td.className = "grey-cell";
      tr.appendChild(td);
      tbody.appendChild(tr);
    }

    flattenedBlocks.forEach((eventBlock) => {
      const tr = document.createElement("tr");

      // --- Add the TIME cell ---
      const tdTime = document.createElement("td");
      tdTime.style.border = "1px solid #ccc";
      tdTime.style.verticalAlign = "top";
      tdTime.style.fontWeight = "bold";
      tdTime.textContent = eventBlock.label;
      tr.appendChild(tdTime);

      // --- Add ACTIVITY cells (Merged or Individual) ---
      if (
        eventBlock.event.startsWith("League Game") ||
        eventBlock.event.startsWith("Specialty League")
      ) {
        // === LEAGUE GAME / SPECIALTY LEAGUE: MERGED CELL ===
        const tdLeague = document.createElement("td");
        tdLeague.colSpan = bunks.length;
        tdLeague.style.verticalAlign = "top";
        tdLeague.style.textAlign = "left";
        tdLeague.style.padding = "5px 8px";
        tdLeague.style.background = "#f0f8f0"; // Light green

        const firstSlotIndex = findFirstSlotForTime(eventBlock.startMin);
        let allMatchups = [];

        // Find the entry for the first bunk in this division's table
        if (bunks.length > 0) {
          const firstBunkEntry = getEntry(bunks[0], firstSlotIndex);
          // Check if the "stamped" list exists
          if (firstBunkEntry && firstBunkEntry._allMatchups) {
            allMatchups = firstBunkEntry._allMatchups;
          }
        }

        // Render the mirrored list
        let html = "";
        if (allMatchups.length === 0) {
          html = `<p class="muted" style="margin:0; padding: 4px;">${eventBlock.event}</p>`;
        } else {
          html = `<p style="margin:2px 0 5px 4px; font-weight: bold;">${eventBlock.event}</p>`;
          html += '<ul style="margin: 0; padding-left: 18px;">';
          allMatchups.forEach((matchupLabel) => {
            html += `<li>${matchupLabel}</li>`;
          });
          html += "</ul>";
        }
        tdLeague.innerHTML = html;
        tr.appendChild(tdLeague);
      } else {
        // === REGULAR GAME / SPLIT GAME / DISMISSAL: INDIVIDUAL CELLS ===
        const isDismissalBlock =
          typeof eventBlock.event === "string" &&
          eventBlock.event.toLowerCase().includes("dismissal");

        bunks.forEach((bunk) => {
          const tdActivity = document.createElement("td");
          tdActivity.style.border = "1px solid #ccc";
          tdActivity.style.verticalAlign = "top";

          const startMin = eventBlock.startMin;
          const endMin = eventBlock.endMin;

          if (isDismissalBlock) {
            // 🔹 Explicit Dismissal rendering: non-editable, visible everywhere
            tdActivity.textContent = "Dismissal";
            tdActivity.style.background = "#ffecec"; // light red/pink
            tdActivity.style.fontWeight = "bold";
            tdActivity.style.cursor = "default";
            tdActivity.title = "Dismissal";
            tr.appendChild(tdActivity);
            return; // next bunk
          }

          // === Normal behavior for non-dismissal cells ===
          const slotIndex = findFirstSlotForTime(startMin);
          const entry = getEntry(bunk, slotIndex);

          let currentActivity = "";
          if (entry) {
            currentActivity = formatEntry(entry);
            tdActivity.textContent = currentActivity;

            if (entry._h2h) {
              tdActivity.style.background = "#e8f4ff";
              tdActivity.style.fontWeight = "bold";
            } else if (entry._fixed) {
              tdActivity.style.background = "#fff8e1"; // Light yellow for fixed/pinned
            }
          }

          // Add the click handler
          tdActivity.style.cursor = "pointer";
          tdActivity.title = "Click to edit this activity";
          tdActivity.onclick = () =>
            editCell(bunk, startMin, endMin, currentActivity);

          tr.appendChild(tdActivity);
        });
      }

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrapper.appendChild(table); // Add table to wrapper
  }); // --- End of main division loop ---

  // --- Save the new counters to today's data ---
  window.saveCurrentDailyData?.("leagueDayCounters", todayCounters);
}

// ===== Save/Load/Init =====

function saveSchedule() {
  try {
    window.saveCurrentDailyData?.(
      "scheduleAssignments",
      window.scheduleAssignments
    );
    window.saveCurrentDailyData?.(
      "leagueAssignments",
      window.leagueAssignments
    );
    window.saveCurrentDailyData?.("unifiedTimes", window.unifiedTimes);
  } catch (e) {
    // save failed
  }
}

function reconcileOrRenderSaved() {
  try {
    const data = window.loadCurrentDailyData?.() || {};
    window.scheduleAssignments = data.scheduleAssignments || {};
    window.leagueAssignments = data.leagueAssignments || {};

    const savedTimes = data.unifiedTimes || [];
    window.unifiedTimes = savedTimes.map((slot) => ({
      ...slot,
      start: new Date(slot.start),
      end: new Date(slot.end),
    }));
  } catch (e) {
    window.scheduleAssignments = {};
    window.leagueAssignments = {};
    window.unifiedTimes = [];
  }

  updateTable(); // This will now call the correct renderer
}

/**
 * Init: load saved data and render.
 */
function initScheduleSystem() {
  try {
    window.scheduleAssignments = window.scheduleAssignments || {};
    window.leagueAssignments = window.leagueAssignments || {};
    reconcileOrRenderSaved();
  } catch (e) {
    updateTable();
  }
}

// ===== Exports =====
window.updateTable = window.updateTable || updateTable;
window.initScheduleSystem = window.initScheduleSystem || initScheduleSystem;
window.saveSchedule = window.saveSchedule || saveSchedule;
