// -------------------- scheduler_ui.js --------------------
//
// --- FEATURES ---
// - Staggered (YKLI) view: one table per division
// - League mirroring via _allMatchups list
// - Post-generation editing for ALL cells (generated + pins)
// - Dismissal / Snacks / custom tiles shown as fixed pin tiles
// - Split blocks: UI shows whatever the core actually scheduled
// - League counters (League Game 1, 2, 3...) persisted day-to-day
//
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
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}

/**
 * Helper: Converts minutes (e.g., 740) to a 12-hour string (e.g., "12:20 PM")
 */
function minutesToTimeLabel(min) {
  if (min == null || Number.isNaN(min)) return "Invalid Time"; // safety check
  let h = Math.floor(min / 60);
  const m = (min % 60).toString().padStart(2, "0");
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}

// ===== MATCH GENERATED EVENTS (mirror of core) =====
const UI_GENERATED_EVENTS = new Set([
  "activity",
  "activities",
  "general activity",
  "general activity slot",
  "sports",
  "sport",
  "sports slot",
  "special activity",
  "league game",
  "specialty league",
  "speciality league",
  "swim"
]);

function uiIsGeneratedEventName(name) {
  if (!name) return false;
  return UI_GENERATED_EVENTS.has(String(name).trim().toLowerCase());
}

// ===== EDITING FUNCTIONS =====

/**
 * Helper: Finds all unified slot indices within a time range.
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
        _activity: "Free"
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
        _activity: finalActivityName
      };
    });
  }

  // Save and re-render
  saveSchedule();
  updateTable();
}

// ===== Main updateTable function =====

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

  // Safety: if core flagged it, force label
  if (entry._isDismissal) {
    return "Dismissal";
  }
  if (entry._isSnack) {
    return "Snacks";
  }

  const label = fieldLabel(entry.field) || "";

  if (entry._h2h) {
    // League game, 'sport' holds matchup label
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
  if (startMin === null || !window.unifiedTimes) return -1; // safety
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
 * --- and explicit Dismissal + Snacks + custom pin tiles ---
 */
function renderStaggeredView(container) {
  container.innerHTML = "";

  const availableDivisions = window.availableDivisions || [];
  const divisions = window.divisions || {};
  const scheduleAssignments = window.scheduleAssignments || {};

  const dailyData = window.loadCurrentDailyData?.() || {};
  const manualSkeleton = dailyData.manualSkeleton || [];

  // Load previous day's league counters
  const prevDailyData = window.loadPreviousDailyData?.() || {};
  const prevCounters = prevDailyData.leagueDayCounters || {};
  const todayCounters = {}; // This will be saved at the end

  if (manualSkeleton.length === 0) {
    container.innerHTML =
      "<p>No schedule built for this day. Go to the 'Daily Adjustments' tab to build one.</p>";
    return;
  }

  // Wrapper for side-by-side styling
  const wrapper = document.createElement("div");
  wrapper.className = "schedule-view-wrapper";
  container.appendChild(wrapper);

  // 1. Loop over each division and create a separate table
  availableDivisions.forEach((div) => {
    const bunks = (divisions[div]?.bunks || []).sort();
    if (bunks.length === 0) return; // no bunks, no table

    const table = document.createElement("table");
    table.className = "schedule-division-table";
    table.style.borderCollapse = "collapse";

    // Header
    const thead = document.createElement("thead");
    const tr1 = document.createElement("tr"); // Division name
    const tr2 = document.createElement("tr"); // Column titles

    const thDiv = document.createElement("th");
    thDiv.colSpan = 1 + bunks.length; // 1 for Time, N for bunks
    thDiv.textContent = div;
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

    // Body
    const tbody = document.createElement("tbody");

    // Pre-filter, validate, and sort blocks for this division
    const tempSortedBlocks = [];
    manualSkeleton.forEach((item) => {
      if (item.division === div) {
        const startMin = parseTimeToMinutes(item.startTime);
        const endMin = parseTimeToMinutes(item.endTime);

        if (startMin === null || endMin === null) {
          return; // invalid time
        }

        const divData = divisions[div];
        if (divData) {
          const divStartMin = parseTimeToMinutes(divData.startTime);
          const divEndMin = parseTimeToMinutes(divData.endTime);

          if (divStartMin !== null && endMin <= divStartMin) {
            return; // too early
          }
          if (divEndMin !== null && startMin >= divEndMin) {
            return; // too late
          }
        }

        tempSortedBlocks.push({ item, startMin, endMin });
      }
    });

    // Sort by start time
    tempSortedBlocks.sort((a, b) => a.startMin - b.startMin);

    // Build final blocks with league/specialty counters
    const prevDivCounts = prevCounters[div] || { league: 0, specialty: 0 };
    let todayLeagueCount = prevDivCounts.league;
    let todaySpecialtyCount = prevDivCounts.specialty;

    const divisionBlocks = [];

    tempSortedBlocks.forEach((block) => {
      const { item, startMin, endMin } = block;

      let eventName = item.event;

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
        startMin,
        endMin,
        event: eventName,
        type: item.type
      });
    });

    todayCounters[div] = {
      league: todayLeagueCount,
      specialty: todaySpecialtyCount
    };

    const uniqueBlocks = divisionBlocks.filter(
      (block, index, self) =>
        index === self.findIndex((t) => t.label === block.label)
    );

    // Flatten split blocks into two half-blocks (UI-level time split;
    // content comes from scheduleAssignments, not from this split)
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
          splitPart: 1
        });
        // Second half
        flattenedBlocks.push({
          ...block,
          label: `${minutesToTimeLabel(midMin)} - ${minutesToTimeLabel(
            block.endMin
          )}`,
          startMin: midMin,
          endMin: block.endMin,
          splitPart: 2
        });
      } else {
        flattenedBlocks.push(block);
      }
    });

    // Render rows
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

      // Time cell
      const tdTime = document.createElement("td");
      tdTime.style.border = "1px solid #ccc";
      tdTime.style.verticalAlign = "top";
      tdTime.style.fontWeight = "bold";
      tdTime.textContent = eventBlock.label;
      tr.appendChild(tdTime);

      // Activity cells
      if (
  eventBlock.event.startsWith("League Game") ||
  eventBlock.event.startsWith("Specialty League")
) {
  // LEAGUE / SPECIALTY: merged cell with mirrored games
  const tdLeague = document.createElement("td");
  tdLeague.colSpan = bunks.length;
  tdLeague.style.verticalAlign = "top";
  tdLeague.style.textAlign = "left";
  tdLeague.style.padding = "5px 8px";
  tdLeague.style.background = "#f0f8f0"; // light green

  const firstSlotIndex = findFirstSlotForTime(eventBlock.startMin);
  let allMatchups = [];

  // 🔍 NEW: scan all bunks until we find one that has _allMatchups
  if (bunks.length > 0 && firstSlotIndex >= 0) {
    for (const bunk of bunks) {
      const entry = getEntry(bunk, firstSlotIndex);
      if (entry && Array.isArray(entry._allMatchups) && entry._allMatchups.length > 0) {
        allMatchups = entry._allMatchups;
        break;
      }
    }
  }

  let html = "";
  if (allMatchups.length === 0) {
    // No games actually scheduled in core for this block
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
        // REGULAR / DISMISSAL / SNACKS / CUSTOM PINS / GENERATED / SPLIT
        const rawName = eventBlock.event || "";
        const nameLc = rawName.toLowerCase();

        const isDismissalBlock = nameLc.includes("dismiss");
        const isSnackBlock = nameLc.includes("snack");

        // GENERATED vs PIN logic:
        // 1) If the whole name matches a known generated type (Activity, Swim, etc.)
        // 2) OR if it's a combo like "Swim / Activity" where ANY part is generated
        let isGeneratedBlock = uiIsGeneratedEventName(rawName);
        if (!isGeneratedBlock && rawName.includes("/")) {
          const parts = rawName.split("/").map((s) => s.trim().toLowerCase());
          const anyGeneratedPart = parts.some((p) => UI_GENERATED_EVENTS.has(p));
          if (anyGeneratedPart) {
            isGeneratedBlock = true;
          }
        }

        // PIN = NOT dismissal, NOT snack, NOT generated
        const isPinBlock =
          !isGeneratedBlock && !isDismissalBlock && !isSnackBlock;

        bunks.forEach((bunk) => {
          const tdActivity = document.createElement("td");
          tdActivity.style.border = "1px solid #ccc";
          tdActivity.style.verticalAlign = "top";

          const startMin = eventBlock.startMin;
          const endMin = eventBlock.endMin;

          // This string is what will go into the prompt on click
          let cellActivityName = "";

          // Dismissal row
          if (isDismissalBlock) {
            cellActivityName = "Dismissal";
            tdActivity.textContent = cellActivityName;
            tdActivity.style.background = "#ffecec"; // light red/pink
            tdActivity.style.fontWeight = "bold";
          }
          // Snacks row
          else if (isSnackBlock) {
            cellActivityName = "Snacks";
            tdActivity.textContent = cellActivityName;
            tdActivity.style.background = "#e8f5e9"; // light green-ish
            tdActivity.style.fontWeight = "bold";
          }
          // Any other NON-GENERATED tile = PIN TILE
          // (Lunch, Regroup, Lineup, Cleanup, etc.)
          else if (isPinBlock) {
            cellActivityName = rawName || "Pinned";
            tdActivity.textContent = cellActivityName;
            tdActivity.style.background = "#fff8e1"; // light yellow for pins
            tdActivity.style.fontWeight = "bold";
          }
          // GENERATED SLOTS (Activity / Sports / Special Activity / Swim / Split)
          // -> show whatever the scheduler actually picked
          else {
            const slotIndex = findFirstSlotForTime(startMin);
            const entry = getEntry(bunk, slotIndex);

            if (entry) {
              cellActivityName = formatEntry(entry);
              if (entry._h2h) {
                tdActivity.style.background = "#e8f4ff";
                tdActivity.style.fontWeight = "bold";
              } else if (entry._fixed) {
                tdActivity.style.background = "#fff8e1"; // fixed/pinned
              }
            } else {
              // fallback so prompt isn't empty
              cellActivityName = rawName;
            }
            tdActivity.textContent = cellActivityName;
          }

          // Apply the click handler to ALL cells (pins + generated)
          tdActivity.style.cursor = "pointer";
          tdActivity.title = "Click to edit this activity";
          tdActivity.onclick = () =>
            editCell(bunk, startMin, endMin, cellActivityName);

          tr.appendChild(tdActivity);
        });
      }

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrapper.appendChild(table);
  });

  // Save league counters to today's data
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
      end: new Date(slot.end)
    }));
  } catch (e) {
    window.scheduleAssignments = {};
    window.leagueAssignments = {};
    window.unifiedTimes = [];
  }

  updateTable();
}

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
window.initScheduleSystem =
  window.initScheduleSystem || initScheduleSystem;
window.saveSchedule = window.saveSchedule || saveSchedule;
