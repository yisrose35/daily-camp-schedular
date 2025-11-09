// -------------------- scheduler_ui.js --------------------
// UI-only: rendering, save/load, init, and window exports.
//
// UPDATED:
// - updateTable() now checks for the "View Toggle"
// - Added renderFixedBlockView() for the "Agudah" style
// - Added renderStaggeredView() for the "YKLI" style
// - Fixed reconcileOrRenderSaved to load 'unifiedTimes' from save
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

// ===== NEW: Main updateTable function =====
// This function now just decides *which* renderer to use.
function updateTable() {
    const container = document.getElementById("scheduleTable");
    if (!container) return;
    
    const toggle = document.getElementById("schedule-view-toggle");
    
    if (toggle && toggle.checked) {
        renderFixedBlockView(container);
    } else {
        renderStaggeredView(container);
    }
}

/**
 * Renders the "Staggered" (YKLI) view
 * This is the original updateTable function
 */
function renderStaggeredView(container) {
    container.innerHTML = "";

    const availableDivisions = window.availableDivisions || [];
    const divisions = window.divisions || {};
    const unifiedTimes = window.unifiedTimes || [];
    const scheduleAssignments = window.scheduleAssignments || {};
    const leagueAssignments = window.leagueAssignments || {}; // Kept for legacy data
    
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
        th.colSpan = (divisions[div]?.bunks || []).length;
        th.textContent = div;
        th.style.background = divisions[div]?.color || "#333";
        th.style.color = "#fff";
        tr1.appendChild(th);
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

    // --- 2. Build Body (Grid-Based) ---
    const tbody = document.createElement("tbody");

    for (let i = 0; i < unifiedTimes.length; i++) {
        const tr = document.createElement("tr");
        
        const tdTime = document.createElement("td");
        tdTime.textContent = unifiedTimes[i].label;
        tr.appendChild(tdTime);
        
        availableDivisions.forEach((div) => {
            const bunks = divisions[div]?.bunks || [];
            
            for (const b of bunks) {
                const entry = scheduleAssignments[b]?.[i];
                const league = leagueAssignments[div]?.[i]; // Keep for old data

                if (league) { // Handle legacy league data
                    if (league.isContinuation) continue;
                    let span = 1;
                    for (let j = i + 1; j < unifiedTimes.length; j++) {
                        if (leagueAssignments[div]?.[j]?.isContinuation) span++;
                        else break;
                    }
                    const td = document.createElement("td");
                    td.colSpan = bunks.length;
                    td.rowSpan = span;
                    td.style.background = divisions[div]?.color || "#4CAF50";
                    td.style.color = "#fff";
                    td.style.fontWeight = "600";
                    td.style.verticalAlign = "top";
                    const list = (league.games || [])
                        .map(g => `${g.teams[0]} vs ${g.teams[1]} (${g.sport}) @ ${g.field || '?'}`)
                        .join("<br> • ");
                    td.innerHTML = `<div class="league-pill">${list}<br><span style="font-size:0.85em;">${league.leagueName}</span></div>`;
                    tr.appendChild(td);
                    break;
                }
                
                if (entry) {
                    if (entry.continuation) continue; // This slot is covered by a previous rowspan
                    let span = 1;
                    for (let j = i + 1; j < unifiedTimes.length; j++) {
                        if (scheduleAssignments[b]?.[j]?.continuation) span++;
                        else break;
                    }
                    const td = document.createElement("td");
                    td.rowSpan = span;
                    td.style.verticalAlign = "top";

                    // THIS IS THE FIX: It now correctly renders the H2H data from leagues
                    if (entry._h2h) {
                        td.textContent = `${entry.sport} @ ${fieldLabel(entry.field)}`;
                        td.style.background = "#e8f4ff";
                        td.style.fontWeight = "bold";
                    } else if (entry._fixed) {
                        td.textContent = fieldLabel(entry.field);
                        td.style.background = "#f1f1f1";
                        td.style.fontWeight = "600";
                    } else if (entry.sport) {
                        td.textContent = `${fieldLabel(entry.field)} – ${entry.sport}`;
                    } else {
                        td.textContent = fieldLabel(entry.field);
                    }
                    tr.appendChild(td);
                }

                if (!entry && !league) {
                    const prevLeague = tr.querySelector('td[colspan]');
                    if (prevLeague) continue;
                    
                    const prevEmpty = i > 0 && !scheduleAssignments[b]?.[i-1] && !leagueAssignments[div]?.[i-1];
                    if(prevEmpty) continue;
                    
                    let span = 1;
                    for (let j = i + 1; j < unifiedTimes.length; j++) {
                        if (!scheduleAssignments[b]?.[j] && !leagueAssignments[div]?.[j]) {
                            span++;
                        } else {
                            break;
                        }
                    }
                    const td = document.createElement("td");
                    td.rowSpan = span;
                    td.className = "grey-cell"; // Use this class for empty
                    tr.appendChild(td);
                }
            } // end bunks loop
        }); // end divisions loop
        tbody.appendChild(tr);
    } // end unifiedTimes loop

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
