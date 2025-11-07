// -------------------- scheduler_ui.js --------------------
// UI-only: rendering, save/load, init, and window exports.
//
// REFACTORED FOR "SCHEDULE PERIODS"
// - updateTable() is completely rewritten.
// - It now iterates over window.schedulePeriods (from app1) to build rows.
// - It reads division rules to find/display 1 or 2+ activities in a single cell.
// -----------------------------------------------------------------

// ===== HELPERS (Copied from core) =====
// (These are needed for the rendering logic)

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

/**
 * NEW: Helper to find the first unifiedTimes slot index for a given period.
 */
function findFirstSlotForPeriod(period, unifiedTimes) {
    if (!unifiedTimes || unifiedTimes.length === 0) return -1;
    const periodStartMin = parseTimeToMinutes(period.start);
    
    for (let i = 0; i < unifiedTimes.length; i++) {
        const slotStartMin = unifiedTimes[i].start.getHours() * 60 + unifiedTimes[i].start.getMinutes();
        if (slotStartMin === periodStartMin) {
            return i;
        }
        // Fallback for first period
        if (slotStartMin >= periodStartMin && i === 0) {
            return 0;
        }
    }
    // Fallback if no exact match (e.g., 9:00 period, 9:05 slot)
    for (let i = 0; i < unifiedTimes.length; i++) {
        const slotStartMin = unifiedTimes[i].start.getHours() * 60 + unifiedTimes[i].start.getMinutes();
        if (slotStartMin >= periodStartMin) {
            return i;
        }
    }
    return -1;
}

/**
 * NEW: Helper to calculate the slot count and span for a division in a period.
 */
function getPeriodMetrics(period, divRule) {
    const startMin = parseTimeToMinutes(period.start);
    const endMin = parseTimeToMinutes(period.end);
    const totalDuration = endMin - startMin;
    const totalSlots = Math.floor(totalDuration / 30); // Assumes 30-min increments
    
    const numActivities = parseInt(divRule, 10);
    const spanLen = Math.max(1, Math.floor(totalSlots / numActivities));
    
    return { numActivities, spanLen, totalSlots };
}


// ===== NEW: updateTable (Period-Based) =====
function updateTable() {
    const container = document.getElementById("scheduleTable");
    if (!container) return;
    container.innerHTML = ""; // Clear old table

    // Load all necessary data from globals
    const schedulePeriods = window.schedulePeriods || [];
    const availableDivisions = window.availableDivisions || [];
    const divisions = window.divisions || {};
    const unifiedTimes = window.unifiedTimes || [];
    const scheduleAssignments = window.scheduleAssignments || {};
    const leagueAssignments = window.leagueAssignments || {};

    if (schedulePeriods.length === 0) {
        container.innerHTML = "<p>No Schedule Periods defined. Please add periods in the Setup tab.</p>";
        return;
    }
    if (availableDivisions.length === 0) {
        container.innerHTML = "<p>No divisions defined. Please add divisions in the Setup tab.</p>";
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
        const divData = divisions[div];
        const bunksInDiv = divData?.bunks || [];
        if (bunksInDiv.length > 0) {
            const th = document.createElement("th");
            th.colSpan = bunksInDiv.length;
            th.textContent = div;
            th.style.background = divData?.color || "#333";
            th.style.color = "#fff";
            tr1.appendChild(th);
        }
    });
    thead.appendChild(tr1);

    const tr2 = document.createElement("tr");
    const bunkTh = document.createElement("th");
    bunkTh.textContent = "Bunk";
    tr2.appendChild(bunkTh);
    availableDivisions.forEach((div) => {
        (divisions[div]?.bunks || []).forEach((b) => {
            const th = document.createElement("th");
            th.textContent = b;
            tr2.appendChild(th);
        });
    });
    thead.appendChild(tr2);
    table.appendChild(thead);

    // --- 2. Build Body (Period-Based) ---
    const tbody = document.createElement("tbody");

    // Keep track of rowspans for leagues/fixed
    const rowSpanTrack = {}; // { bunkName: { slots: 0, td: null } }

    for (const period of schedulePeriods) {
        const tr = document.createElement("tr");
        
        // --- Time Cell ---
        const tdTime = document.createElement("td");
        tdTime.style.fontWeight = "bold";
        tdTime.innerHTML = `${period.name}<br><span style="font-size:0.85em; font-weight:normal;">${period.start} - ${period.end}</span>`;
        tr.appendChild(tdTime);
        
        // Find the metrics for this period
        const periodStartSlot = findFirstSlotForPeriod(period, unifiedTimes);

        // --- Bunk Cells ---
        for (const div of availableDivisions) {
            const divData = divisions[div];
            const bunks = divData?.bunks || [];
            
            // Get division rule for this period
            const divRule = divData?.periodRules?.[period.id] || "1";
            const { numActivities, spanLen } = getPeriodMetrics(period, divRule);

            for (const bunk of bunks) {
                // Check if this cell is already covered by a rowspan
                if (rowSpanTrack[bunk] && rowSpanTrack[bunk].slots > 0) {
                    rowSpanTrack[bunk].slots--;
                    // If it's the last slot, clear the tracker
                    if (rowSpanTrack[bunk].slots === 0) {
                        rowSpanTrack[bunk] = null;
                    }
                    continue; // Skip rendering this <td>
                }

                const td = document.createElement("td");
                td.style.verticalAlign = "top";
                
                let entry = null;
                if (periodStartSlot !== -1) {
                     entry = scheduleAssignments[bunk]?.[periodStartSlot];
                }

                // Check for league (which overrides everything)
                const league = leagueAssignments[div]?.[periodStartSlot];

                if (league && !league.isContinuation) {
                    // --- 1. LEAGUE ---
                    td.colSpan = bunks.length;
                    
                    // Calculate rowspan for league
                    let leagueSpan = 1;
                    const { totalSlots: leagueTotalSlots } = getPeriodMetrics(period, "1"); // Assume league takes full period
                    
                    // Note: This logic assumes leagues align perfectly with periods.
                    // A more robust league rowspan would check unifiedTimes.
                    
                    td.rowSpan = 1; // Simplification: 1 period = 1 row
                    td.style.background = divData?.color || "#4CAF50";
                    td.style.color = "#fff";
                    td.style.fontWeight = "600";
                    
                    const list = league.games
                        .map(g => `${g.teams[0]} vs ${g.teams[1]} (${g.sport}) @ ${g.field || '?'}`)
                        .join("<br> • ");
                    td.innerHTML = `<div class="league-pill">${list}<br><span style="font-size:0.85em;">${league.leagueName}</span></div>`;

                    tr.appendChild(td);
                    
                    // Skip the rest of the bunks in this division
                    break; // Exit bunk loop, move to next division
                
                } else if (entry && entry._fixed && !entry.continuation) {
                    // --- 2. FIXED ACTIVITY (e.g., Lunch) ---
                    td.textContent = fieldLabel(entry.field);
                    td.style.background = "#f1f1f1";
                    td.style.fontWeight = "600";
                    tr.appendChild(td);

                } else if (entry && !entry.continuitation) {
                    // --- 3. GENERAL/H2H ACTIVITIES ---
                    const activitiesInCell = [];
                    for (let i = 0; i < numActivities; i++) {
                        const slotToFind = periodStartSlot + (i * spanLen);
                        const subEntry = scheduleAssignments[bunk]?.[slotToFind];

                        if (subEntry) {
                            if (subEntry._h2h) {
                                activitiesInCell.push(`<strong>${subEntry.sport} vs ${subEntry.vs}</strong><br><span style="font-size:0.9em;">@ ${fieldLabel(subEntry.field)}</span>`);
                            } else {
                                let text = fieldLabel(subEntry.field);
                                if (subEntry.sport) {
                                    text += ` – ${subEntry.sport}`;
                                }
                                activitiesInCell.push(text);
                            }
                        } else {
                            activitiesInCell.push(`<span style="color:#c0392b;">(Empty)</span>`);
                        }
                    }
                    td.innerHTML = activitiesInCell.join('<hr style="margin:2px 0; border-top: 1px dashed #ccc;">');
                    tr.appendChild(td);
                
                } else {
                    // --- 4. EMPTY CELL ---
                    // Only render if it's not a continuation
                    if (!entry) {
                         tr.appendChild(td);
                    }
                }
            }
        }
        tbody.appendChild(tr);
    } // end period loop

    table.appendChild(tbody);
    container.appendChild(table);
}


// ===== Save/Load/Init =====
// (These functions are unchanged, but they call the new updateTable)

function saveSchedule() {
    try {
        window.saveCurrentDailyData?.("scheduleAssignments", window.scheduleAssignments);
        window.saveCurrentDailyData?.("leagueAssignments", window.leagueAssignments);
    } catch (e) {
        console.error("Save schedule failed:", e);
    }
}

function reconcileOrRenderSaved() {
    try {
        const data = window.loadCurrentDailyData?.() || {};
        window.scheduleAssignments = data.scheduleAssignments || {};
        window.leagueAssignments = data.leagueAssignments || {};
    } catch (e) {
        console.error("Reconcile saved failed:", e);
        window.scheduleAssignments = {};
        window.leagueAssignments = {};
    }
    updateTable(); // This now calls the NEW period-based renderer
}

function initScheduleSystem() {
    try {
        // Ensure globals exist
        window.scheduleAssignments = window.scheduleAssignments || {};
        window.leagueAssignments = window.leagueAssignments || {};
        // Render whatever is saved for the selected calendar day
        reconcileOrRenderSaved();
    } catch (e) {
        console.error("Init error:", e);
        updateTable();
    }
}

// ===== Exports =====
window.updateTable = window.updateTable || updateTable;
window.initScheduleSystem = window.initScheduleSystem || initScheduleSystem;
