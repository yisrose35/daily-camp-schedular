// -------------------- scheduler_ui.js --------------------
// UI-only: rendering, save/load, init, and window exports.
//
// REFACTORED FOR "GRID" (Rowspan-Based)
// - updateTable() is rewritten to iterate the 30-min unifiedTimes.
// - It creates one <tr> per 30-min slot.
// - It uses 'continuation' checks to calculate `rowspan`
//   to visually group blocks of 60, 90, etc. minutes.
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

// ===== NEW: updateTable (Grid-Based) =====
function updateTable() {
    const container = document.getElementById("scheduleTable");
    if (!container) return;
    container.innerHTML = "";

    const availableDivisions = window.availableDivisions || [];
    const divisions = window.divisions || {};
    const unifiedTimes = window.unifiedTimes || [];
    const scheduleAssignments = window.scheduleAssignments || {};
    const leagueAssignments = window.leagueAssignments || {};
    const divisionActiveRows = window.divisionActiveRows || {};

    if (unifiedTimes.length === 0) {
        container.innerHTML = "<p>No schedule times found. Generate a schedule in the Setup tab.</p>";
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
            
            // Check if this slot is active for this division
            const isDivActive = divisionActiveRows[div]?.has(i) || false;

            // ===== START OF FIX 1: Replaced forEach with for...of =====
            for (const b of bunks) {
                const entry = scheduleAssignments[b]?.[i];
                const league = leagueAssignments[div]?.[i];

                if (!isDivActive && !entry && !league) {
                    // This slot is INACTIVE for this division
                    // Check if previous slot was also inactive
                    const prevInactive = i > 0 && !(divisionActiveRows[div]?.has(i-1) || false);
                    if (prevInactive) {
                        // This cell is part of a rowspan, skip rendering
                        continue; // FIX: Was 'return'
                    } else {
                        // This is the START of an inactive block
                        let span = 1;
                        for (let j = i + 1; j < unifiedTimes.length; j++) {
                            if (!(divisionActiveRows[div]?.has(j) || false)) {
                                span++;
                            } else {
                                break;
                            }
                        }
                        const td = document.createElement("td");
                        td.rowSpan = span;
                        td.className = "grey-cell";
                        td.style.background = "#ddd";
                        tr.appendChild(td);
                    }
                    continue; // FIX: Was 'return' (Done with this bunk)
                }

                // This slot IS active
                
                if (league) {
                    if (league.isContinuation) continue; // FIX: Was 'return' (Skip)
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
                    const list = league.games
                        .map(g => `${g.teams[0]} vs ${g.teams[1]} (${g.sport}) @ ${g.field || '?'}`)
                        .join("<br> • ");
                    td.innerHTML = `<div class="league-pill">${list}<br><span style="font-size:0.85em;">${league.leagueName}</span></div>`;
                    tr.appendChild(td);
                    
                    // Break bunk loop, but first mark other bunks as "covered"
                    // (This is tricky, skipping for now, relying on colspan)
                }
                
                if (league) {
                    // Stop processing this division's bunks for this row
                    // This break is crucial for the colspan to work
                    break; // FIX: This is now a LEGAL break
                }

                if (entry) {
                    if (entry.continuation) continue; // FIX: Was 'return' (Skip)
                    let span = 1;
                    for (let j = i + 1; j < unifiedTimes.length; j++) {
                        if (scheduleAssignments[b]?.[j]?.continuation) span++;
                        else break;
                    }
                    const td = document.createElement("td");
                    td.rowSpan = span;
                    td.style.verticalAlign = "top";

                    if (entry._h2h) {
                        td.textContent = `${entry.sport} @ ${fieldLabel(entry.field)} vs ${entry.vs}`;
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
                    // Genuinely empty slot
                    const td = document.createElement("td");
                    tr.appendChild(td);
                }
            } // ===== END OF FIX 1: end bunks loop =====
        }); // end divisions loop
        tbody.appendChild(tr);
    } // end unifiedTimes loop

    table.appendChild(tbody);
    container.appendChild(table);
}


// ===== Save/Load/Init =====
// (Unchanged)
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
    // We must generate the time grid FIRST
    if (window.generateUnifiedTimesAndMasks) {
         window.generateUnifiedTimesAndMasks();
    }
    updateTable(); 
}

function initScheduleSystem() {
    try {
        window.scheduleAssignments = window.scheduleAssignments || {};
        window.leagueAssignments = window.leagueAssignments || {};
        reconcileOrRenderSaved();
    } catch (e) {
        console.error("Init error:", e);
        updateTable();
    }
}

// ===== Exports =====
window.updateTable = window.updateTable || updateTable;
window.initScheduleSystem = window.initScheduleSystem || initScheduleSystem;
// NEW: Expose this for reconcile to use
window.generateUnifiedTimesAndMasks = window.generateUnifiedTimesAndMasks || generateUnifiedTimesAndMasks;
// ===== FIX 2: Expose saveSchedule =====
window.saveSchedule = window.saveSchedule || saveSchedule;
