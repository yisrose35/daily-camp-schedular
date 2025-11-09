// -------------------- scheduler_ui.js --------------------
// UI-only: rendering, save/load, init, and window exports.
//
// UPDATED:
// - renderStaggeredView() (the "YKLI" view) is rewritten
//   to use 'position: absolute' just like the builder.
// - This allows events with custom times (11:20) to
//   "flow" correctly.
// -----------------------------------------------------------------

// ===== HELPERS =====
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
    let h = d.getHours(), m = d.getMinutes().toString().padStart(2,"0"), ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
    return `${h}:${m} ${ap}`;
}

// ===== NEW: Main updateTable function =====
// This function now just decides *which* renderer to use.
function updateTable() {
    const container = document.getElementById("scheduleTable");
    if (!container) return;
    
    const toggle = document.getElementById("schedule-view-toggle");
    
    // Flipped logic: Unchecked (default) is Fixed, Checked is Staggered
    if (toggle && toggle.checked) {
        renderStaggeredView(container);
    } else {
        renderFixedBlockView(container);
    }
}

/**
 * Renders the "Staggered" (YKLI) view
 * This is now rewritten to use absolute positioning.
 */
function renderStaggeredView(container) {
    container.innerHTML = "";

    const availableDivisions = window.availableDivisions || [];
    const divisions = window.divisions || {};
    const unifiedTimes = window.unifiedTimes || []; // The 30-min grid
    const scheduleAssignments = window.scheduleAssignments || {};
    
    if (unifiedTimes.length === 0) {
        container.innerHTML = "<p>No schedule built for this day. Go to the 'Master Scheduler' tab to build one.</p>";
        return;
    }
    
    const PIXELS_PER_MINUTE = 2;
    const INCREMENT_MINS = 30;
    const CELL_HEIGHT_PX = INCREMENT_MINS * PIXELS_PER_MINUTE; // 60px

    const table = document.createElement("table");
    table.style.borderCollapse = "collapse";
    table.style.width = "100%";

    // --- 1. Build Header ---
    const thead = document.createElement("thead");
    const tr1 = document.createElement("tr");
    const thTime = document.createElement("th");
    thTime.textContent = "Time";
    thTime.style.border = "1px solid #999";
    thTime.style.padding = "8px";
    tr1.appendChild(thTime);
    availableDivisions.forEach((div) => {
        const th = document.createElement("th");
        th.colSpan = (divisions[div]?.bunks || []).length;
        th.textContent = div;
        th.style.background = divisions[div]?.color || "#333";
        th.style.color = "#fff";
        th.style.border = "1px solid #999";
        tr1.appendChild(th);
    });
    thead.appendChild(tr1);

    const tr2 = document.createElement("tr");
    const bunkTh = document.createElement("th");
    bunkTh.textContent = "Bunk";
    bunkTh.style.border = "1px solid #999";
    bunkTh.style.padding = "8px";
    tr2.appendChild(bunkTh);
    availableDivisions.forEach((div) => {
        (divisions[div]?.bunks || []).forEach((b) => {
            const th = document.createElement("th");
            th.textContent = b;
            th.style.border = "1px solid #999";
            th.style.padding = "8px";
            tr2.appendChild(th);
        });
    });
    thead.appendChild(tr2);
    table.appendChild(thead);

    // --- 2. Build Body (Grid-Based) ---
    const tbody = document.createElement("tbody");
    
    // This map will hold all the *real* events, not just grid slots
    const eventsByBunk = {};
    const earliestMin = unifiedTimes[0].start.getHours() * 60 + unifiedTimes[0].start.getMinutes();
    
    availableDivisions.forEach(div => {
        (divisions[div]?.bunks || []).forEach(bunk => {
            eventsByBunk[bunk] = [];
            let currentEvent = null;
            (scheduleAssignments[bunk] || []).forEach((entry, i) => {
                if (entry && !entry.continuation) {
                    // This is the start of an event
                    let span = 1;
                    for (let j = i + 1; j < unifiedTimes.length; j++) {
                        if (scheduleAssignments[bunk]?.[j]?.continuation) span++;
                        else break;
                    }
                    
                    const startTime = unifiedTimes[i].start;
                    const endTime = (i + span - 1 < unifiedTimes.length) ? unifiedTimes[i + span - 1].end : unifiedTimes[unifiedTimes.length - 1].end;
                    
                    const startMin = startTime.getHours() * 60 + startTime.getMinutes();
                    const endMin = endTime.getHours() * 60 + endTime.getMinutes();
                    
                    currentEvent = {
                        ...entry,
                        startTimeLabel: `${fmtTime(startTime)} - ${fmtTime(endTime)}`,
                        top: (startMin - earliestMin) * PIXELS_PER_MINUTE,
                        height: (endMin - startMin) * PIXELS_PER_MINUTE
                    };
                    eventsByBunk[bunk].push(currentEvent);
                }
            });
        });
    });

    // Now render the "sightseeer" grid
    const totalMinutes = (unifiedTimes.length * 30);
    const totalHeight = totalMinutes * PIXELS_PER_MINUTE;
    
    // We need one master row for the *entire* schedule body
    const trBody = document.createElement("tr");
    
    // The Time Column
    const tdTimeCol = document.createElement("td");
    tdTimeCol.style.position = "relative";
    tdTimeCol.style.height = `${totalHeight}px`;
    tdTimeCol.style.border = "1px solid #ccc";
    for (let i = 0; i < unifiedTimes.length; i++) {
        const top = (i * 30) * PIXELS_PER_MINUTE;
        const line = document.createElement('div');
        line.style.cssText = `position: absolute; top: ${top}px; left: 0; width: 100%; height: ${CELL_HEIGHT_PX}px; border-bottom: 1px dashed #ddd; box-sizing: border-box; font-size: 10px; padding: 2px; color: #777;`;
        line.textContent = unifiedTimes[i].label.split(' - ')[0]; // Just show start time
        tdTimeCol.appendChild(line);
    }
    trBody.appendChild(tdTimeCol);
    
    // The Bunk Columns
    availableDivisions.forEach((div) => {
        (divisions[div]?.bunks || []).forEach((b) => {
            const td = document.createElement("td");
            td.style.position = "relative";
            td.style.height = `${totalHeight}px`;
            td.style.border = "1px solid #ccc";
            td.style.padding = "0";

            // Render all events for this bunk
            (eventsByBunk[b] || []).forEach(event => {
                let content = "";
                if (event._h2h) {
                    content = `${event.sport} @ ${fieldLabel(event.field)}`;
                } else if (event._fixed) {
                    content = fieldLabel(event.field);
                } else if (event.sport) {
                    content = `${fieldLabel(event.field)} – ${event.sport}`;
                } else {
                    content = fieldLabel(event.field);
                }
                
                const eventDiv = document.createElement('div');
                eventDiv.style.cssText = `
                    position: absolute;
                    top: ${event.top}px;
                    height: ${event.height}px;
                    width: calc(100% - 4px);
                    left: 2px;
                    padding: 2px 4px;
                    border-radius: 4px;
                    box-sizing: border-box;
                    overflow: hidden;
                    font-size: 0.9em;
                `;
                
                if (event._h2h) {
                    eventDiv.style.background = "#e8f4ff";
                    eventDiv.style.border = "1px solid #b3d4ff";
                    eventDiv.style.fontWeight = "bold";
                } else if (event._fixed) {
                    eventDiv.style.background = "#f1f1f1";
                    eventDiv.style.border = "1px solid #ddd";
                } else {
                     eventDiv.style.background = "#fff";
                     eventDiv.style.border = "1px solid #ccc";
                }
                
                eventDiv.textContent = content;
                td.appendChild(eventDiv);
            });
            
            trBody.appendChild(td);
        });
    });

    tbody.appendChild(trBody);
    table.appendChild(tbody);
    container.appendChild(table);
}

/**
 * Renders the "Fixed Block" (Agudah) view
 */
function renderFixedBlockView(container) {
    container.innerHTML = "";
    
    const availableDivisions = window.availableDivisions || [];
    const divisions = window.divisions || {};
    const scheduleAssignments = window.scheduleAssignments || {};
    
    // 1. Find all unique time blocks from the manual skeleton
    const dailyData = window.loadCurrentDailyData?.() || {};
    const manualSkeleton = dailyData.manualSkeleton || [];
    
    const blocks = [];
    manualSkeleton.forEach(item => {
        const label = `${item.startTime} - ${item.endTime}`;
        if (!blocks.find(b => b.label === label)) {
            blocks.push({
                label: label,
                startMin: parseTimeToMinutes(item.startTime)
            });
        }
    });
    blocks.sort((a,b) => a.startMin - b.startMin);
    
    if (blocks.length === 0) {
        container.innerHTML = "<p>No schedule built for this day. Go to the 'Master Scheduler' tab to build one.</p>";
        return;
    }

    const table = document.createElement("table");
    
    // --- 1. Build Header ---
    const thead = document.createElement("thead");
    const tr1 = document.createElement("tr");
    const thTime = document.createElement("th");
    thTime.textContent = "Time";
    tr1.appendChild(thTime);
    availableDivisions.forEach((div) => {
        const th = document.createElement("th");
        th.textContent = div;
        th.style.background = divisions[div]?.color || "#333";
        th.style.color = "#fff";
        tr1.appendChild(th);
    });
    thead.appendChild(tr1);
    table.appendChild(thead);
    
    // --- 2. Build Body ---
    const tbody = document.createElement("tbody");
    
    blocks.forEach(block => {
        const tr = document.createElement("tr");
        
        const tdTime = document.createElement("td");
        tdTime.textContent = block.label;
        tr.appendChild(tdTime);
        
        availableDivisions.forEach(div => {
            const bunks = divisions[div]?.bunks || [];
            const td = document.createElement("td");
            td.style.verticalAlign = "top";
            
            // Find what the *first bunk* of this division is doing
            const firstBunk = bunks[0];
            let entry = null;
            if (firstBunk) {
                 const slots = findSlotsForRange(parseTimeToMinutes(block.label.split(' - ')[0]), parseTimeToMinutes(block.label.split(' - ')[1]));
                 if (slots.length > 0) {
                     entry = scheduleAssignments[firstBunk]?.[slots[0]];
                 }
            }
            
            if (entry) {
                if (entry._h2h) { // Handle Leagues/H2H
                     td.textContent = `${entry.sport} @ ${fieldLabel(entry.field)}`;
                     td.style.background = "#e8f4ff";
                } else if (entry._fixed) {
                     td.textContent = fieldLabel(entry.field);
                     td.style.background = "#f1f1f1";
                } else if (entry.sport) {
                    td.textContent = `${fieldLabel(entry.field)} – ${entry.sport}`;
                } else {
                    td.textContent = fieldLabel(entry.field);
                }
            } else {
                td.className = "grey-cell";
            }
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
    
    table.appendChild(tbody);
    container.appendChild(table);
}

// Helper to find slots (needed by Fixed Block view)
function findSlotsForRange(startMin, endMin) {
    const slots = [];
    if (!window.unifiedTimes) return slots;
    
    for (let i = 0; i < window.unifiedTimes.length; i++) {
        const slot = window.unifiedTimes[i];
        const slotStart = slot.start.getHours() * 60 + slot.start.getMinutes();
        
        if (slotStart >= startMin && slotStart < endMin) {
            slots.push(i);
        }
    }
    return slots;
}


// ===== Save/Load/Init =====

function saveSchedule() {
    try {
        window.saveCurrentDailyData?.("scheduleAssignments", window.scheduleAssignments);
        window.saveCurrentDailyData?.("leagueAssignments", window.leagueAssignments);
        window.saveCurrentDailyData?.("unifiedTimes", window.unifiedTimes); // Save the grid!
    } catch (e) {
        console.error("Save schedule failed:", e);
    }
}

function reconcileOrRenderSaved() {
    try {
        const data = window.loadCurrentDailyData?.() || {};
        window.scheduleAssignments = data.scheduleAssignments || {};
        window.leagueAssignments = data.leagueAssignments || {};
        // We also must load window.unifiedTimes if it was saved!
        window.unifiedTimes = data.unifiedTimes || []; 
    } catch (e) {
        console.error("Reconcile saved failed:", e);
        window.scheduleAssignments = {};
        window.leagueAssignments = {};
        window.unifiedTimes = [];
    }
    
    updateTable(); // This will now call the correct renderer
}

function initScheduleSystem() {
    try {
        window.scheduleAssignments = window.scheduleAssignments || {};
        window.leagueAssignments = window.leagueAssignments || {};
        reconcileOrRenderSaved();
        
        // Add listener for the new toggle
        const toggle = document.getElementById("schedule-view-toggle");
        if (toggle) {
            toggle.onchange = () => {
                updateTable();
            };
        }
        
    } catch (e) {
        console.error("Init error:", e);
        updateTable();
    }
}

// ===== Exports =====
window.updateTable = window.updateTable || updateTable;
window.initScheduleSystem = window.initScheduleSystem || initScheduleSystem;
window.saveSchedule = window.saveSchedule || saveSchedule;
