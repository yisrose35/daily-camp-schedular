// -------------------- scheduler_ui.js --------------------
// UI-only: rendering, save/load, init, and window exports.
//
// UPDATED:
// - *** CRITICAL FIX ***
//   - `reconcileOrRenderSaved` now "re-hydrates" date strings
//     from localStorage back into real Date objects.
//   - This fixes the "slot.start.getHours is not a function" crash.
// - updateTable() correctly switches between "Fixed" and "Staggered"
// - `renderStaggeredView` (NEW UPDATE):
//   - Now shows one "Time" column per division, not per bunk.
//   - Builds the event list from the `manualSkeleton` to show
//     custom time blocks (e.g., "11:00-11:20", "11:20-12:00").
// -----------------------------------------------------------------

// ===== HELPERS =====
function parseTimeToMinutes(str) {
    if (!str || typeof str !== "string") return null;
    let s = s.trim().toLowerCase();
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
    // Check if it's a string, convert it to Date
    if (typeof d === 'string') {
        d = new Date(d);
    }
    let h = d.getHours(), m = d.getMinutes().toString().padStart(2,"0"), ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
    return `${h}:${m} ${ap}`;
}

// Helper to find slots (needed by both Fixed and Staggered views)
function findSlotsForRange(startMin, endMin) {
    const slots = [];
    if (!window.unifiedTimes) return slots;
    
    for (let i = 0; i < window.unifiedTimes.length; i++) {
        const slot = window.unifiedTimes[i];
        // FIX: Ensure slot.start is a Date object before calling getHours
        const slotStart = new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes();
        
        if (slotStart >= startMin && slotStart < endMin) {
            slots.push(i);
        }
    }
    return slots;
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
 * This shows one column per bunk, with individual event rows.
 *
 * UPDATED:
 * - Header now shows one "Time" column per *division*.
 * - Body rows are built from the `manualSkeleton` for each division,
 * not from the `unifiedTimes` grid.
 */
function renderStaggeredView(container) {
    container.innerHTML = "";

    const availableDivisions = window.availableDivisions || [];
    const divisions = window.divisions || {};
    const scheduleAssignments = window.scheduleAssignments || {};

    // Load the manual skeleton to get the *actual* time blocks
    const dailyData = window.loadCurrentDailyData?.() || {};
    const manualSkeleton = dailyData.manualSkeleton || [];
    
    if (manualSkeleton.length === 0) {
        container.innerHTML = "<p>No schedule built for this day. Go to the 'Master Scheduler' tab to build one.</p>";
        return;
    }

    const table = document.createElement("table");
    table.style.borderCollapse = "collapse";
    table.style.width = "100%";

    // --- 1. Build Header ---
    const thead = document.createElement("thead");
    const tr1 = document.createElement("tr"); // Division names
    const tr2 = document.createElement("tr"); // Column titles (Time, Bunk 1, Bunk 2...)

    availableDivisions.forEach((div) => {
        const bunks = divisions[div]?.bunks || [];
        const bunkCount = bunks.length;
        if (bunkCount === 0) return;

        // Row 1: Division Name
        const thDiv = document.createElement("th");
        thDiv.colSpan = 1 + bunkCount; // 1 for Time, N for bunks
        thDiv.textContent = div;
        thDiv.style.background = divisions[div]?.color || "#333";
        thDiv.style.color = "#fff";
        thDiv.style.border = "1px solid #999";
        tr1.appendChild(thDiv);

        // Row 2: "Time" column for this division
        const thTime = document.createElement("th");
        thTime.textContent = "Time";
        thTime.style.minWidth = "100px";
        thTime.style.border = "1px solid #999";
        tr2.appendChild(thTime);
        
        // Row 2: Bunk Names
        bunks.forEach((b) => {
            const thBunk = document.createElement("th");
            thBunk.textContent = b;
            thBunk.style.border = "1px solid #999";
            thBunk.style.minWidth = "120px";
            tr2.appendChild(thBunk);
        });
    });
    thead.appendChild(tr1);
    thead.appendChild(tr2);
    table.appendChild(thead);

    // --- 2. Build Body (Event-based) ---
    const tbody = document.createElement("tbody");
    
    // Find all unique, sorted blocks *per division*
    const blocksByDivision = {};
    let maxEvents = 0; // The max number of blocks in *any* division
    
    availableDivisions.forEach(div => {
        const divBlocks = [];
        manualSkeleton.forEach(item => {
            if (item.division === div) {
                divBlocks.push({
                    label: `${item.startTime} - ${item.endTime}`,
                    startMin: parseTimeToMinutes(item.startTime),
                    endMin: parseTimeToMinutes(item.endTime),
                });
            }
        });
        
        // Sort and Deduplicate
        divBlocks.sort((a,b) => a.startMin - b.startMin);
        blocksByDivision[div] = divBlocks.filter((block, index, self) =>
            index === self.findIndex((t) => (t.label === block.label))
        );
        
        if (blocksByDivision[div].length > maxEvents) {
            maxEvents = blocksByDivision[div].length;
        }
    });

    // Now render the rows, one for each "event index"
    for (let i = 0; i < maxEvents; i++) {
        const tr = document.createElement("tr");
        
        availableDivisions.forEach(div => {
            const bunks = divisions[div]?.bunks || [];
            const blocks = blocksByDivision[div] || [];
            const eventBlock = blocks[i]; // Get the i-th event block for this division
            
            // --- 1. Add the TIME cell for this division ---
            const tdTime = document.createElement("td");
            if (eventBlock) {
                tdTime.textContent = eventBlock.label;
                tdTime.style.border = "1px solid #ccc";
                tdTime.style.verticalAlign = "top";
            } else {
                // This division has fewer events than maxEvents
                tdTime.className = "grey-cell";
                tdTime.style.border = "1px solid #ccc";
            }
            tr.appendChild(tdTime);

            // --- 2. Add the ACTIVITY cells for each BUNK ---
            bunks.forEach(bunk => {
                const tdActivity = document.createElement("td");
                let entry = null;

                if (eventBlock) {
                    // Find the activity for this bunk at this block's time
                    // We look at the *first slot* that matches the block's start time
                    const slots = findSlotsForRange(eventBlock.startMin, eventBlock.endMin);
                    if (slots.length > 0) {
                        entry = scheduleAssignments[bunk]?.[slots[0]];
                    }
                }
                
                if (entry) {
                    tdActivity.style.border = "1px solid #ccc";
                    tdActivity.style.verticalAlign = "top";

                    if (entry._h2h) {
                        tdActivity.textContent = `${entry.sport} @ ${fieldLabel(entry.field)}`;
                        tdActivity.style.background = "#e8f4ff";
                        tdActivity.style.fontWeight = "bold";
                    } else if (entry._fixed) {
                        tdActivity.textContent = fieldLabel(entry.field);
                        tdActivity.style.background = "#f1f1f1";
                    } else if (entry.sport) {
                        tdActivity.textContent = `${fieldLabel(entry.field)} – ${entry.sport}`;
                    } else {
                        tdActivity.textContent = fieldLabel(entry.field);
                    }
                } else {
                    // No event for this bunk (or no eventBlock for this division)
                    tdActivity.className = "grey-cell";
                    tdActivity.style.border = "1px solid #ccc";
                }
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
        
        // ===== START OF CRITICAL FIX =====
        // Re-hydrate date strings from JSON back into Date objects
        const savedTimes = data.unifiedTimes || [];
        window.unifiedTimes = savedTimes.map(slot => ({
            ...slot,
            start: new Date(slot.start),
            end: new Date(slot.end)
        }));
        // ===== END OF CRITICAL FIX =====

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
