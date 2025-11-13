// -------------------- scheduler_ui.js --------------------
//
// ... (previous changelog) ...
//
// --- YOUR LATEST REQUEST (Fixing the reset) ---
// - **RE-IMPLEMENTED:** The logic to load counters from the
//   *previous day* is back.
// - **FIXED:** The logic now correctly increments the counter
//   sequentially *based on the previous day's total*.
// - **EXAMPLE:** If yesterday's total was 2, today's games will
//   be "League Game 3" and "League Game 4".
// - **FIXED:** The new total count (e.g., 4) is now correctly
//   saved to the *current day's* data.
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
      if (typeof d === 'string') {
          d = new Date(d);
      }
      let h = d.getHours(),
          m = d.getMinutes().toString().padStart(2,"0"),
          ap = h >= 12 ? "PM" : "AM";
      h = h % 12 || 12;
      return `${h}:${m} ${ap}`;
  }

  /**
   * NEW Helper: Converts minutes (e.g., 740) to a 12-hour string (e.g., "12:20 PM")
   */
  function minutesToTimeLabel(min) {
      if (min == null || Number.isNaN(min)) return "Invalid Time"; // <-- SAFETY CHECK
      let h = Math.floor(min / 60);
      const m = (min % 60).toString().padStart(2, '0');
      const ap = h >= 12 ? "PM" : "AM";
      h = h % 12 || 12;
      return `${h}:${m} ${ap}`;
  }


  // ===== NEW: Main updateTable function =====
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
   * --- THIS IS THE FIX ---
   * Finds the *first* 30-min slot index
   * that *contains* the start time of a custom block.
   */
  function findFirstSlotForTime(startMin) {
      if (startMin === null || !window.unifiedTimes) return -1; // <-- SAFETY CHECK
      for (let i = 0; i < window.unifiedTimes.length; i++) {
          const slot = window.unifiedTimes[i];
          const slotStart = new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes();
          
          // Use the globally defined constant
          const slotEnd = slotStart + (window.INCREMENT_MINS || 30);
          
          // Correct "contains" check: (slotStart <= startMin < slotEnd)
          if (slotStart <= startMin && slotEnd > startMin) {
              return i;
          }
      }
      return -1;
  }
  // --- END FIX ---


  /**
   * Renders the "Staggered" (YKLI) view
   * --- REWRITTEN to be one table PER DIVISION ---
   * --- **UPDATED WITH PERSISTENT GAME COUNTER** ---
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
          container.innerHTML = "<p>No schedule built for this day. Go to the 'Daily Adjustments' tab to build one.</p>";
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
          thDiv.textContent = div; // <-- REVERTED: No counter here
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
          
          // --- NEW: Pre-filter, validate, and sort blocks FIRST ---
          const tempSortedBlocks = [];
          manualSkeleton.forEach(item => {
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
          tempSortedBlocks.sort((a,b) => a.startMin - b.startMin);

          // --- NEW: Build final blocks WITH counters ---
          // Get the *starting* counts from the previous day
          const prevDivCounts = prevCounters[div] || { league: 0, specialty: 0 };
          let todayLeagueCount = prevDivCounts.league; // This is now the running total
          let todaySpecialtyCount = prevDivCounts.specialty; // Running total
          
          const divisionBlocks = [];
          
          tempSortedBlocks.forEach(block => {
              const { item, startMin, endMin } = block;
              
              let eventName = item.event;
              if (item.event === 'League Game') {
                  todayLeagueCount++; // Increment the running total
                  eventName = `League Game ${todayLeagueCount}`; // Assign the new total
              } else if (item.event === 'Specialty League') {
                  // --- THIS IS THE SYNTAX FIX ---
                  todaySpecialtyCount++; // Increment the running total
                  // --- END FIX ---
                  eventName = `Specialty League ${todaySpecialtyCount}`; // Assign the new total
              }
              
              divisionBlocks.push({
                  label: `${minutesToTimeLabel(startMin)} - ${minutesToTimeLabel(endMin)}`,
                  startMin: startMin,
                  endMin: endMin,
                  event: eventName, // Use the new name
                  type: item.type 
              });
          });

          // Store the *final* new counts to be saved
          todayCounters[div] = { 
              league: todayLeagueCount, 
              specialty: todaySpecialtyCount 
          };
          // --- END NEW LOGIC ---
          
          const uniqueBlocks = divisionBlocks.filter((block, index, self) =>
              index === self.findIndex((t) => (t.label === block.label))
          );

          // --- "Flatten" split blocks into two half-blocks ---
          const flattenedBlocks = [];
          uniqueBlocks.forEach(block => {
              if (block.type === 'split' && block.startMin !== null && block.endMin !== null) {
                  const midMin = Math.round(block.startMin + (block.endMin - block.startMin) / 2);
                  
                  // First half
                  flattenedBlocks.push({
                      ...block,
                      label: `${minutesToTimeLabel(block.startMin)} - ${minutesToTimeLabel(midMin)}`,
                      startMin: block.startMin,
                      endMin: midMin,
                      splitPart: 1
                  });
                  // Second half
                  flattenedBlocks.push({
                      ...block,
                      label: `${minutesToTimeLabel(midMin)} - ${minutesToTimeLabel(block.endMin)}`,
                      startMin: midMin,
                      endMin: block.endMin,
                      splitPart: 2
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
              td.textContent = "No schedule blocks found for this division in the template.";
              td.className = "grey-cell";
              tr.appendChild(td);
              tbody.appendChild(tr);
          }

          flattenedBlocks.forEach(eventBlock => {
              const tr = document.createElement("tr");
              
              // --- Add the TIME cell ---
              const tdTime = document.createElement("td");
              tdTime.style.border = "1px solid #ccc";
              tdTime.style.verticalAlign = "top";
              tdTime.style.fontWeight = "bold";
              tdTime.textContent = eventBlock.label;
              tr.appendChild(tdTime);

              // --- Add ACTIVITY cells (Merged or Individual) ---
              if (eventBlock.event.startsWith('League Game') || eventBlock.event.startsWith('Specialty League')) {
                  // === LEAGUE GAME / SPECIALTY LEAGUE: MERGED CELL ===
                  const tdLeague = document.createElement("td");
                  tdLeague.colSpan = bunks.length;
                  tdLeague.style.verticalAlign = "top";
                  tdLeague.style.textAlign = "left";
                  tdLeague.style.padding = "5px 8px";
                  tdLeague.style.background = "#f0f8f0"; // Light green
                  
                  const firstSlotIndex = findFirstSlotForTime(eventBlock.startMin);
                  
                  if (eventBlock.event.startsWith('Specialty League')) {
                      // Specialty League Formatting (Group by Field)
                      const gamesByField = new Map();
                      if (firstSlotIndex !== -1) {
                          const uniqueMatchups = new Set();
                          bunks.forEach(bunk => {
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

                      let html = '';
                      if (gamesByField.size === 0) {
                          html = `<p class="muted" style="margin:0; padding: 4px;">${eventBlock.event}</p>`;
                      } else {
                          html = `<p style="margin:2px 0 5px 4px; font-weight: bold;">${eventBlock.event}</p>`;
                          gamesByField.forEach((matchups, field) => {
                              const matchupNames = matchups.map(m => m.substring(0, m.lastIndexOf('(')).trim());
                              html += `<div style="margin-bottom: 2px; padding-left: 4px;">
                                          <strong>${matchupNames.join(', ')}</strong> - ${field}
                                       </div>`;
                          });
                      }
                      tdLeague.innerHTML = html;

                  } else {
                      // Regular League Formatting (List)
                      let games = new Map();
                      if (firstSlotIndex !== -1) {
                          bunks.forEach(bunk => {
                              const entry = getEntry(bunk, firstSlotIndex);
                              if (entry && entry._h2h && entry.sport) {
                                  games.set(entry.sport, fieldLabel(entry.field));
                              }
                          });
                      }
                      
                      let html = '';
                      if (games.size === 0) {
                          html = `<p class="muted" style="margin:0; padding: 4px;">${eventBlock.event}</p>`;
                      } else {
                          html = `<p style="margin:2px 0 5px 4px; font-weight: bold;">${eventBlock.event}</p>`;
                          html += '<ul style="margin: 0; padding-left: 18px;">';
                          games.forEach((field, matchup) => {
                              html += `<li>${matchup} @ ${field}</li>`;
                          });
                          html += '</ul>';
                      }
                      tdLeague.innerHTML = html;
                  }
                  tr.appendChild(tdLeague);

              } else {
                  // === REGULAR GAME / SPLIT GAME: INDIVIDUAL CELLS ===
                  bunks.forEach(bunk => {
                      const tdActivity = document.createElement("td");
                      tdActivity.style.border = "1px solid #ccc";
                      tdActivity.style.verticalAlign = "top";
                      
                      const slotIndex = findFirstSlotForTime(eventBlock.startMin);
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
          wrapper.appendChild(table); // Add table to wrapper
      }); // --- End of main division loop ---
      
      // --- NEW: Save the new counters to today's data ---
      window.saveCurrentDailyData?.("leagueDayCounters", todayCounters);
  }


  // ===== Save/Load/Init =====

  function saveSchedule() {
      try {
          window.saveCurrentDailyData?.("scheduleAssignments", window.scheduleAssignments);
          window.saveCurrentDailyData?.("leagueAssignments", window.leagueAssignments);
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
          window.unifiedTimes = savedTimes.map(slot => ({
              ...slot,
              start: new Date(slot.start),
              end: new Date(slot.end)
          }));

      } catch (e) {
          window.scheduleAssignments = {};
          window.leagueAssignments = {};
          window.unifiedTimes = [];
      }
      
      updateTable(); // This will now call the correct renderer
  }

  /**
   * UPDATED: This function no longer looks for the toggle.
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

})(); // <-- proper IIFE close
