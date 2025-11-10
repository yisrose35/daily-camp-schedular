// -------------------- scheduler_ui.js --------------------
// UI-only: rendering, save/load, init, and window exports.
//
// UPDATED:
// - *** CRITICAL FIX (Split Activity) ***
//   - `renderFixedBlockView` has been rewritten to fix the
//     "blank row" bug.
//   - It no longer skips the entire `<tr>` (row) if the
//     first division is continuing.
//   - Instead, it checks continuation *per-cell* (one for
//     the Time column, and one for each Division).
//   - This allows it to correctly render split activities
//     (e.g., one 1-hour block next to two 30-min blocks)
//     without creating blank rows.
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
    if (typeof d === 'string') {
        d = new Date(d);
    }
    let h = d.getHours(), m = d.getMinutes().toString().padStart(2,"0"), ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
    return `${h}:${m} ${ap}`;
}

// ===== NEW: Main updateTable function =====
function updateTable() {
    const container = document.getElementById("scheduleTable");
    if (!container) return;
    
    const toggle = document.getElementById("schedule-view-toggle");
    
    if (toggle && toggle.checked) {
        renderStaggeredView(container);
    } else {
        renderFixedBlockView(container);
    }
}

/**
 * NEW: Helper function to get the schedule entry for a slot.
 */
function getEntry(bunk, slotIndex) {
    const assignments = window.scheduleAssignments || {};
    if (bunk && assignments[bunk] && assignments[bunk][slotIndex]) {
        return assignments[bunk][slotIndex];
    }
    return null; // Return null if empty or bunk is invalid
}

/**
 * NEW: Helper to calculate rowspan for a given bunk/slot.
 */
function calculateRowspan(bunk, slotIndex) {
    let rowspan = 1;
    if (!bunk) return 1; // Failsafe
    const firstEntry = getEntry(bunk, slotIndex);
    if (!firstEntry || !window.unifiedTimes) return 1;

    for (let i = slotIndex + 1; i < window.unifiedTimes.length; i++) {
        const nextEntry = getEntry(bunk, i);
        if (nextEntry && nextEntry.continuation && nextEntry.field === firstEntry.field) {
            rowspan++;
        } else {
            break;
        }
    }
    return rowspan;
}

/**
 * NEW: Helper to format a schedule entry into text.
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
 * Renders the "Staggered" (YKLI) view
 * REWRITTEN to iterate `unifiedTimes` and support `rowspan`.
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
    table.style.width = "100%";

    // --- 1. Build Header ---
    const thead = document.createElement("thead");
    const tr1 = document.createElement("tr"); // Division names
    const tr2 = document.createElement("tr"); // Column titles (Time, Bunk 1, Bunk 2...)

    availableDivisions.forEach((div) => {
        const bunks = divisions[div]?.bunks || [];
        const bunkCount = bunks.length;
        if (bunkCount === 0) return;

        const thDiv = document.createElement("th");
        thDiv.colSpan = 1 + bunkCount; // 1 for Time, N for bunks
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
    });
    thead.appendChild(tr1);
    thead.appendChild(tr2);
    table.appendChild(thead);

    // --- 2. Build Body (Slot-based) ---
    const tbody = document.createElement("tbody");

    for (let i = 0; i < unifiedTimes.length; i++) {
        const slot = unifiedTimes[i];
        const tr = document.createElement("tr");
        
        availableDivisions.forEach((div, divIndex) => {
            const bunks = divisions[div]?.bunks || [];
            
            // --- 1. Add the TIME cell (only for the first division) ---
            if (divIndex === 0) {
                const firstBunk = divisions[availableDivisions[0]]?.bunks?.[0];
                const entry = getEntry(firstBunk, i);
                
                if (entry && entry.continuation) {
                    // This row is a continuation, don't render the time cell
                } else {
                    const rowspan = calculateRowspan(firstBunk, i);
                    const tdTime = document.createElement("td");
                    tdTime.textContent = slot.label;
                    tdTime.style.border = "1px solid #ccc";
                    tdTime.style.verticalAlign = "top";
                    if (rowspan > 1) {
                         const endSlot = unifiedTimes[i + rowspan - 1];
                         tdTime.textContent = `${fmtTime(slot.start)} - ${fmtTime(endSlot.end)}`;
                         tdTime.rowSpan = rowspan;
                    }
                    tr.appendChild(tdTime);
                }
            }

            // --- 2. Add ACTIVITY cells for each BUNK ---
            bunks.forEach(bunk => {
                const entry = getEntry(bunk, i);
                
                if (entry && entry.continuation) {
                    // This bunk is continuing. Do not render a <td>.
                } else {
                    // This is a new activity. Render a cell.
                    const rowspan = calculateRowspan(bunk, i);
                    const tdActivity = document.createElement("td");
                    if (rowspan > 1) tdActivity.rowSpan = rowspan;
                    
                    tdActivity.style.border = "1px solid #ccc";
                    tdActivity.style.verticalAlign = "top";

                    if (entry) {
                        tdActivity.textContent = formatEntry(entry);
                        if (entry._h2h) {
                            tdActivity.style.background = "#e8f4ff";
                            tdActivity.style.fontWeight = "bold";
                        } else if (entry._fixed) {
                            tdActivity.style.background = "#f1f1f1";
                        }
                    } else {
                        tdActivity.className = "grey-cell";
                    }
                    tr.appendChild(tdActivity);
                }
            });
        });
        
        if (tr.children.length > 0) {
            tbody.appendChild(tr);
        }
    } 

    table.appendChild(tbody);
    container.appendChild(table);
}


/**
 * Renders the "Fixed Block" (Agudah) view
 * REWRITTEN to iterate `unifiedTimes` and support `rowspan`
 * PER-DIVISION to fix the "Split Activity" bug.
 */
function renderFixedBlockView(container) {
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
    
    // --- 2. Build Body (Slot-based) ---
    const tbody = document.createElement("tbody");
    
    // *** START OF BUG FIX ***
    for (let i = 0; i < unifiedTimes.length; i++) {
        const slot = unifiedTimes[i];
        
        // We must *always* create a <tr>.
        // We will decide whether to add cells to it.
        const tr = document.createElement("tr");

        // --- 1. Add Time Cell ---
        // Check continuation *only for the first bunk of the first division*
        // This determines if we draw the time cell or not.
        const firstBunk = divisions[availableDivisions[0]]?.bunks?.[0];
        const firstEntry = getEntry(firstBunk, i);
        
        if (firstEntry && firstEntry.continuation) {
            // This row is a continuation *for the time column*.
            // We skip rendering the <td>, the row will be built by the divisions.
        } else {
            // This is a new row, so render the time cell.
            const rowspan = calculateRowspan(firstBunk, i);
            const tdTime = document.createElement("td");
            tdTime.textContent = slot.label;
            if (rowspan > 1 && (i + rowspan - 1) < unifiedTimes.length) {
                const endSlot = unifiedTimes[i + rowspan - 1];
                tdTime.textContent = `${fmtTime(slot.start)} - ${fmtTime(endSlot.end)}`;
                tdTime.rowSpan = rowspan;
            }
            tdTime.style.border = "1px solid #ccc";
            tdTime.style.verticalAlign = "top";
            tr.appendChild(tdTime);
        }

        // --- 2. Add Division Cells ---
        availableDivisions.forEach(div => {
            const bunks = divisions[div]?.bunks || [];
            const firstBunkForThisDiv = bunks[0];
            const entry = getEntry(firstBunkForThisDiv, i);

            if (entry && entry.continuation) {
                // This division is continuing. Its previous <td> has a rowspan.
                // Do not render a new <td>.
            } else {
                // This is a new block for this division. Render a <td>.
                const rowspan = calculateRowspan(firstBunkForThisDiv, i);
                const td = document.createElement("td");
                td.style.verticalAlign = "top";
                if (rowspan > 1) td.rowSpan = rowspan;
                
                if (entry && entry._h2h) {
                    // It's a league game. Scan all bunks to build the list.
                    td.style.textAlign = "left";
                    td.style.padding = "5px 8px";
                    td.style.background = "#e8f5e9";
                    
                    let games = new Map();
                    bunks.forEach(bunk => {
                        // Check this slot for all bunks
                        const bunkEntry = getEntry(bunk, i); 
                        if (bunkEntry && bunkEntry._h2h && bunkEntry.sport) {
                            games.set(bunkEntry.sport, fieldLabel(bunkEntry.field));
                        }
                    });
                    
                    let html = '<ul style="margin: 0; padding-left: 18px;">';
                    if (games.size === 0) {
                        html = '<p class="muted" style="margin:0; padding: 4px;">Leagues</p>';
                    }
                    games.forEach((field, matchup) => {
                        html += `<li>${matchup} @ ${field}</li>`;
                    });
                    if (games.size > 0) { html += '</ul>'; }
                    td.innerHTML = html;
                
                } else if (entry) {
                    // Regular activity
                    td.textContent = formatEntry(entry);
                    if (entry._fixed) {
                         td.style.background = "#f1f1f1";
                    }
                } else {
                    td.className = "grey-cell";
                }
                td.style.border = "1px solid #ccc";
                tr.appendChild(td);
            }
        });

        // Only append the row if it has children
        // (i.e., it wasn't a row where *every single cell* was a continuation)
        if (tr.children.length > 0) {
            tbody.appendChild(tr);
        }
    }
    // *** END OF BUG FIX ***
    
    table.appendChild(tbody);
    container.appendChild(table);
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

function initScheduleSystem() {
    try {
        window.scheduleAssignments = window.scheduleAssignments || {};
        window.leagueAssignments = window.leagueAssignments || {};
        reconcileOrRenderSaved();
        
        const toggle = document.getElementById("schedule-view-toggle");
        if (toggle) {
            toggle.onchange = () => {
                updateTable();
            };
        }
        
    } catch (e) {
        updateTable();
    }
}

// ===== Exports =====
window.updateTable = window.updateTable || updateTable;
window.initScheduleSystem = window.initScheduleSystem || initScheduleSystem;
window.saveSchedule = window.saveSchedule || saveSchedule;
