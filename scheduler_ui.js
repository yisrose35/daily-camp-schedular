// -------------------- scheduler_ui.js --------------------
// UI-only: rendering, save/load, init, and window exports.
//
// UPDATED:
// - *** CRITICAL FIX (Split Activity) ***
//   - `renderFixedBlockView` and `renderStaggeredView` have
//     been completely rewritten.
//   - They NO LONGER build time rows from the `manualSkeleton`.
//   - They now iterate over the `window.unifiedTimes` (30-min grid),
//     which is the *actual output* of the optimizer.
//   - This is the only way to correctly display "Split Activity"
//     blocks as two separate, distinct time rows (e.g.,
//     12:00-12:30 and 12:30-1:00).
// - **Cell Merging (Rowspan):**
//   - Both renderers now correctly calculate `rowspan` for
//     multi-slot activities (like "Lunch") by checking the
//     `continuation` flag on schedule entries.
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
    if (assignments[bunk] && assignments[bunk][slotIndex]) {
        return assignments[bunk][slotIndex];
    }
    return null; // Return null if empty
}

/**
 * NEW: Helper to calculate rowspan for a given bunk/slot.
 */
function calculateRowspan(bunk, slotIndex) {
    let rowspan = 1;
    const firstEntry = getEntry(bunk, slotIndex);
    if (!firstEntry) return 1;

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
                // Check the *first bunk of the first division* for continuation
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
                    if (rowspan > 1) tdTime.rowSpan = rowspan;
                    tr.appendChild(tdTime);
                }
            }

            // --- 2. Add ACTIVITY cells for each BUNK ---
            bunks.forEach(bunk => {
                const entry = getEntry(bunk, i);
                
                if (entry && entry.continuation) {
                    // This bunk is continuing its previous activity.
                    // Do not render a <td>, its previous row handles it.
                } else {
                    // This is a new activity, render a cell.
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
        
        // Only append the row if it has children (i.e., wasn't *just* continuation)
        if (tr.children.length > 0) {
            tbody.appendChild(tr);
        }
    } 

    table.appendChild(tbody);
    container.appendChild(table);
}


/**
 * Renders the "Fixed Block" (Agudah) view
 * REWRITTEN to iterate `unifiedTimes` and support `rowspan`.
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
    
    for (let i = 0; i < unifiedTimes.length; i++) {
        const slot = unifiedTimes[i];
        
        // Check the first division's first bunk for continuation
        const firstBunk = divisions[availableDivisions[0]]?.bunks?.[0];
        const firstEntry = getEntry(firstBunk, i);
        
        if (firstEntry && firstEntry.continuation) {
            // This entire row is a continuation from a previous row.
            // We assume all divisions started their activities at the same time.
            // This simplifies the view, which is the point of "Fixed Block".
            continue;
        }

        // This is a new row
        const tr = document.createElement("tr");
        
        // Calculate rowspan based on the first bunk
        const rowspan = calculateRowspan(firstBunk, i);
        
        const tdTime = document.createElement("td");
        tdTime.textContent = slot.label;
        if (rowspan > 1) {
            // If it's a multi-slot block, adjust the label
            const endSlot = unifiedTimes[i + rowspan - 1];
            tdTime.textContent = `${fmtTime(slot.start)} - ${fmtTime(endSlot.end)}`;
            tdTime.rowSpan = rowspan;
        }
        tdTime.style.border = "1px solid #ccc"; // Ensure border
        tdTime.style.verticalAlign = "top"; // Ensure alignment
        tr.appendChild(tdTime);
        
        availableDivisions.forEach(div => {
            const bunks = divisions[div]?.bunks || [];
            const td = document.createElement("td");
            td.style.verticalAlign = "top";
            if (rowspan > 1) td.rowSpan = rowspan;
            
            const entry = getEntry(bunks[0], i); // Get entry for *this* div's first bunk
            
            if (entry && entry._h2h) {
                // It's a league game. Scan all bunks to build the list.
                td.style.textAlign = "left";
                td.style.padding = "5px 8px";
                td.style.background = "#e8f5e9";
                
                let games = new Map();
                bunks.forEach(bunk => {
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
            td.style.border = "1px solid #ccc"; // Ensure border
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    }
    
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
