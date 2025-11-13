// -------------------- scheduler_ui.js --------------------
//
// --- YOUR LATEST REQUEST (Fixing the reset) ---
// - RE-IMPLEMENTED: Load league counters from the previous day.
// - Counters now increment sequentially based on the previous day's total.
// - Example: If yesterday's total was 2, today's games will be
//   "League Game 3" and "League Game 4".
// - The new total count is saved to *today's* data.
//
// --- NEW FIX (Closest Slot) ---
// - findFirstSlotForTime now finds the 30-minute slot that is
//   *closest* to the block's start time, preventing off-by-one bugs.
// -----------------------------------------------------------------

(function() {
  'use strict';

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
      if (hh === 12) {
        hh = (mer === "am") ? 0 : 12; // 12am -> 0, 12pm -> 12
      } else if (mer === "pm") {
        hh += 12; // 1pm -> 13, etc
      }
    } else {
      // We require AM/PM to avoid ambiguity
      return null;
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
   * Converts minutes (e.g., 740) to a 12-hour string (e.g., "12:20 PM").
   */
  function minutesToTimeLabel(min) {
    if (min == null || Number.isNaN(min)) return "Invalid Time";
    let h = Math.floor(min / 60);
    const m = (min % 60).toString().padStart(2, "0");
    const ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${m} ${ap}`;
  }

  // ===== CORE SCHEDULE HELPERS =====

  /**
   * Main hook: Re-render the schedule table in the "staggered view".
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
    if (entry._h2h) {
      return `${entry.sport} @ ${fieldLabel(entry.field)}`;
    } else if (entry._fixed) {
      return fieldLabel(entry.field);
    } else if (entry.sport) {
      return `${fieldLabel(entry.field)} – ${entry.sport}`;
    } else {
      return fieldLabel(entry.field);
    }
  }

  /**
   * Finds the 30-min optimizer slot index that is *closest*
   * to the custom template block's start time.
   */
  function findFirstSlotForTime(startMin) {
    if (
      startMin === null ||
      !window.unifiedTimes ||
      window.unifiedTimes.length === 0
    ) {
      return -1;
    }

    let closestIndex = -1;
    let minDiff = Infinity;

    for (let i = 0; i < window.unifiedTimes.length; i++) {
      const slot = window.unifiedTimes[i];
      const slotStartDate = new Date(slot.start);
      const slotStart =
        slotStartDate.getHours() * 60 + slotStartDate.getMinutes();

      const diff = Math.abs(slotStart - startMin);
      if (diff < minDiff) {
        minDiff = diff;
        closestIndex = i;
      }
    }

    return closestIndex;
  }

  // ===== MAIN RENDERER: STAGGERED VIEW =====

  /**
   * Renders the "Staggered" (YKLI) view
   * --- One table PER DIVISION ---
   * --- Uses persistent game counters across days ---
   */
  function renderStaggeredView(container) {
    container.innerHTML = "";

    const availableDivisions = window.availableDivisions || [];
    const divisions = window.divisions || {};
    const scheduleAssignments = window.scheduleAssignments || {};

    const dailyData = window.loadCurrentDailyData?.() || {};
    const manualSkeleton = dailyData.manualSkeleton || [];

    // Load previous day's counters
    const prevDailyData = window.loadPreviousDailyData?.() || {};
    const prevCounters = prevDailyData.leagueDayCounters || {};
    const todayCounters = {}; // will be saved at the end

    if (manualSkeleton.length === 0) {
      container.innerHTML =
        "<p>No schedule built for this day. Go to the 'Daily Adjustments' tab to build one.</p>";
      return;
    }

    // Wrapper to hold all division tables side-by-side
    const wrapper = document.createElement("div");
    wrapper.className = "schedule-view-wrapper";
    container.appendChild(wrapper);

    // Loop over each division and create a separate table
    availableDivisions.forEach((div) => {
      const bunks = (divisions[div]?.bunks || []).slice().sort();
      if (bunks.length === 0) return; // No bunks -> skip

      const table = document.createElement("table");
      table.className = "schedule-division-table";
      table.style.borderCollapse = "collapse";

      // ----- HEADER -----
      const thead = document.createElement("thead");
      const tr1 = document.createElement("tr"); // Division name
      const tr2 = document.createElement("tr"); // Time + bunk columns

      const thDiv = document.createElement("th");
      thDiv.colSpan = 1 + bunks.length; // Time + bunks
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

      // ----- BODY -----
      const tbody = document.createElement("tbody");

      // Pre-filter, validate, and sort blocks
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

      // Sort by start time so counters increment in order
      tempSortedBlocks.sort((a, b) => a.startMin - b.startMin);

      // Build blocks with counters
      const prevDivCounts = prevCounters[div] || { league: 0, specialty: 0 };
      let todayLeagueCount = prevDivCounts.league;
      let todaySpecialtyCount = prevDivCounts.specialty;

      const divisionBlocks = [];

      tempSortedBlocks.forEach((block) => {
        const { item, startMin, endMin } = block;
        let eventName = item.event;

        if (item.event === "League Game") {
          todayLeagueCount += 1;
          eventName = `League Game ${todayLeagueCount}`;
        } else if (item.event === "Specialty League") {
          todaySpecialtyCount += 1;
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

      // Store updated counters for this division
      todayCounters[div] = {
        league: todayLeagueCount,
        specialty: todaySpecialtyCount
      };

      // Remove duplicates by label
      const uniqueBlocks = divisionBlocks.filter(
        (block, index, self) =>
          index === self.findIndex((t) => t.label === block.label)
      );

      // Flatten split blocks into two halves
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

      // Render each event block as a row
      flattenedBlocks.forEach((eventBlock) => {
        const tr = document.createElement("tr");

        // Time cell
        const tdTime = document.createElement("td");
        tdTime.style.border = "1px solid #ccc";
        tdTime.style.verticalAlign = "top";
        tdTime.style.fontWeight = "bold";
        tdTime.textContent = eventBlock.label;
        tr.appendChild(tdTime);

        // League / Specialty League rows use a merged cell
        if (
          eventBlock.event.startsWith("League Game") ||
          eventBlock.event.startsWith("Specialty League")
        ) {
          const tdLeague = document.createElement("td");
          tdLeague.colSpan = bunks.length;
          tdLeague.style.verticalAlign = "top";
          tdLeague.style.textAlign = "left";
          tdLeague.style.padding = "5px 8px";
          tdLeague.style.background = "#f0f8f0";

          const firstSlotIndex = findFirstSlotForTime(eventBlock.startMin);

          if (eventBlock.event.startsWith("Specialty League")) {
            // Specialty League: group by field
            const gamesByField = new Map();
            if (firstSlotIndex !== -1) {
              const uniqueMatchups = new Set();
              bunks.forEach((bunk) => {
                const entry = getEntry(bunk, firstSlotIndex);
                if (entry && entry._h2h && entry.sport) {
                  if (!uniqueMatchups.has(entry.sport)) {
                    uniqueMatchups.add(entry.sport);
                    const field = fieldLabel(entry.field);
                    if (!gamesByField.has(field)) {
                      gamesByField.set(field, []);
                    }
                    gamesByField.get(field).push(entry.sport);
                  }
                }
              });
            }

            let html = "";
            if (gamesByField.size === 0) {
              html = `<p class="muted" style="margin:0; padding: 4px;">${eventBlock.event}</p>`;
            } else {
              html = `<p style="margin:2px 0 5px 4px; font-weight: bold;">${eventBlock.event}</p>`;
              gamesByField.forEach((matchups, field) => {
                const matchupNames = matchups.map((m) =>
                  m.substring(0, m.lastIndexOf("(")).trim()
                );
                html += `<div style="margin-bottom: 2px; padding-left: 4px;">
                           <strong>${matchupNames.join(", ")}</strong> - ${field}
                         </div>`;
              });
            }
            tdLeague.innerHTML = html;
          } else {
            // Regular League games: simple list of matchups
            const games = new Map();
            if (firstSlotIndex !== -1) {
              bunks.forEach((bunk) => {
                const entry = getEntry(bunk, firstSlotIndex);
                if (entry && entry._h2h && entry.sport) {
                  games.set(entry.sport, fieldLabel(entry.field));
                }
              });
            }

            let html = "";
            if (games.size === 0) {
              html = `<p class="muted" style="margin:0; padding: 4px;">${eventBlock.event}</p>`;
            } else {
              html = `<p style="margin:2px 0 5px 4px; font-weight: bold;">${eventBlock.event}</p>`;
              html += '<ul style="margin: 0; padding-left: 18px;">';
              games.forEach((field, matchup) => {
                html += `<li>${matchup} @ ${field}</li>`;
              });
              html += "</ul>";
            }
            tdLeague.innerHTML = html;
          }

          tr.appendChild(tdLeague);
        } else {
          // Regular / split activity rows: one cell per bunk
          const slotIndex = findFirstSlotForTime(eventBlock.startMin);

          bunks.forEach((bunk) => {
            const tdActivity = document.createElement("td");
            tdActivity.style.border = "1px solid #ccc";
            tdActivity.style.verticalAlign = "top";

            const entry = getEntry(bunk, slotIndex);
            if (entry) {
              tdActivity.textContent = formatEntry(entry);
              if (entry._h2h) {
                tdActivity.style.background = "#e8f4ff";
                tdActivity.style.fontWeight = "bold";
              } else if (entry._fixed) {
                tdActivity.style.background = "#f1f1f1";
              }
            }

            tr.appendChild(tdActivity);
          });
        }

        tbody.appendChild(tr);
      });

      table.appendChild(tbody);
      wrapper.appendChild(table);
    }); // end divisions loop

    // Save the new counters to today's data
    window.saveCurrentDailyData?.("leagueDayCounters", todayCounters);
  }

  // ===== SAVE / LOAD / INIT =====

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
      // If saving fails, silently ignore (localStorage / quota / etc.)
      // console.error("saveSchedule failed", e);
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

    updateTable(); // now calls the staggered renderer
  }

  function initScheduleSystem() {
    try {
      window.scheduleAssignments = window.scheduleAssignments || {};
      window.leagueAssignments = window.leagueAssignments || {};
      reconcileOrRenderSaved();
    } catch (e) {
      // Fallback: at least try to draw an empty table
      updateTable();
    }
  }

  // ===== EXPORTS =====
  // Attach to window so your HTML can call these.
  window.updateTable = updateTable;
  window.initScheduleSystem = initScheduleSystem;
  window.saveSchedule = saveSchedule;

})(); // <-- Properly closes the IIFE
