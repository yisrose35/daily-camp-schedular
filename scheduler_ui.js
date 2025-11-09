// -------------------- scheduler_ui.js --------------------
// UI-only: rendering, save/load, init, and window exports.
//
// UPDATED:
// - Flipped the logic in updateTable() to match user's request.
//   - UNCHECKED (default) = "Fixed Block" (Agudah)
//   - CHECKED (opt-in) = "Staggered" (YKLI)
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
    
    // ===== START OF FIX: Flipped the logic =====
    if (toggle && toggle.checked) {
        // CHECKED = "Staggered" (YKLI) view
        renderStaggeredView(container);
    } else {
        // UNCHECKED (default) = "Fixed Block" (Agudah) view
        renderFixedBlockView(container);
    }
    // ===== END OF FIX =====
}

/**
 * Renders the "Staggered" (YKLI) view
 * This shows one column per bunk, with individual event rows.
 */
function renderStaggeredView(container) {
    container.innerHTML = "";

    const availableDivisions = window.availableDivisions || [];
    const divisions = window.divisions || {};
    const scheduleAssignments = window.scheduleAssignments || {};
    const unifiedTimes = window.unifiedTimes || [];
    
    if (unifiedTimes.length === 0) {
        container.innerHTML = "<p>No schedule built for this day. Go to the 'Master Scheduler' tab to build one.</p>";
        return;
    }

    const table = document.createElement("table");
    table.style.borderCollapse = "collapse";

    // --- 1. Build Header ---
    const thead = document.createElement("thead");
    const tr1 = document.createElement("tr");
    availableDivisions.forEach((div) => {
        const bunkCount = (divisions[div]?.bunks || []).length;
        const th = document.createElement("th");
        th.colSpan = bunkCount * 2; // Each bunk gets a Time + Activity column
        th.textContent = div;
        th.style.background = divisions[div]?.color || "#333";
        th.style.color = "#fff";
        tr1.appendChild(th);
    });
    thead.appendChild(tr1);

    const tr2 = document.createElement("tr");
    availableDivisions.forEach((div) => {
        (divisions[div]?.bunks || []).forEach((b) => {
            const thBunk = document.createElement("th");
            thBunk.textContent = b;
            thBunk.colSpan = 2;
            tr2.appendChild(thBunk);
        });
    });
    thead.appendChild(tr2);

    const tr3 = document.createElement("tr");
    availableDivisions.forEach((div) => {
        (divisions[div]?.bunks || []).forEach((b) => {
            const thTime = document.createElement("th");
            thTime.textContent = "Time";
            thTime.style.minWidth = "80px";
            tr3.appendChild(thTime);
            
            const thActivity = document.createElement("th");
            thActivity.textContent = "Activity";
            thActivity.style.minWidth = "120px";
            tr3.appendChild(thActivity);
        });
    });
    thead.appendChild(tr3);
    table.appendChild(thead);

    // --- 2. Build Body (Event-based) ---
    const tbody = document.createElement("tbody");
    
    // First, process all assignments into "real" events
    const eventsByBunk = {};
    let maxEvents = 0;
    
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
                    const endTime = unifiedTimes[i + span - 1].end;
                    
                    currentEvent = {
                        ...entry,
                        startTimeLabel: `${fmtTime(startTime)} - ${fmtTime(endTime)}`,
                        startMin: startTime.getHours() * 60 + startTime.getMinutes()
                    };
                    eventsByBunk[bunk].push(currentEvent);
                }
            });
            // Add empty slots
            if (eventsByBunk[bunk].length === 0) {
                 eventsByBunk[bunk].push({ startTimeLabel: "Full Day", _fixed: true, field: { name: "Free" } });
            }
            if (eventsByBunk[bunk].length > maxEvents) {
                maxEvents = eventsByBunk[bunk].length;
            }
        });
    });

    // Now render the rows
    for (let i = 0; i < maxEvents; i++) {
        const tr = document.createElement("tr");
        
        availableDivisions.forEach(div => {
            (divisions[div]?.bunks || []).forEach(bunk => {
                const event = eventsByBunk[bunk][i];
                
                const tdTime = document.createElement("td");
                const tdActivity = document.createElement("td");
                
                if (event) {
                    tdTime.textContent = event.startTimeLabel;
                    tdTime.style.border = "1px solid #ccc";
                    tdActivity.style.border = "1px solid #ccc";

                    if (event._h2h) {
                        tdActivity.textContent = `${event.sport} @ ${fieldLabel(event.field)}`;
                        tdActivity.style.background = "#e8f4ff";
                        tdActivity.style.fontWeight = "bold";
                    } else if (event._fixed) {
                        tdActivity.textContent = fieldLabel(event.field);
                        tdActivity.style.background = "#f1f1f1";
                    } else if (event.sport) {
                        tdActivity.textContent = `${fieldLabel(event.field)} – ${event.sport}`;
                    } else {
                        tdActivity.textContent = fieldLabel(event.field);
                    }
                } else {
                    // Empty cell for this bunk
                    tdTime.className = "grey-cell";
                    tdActivity.className = "grey-cell";
                    tdTime.style.border = "1px solid #ccc";
                    tdActivity.style.border = "1px solid #ccc";
                }
                tr.appendChild(tdTime);
                tr.appendChild(tdActivity);
            });
        });
        tbody.appendChild(tr);
    } 

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
