// =================================================================
// scheduler_ui.js
//
// UPDATED (CRITICAL BUG FIX):
// - `renderStaggeredView`: The logic for finding blocks for a
//   division was flawed and creating duplicate rows.
// - It now has a new filter `blocksByDivision[div] = divBlocks.filter(...)`
//   that correctly finds only *unique* blocks based on their
//   time label *and* event type (e.g., "League Game").
// - This will fix the "double row" bug.
// - `findFirstSlotForTime` has also been improved to correctly
//   find the overlapping slot for short events like "Snacks".
// =================================================================

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
/**
 * NEW Helper: Converts minutes (e.g., 740) to a 12-hour string (e.g., "12:20 PM")
 */
function minutesToTimeLabel(min) {
    if (min == null) return "";
    let h = Math.floor(min / 60);
    const m = (min % 60).toString().padStart(2, '0');
    const ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${m} ${ap}`;
}


// ===== NEW: Main updateTable function =====
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
 * --- UPDATED: Fix for "Free" slots bug ---
 * Helper: Finds the *first* 30-min slot index
 * that *overlaps* with the start time of a custom block.
 */
function findFirstSlotForTime(startMin) {
    if (!window.unifiedTimes || startMin == null) return -1;
    
    for (let i = 0; i < window.unifiedTimes.length; i++) {
        const slot = window.unifiedTimes[i];
        const slotStart = new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes();
        const slotEnd = slotStart + INCREMENT_MINS;
        
        // Find the first slot that the block's start time *overlaps* with
        // (Block Start < Slot End) and (Block End > Slot Start)
        // We assume block end is at least startMin + 1
        if (startMin < slotEnd && (startMin + 1) > slotStart) {
            return i;
        }
    }
    return -1;
}

/**
 * Renders the "Staggered" (YKLI) view
 * REWRITTEN to "flatten" split blocks and correctly render leagues.
 */
function renderStaggeredView(container) {
    container.innerHTML = "";

    const availableDivisions = window.availableDivisions || [];
    const divisions = window.divisions || {};
    const scheduleAssignments = window.scheduleAssignments || {};

    const dailyData = window.loadCurrentDailyData?.() || {};
    // --- THIS IS THE KEY ---
    // It reads the *same* skeleton that the optimizer just ran on.
    const manualSkeleton = dailyData.manualSkeleton || [];
    
    if (manualSkeleton.length === 0) {
        container.innerHTML = "<p>No schedule built for this day. Go to the 'Daily Adjustments' tab to run the optimizer.</p>";
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

    // --- 2. Build Body (Event-based) ---
    const tbody = document.createElement("tbody");
    
    // Find all unique, sorted blocks *per division* from the SKELETON
    const blocksByDivision = {};
    availableDivisions.forEach(div => {
        const divBlocks = [];
        manualSkeleton.forEach(item => {
            if (item.division === div) {
                divBlocks.push({
                    label: `${item.startTime} - ${item.endTime}`,
                    startMin: parseTimeToMinutes(item.startTime),
                    endMin: parseTimeToMinutes(item.endTime),
                    event: item.event,
                    type: item.type 
                });
            }
        });
        divBlocks.sort((a,b) => a.startMin - b.startMin);
        
        // --- THIS FILTER FIXES THE "DOUBLE ROW" BUG ---
        // It now finds blocks that are unique by *both* time and event type.
        blocksByDivision[div] = divBlocks.filter((block, index, self) =>
            index === self.findIndex((t) => (t.label === block.label && t.event === block.event))
        );
    });

    // --- "Flatten" split blocks into two half-blocks ---
    const splitBlocksByDivision = {};
    let maxEvents = 0;

    availableDivisions.forEach(div => {
        const flattenedBlocks = [];
        const originalBlocks = blocksByDivision[div] || [];

        originalBlocks.forEach(block => {
            if (block.type === 'split' && block.startMin != null && block.endMin != null) {
                // Calculate midpoint, rounding to nearest minute
                const midMin = Math.round(block.startMin + (block.endMin - block.startMin) / 2);
                
                // First half
                flattenedBlocks.push({
                    ...block,
                    label: `${minutesToTimeLabel(block.startMin)} - ${minutesToTimeLabel(midMin)}`,
                    startMin: block.startMin,
                    endMin: midMin,
                    splitPart: 1 // Mark as first half
                });
                // Second half
                flattenedBlocks.push({
                    ...block,
                    label: `${minutesToTimeLabel(midMin)} - ${minutesToTimeLabel(block.endMin)}`,
                    startMin: midMin,
                    endMin: block.endMin,
                    splitPart: 2 // Mark as second half
                });
            } else {
                // Not a split block, add as is
                flattenedBlocks.push(block);
            }
        });
        
        splitBlocksByDivision[div] = flattenedBlocks;
        if (flattenedBlocks.length > maxEvents) {
            maxEvents = flattenedBlocks.length;
        }
    });
    // --- END OF FLATTENING ---


    // Now render the rows, one for each "event index"
    for (let i = 0; i < maxEvents; i++) {
        const tr = document.createElement("tr");
        
        availableDivisions.forEach(div => {
            const bunks = divisions[div]?.bunks || [];
            const blocks = splitBlocksByDivision[div] || []; 
            const eventBlock = blocks[i]; // Get the i-th event block for this division
            
            // --- 1. Add the TIME cell for this division ---
            const tdTime = document.createElement("td");
            tdTime.style.border = "1px solid #ccc";
            tdTime.style.verticalAlign = "top";
            if (eventBlock) {
                tdTime.textContent = eventBlock.label; 
            } else {
                tdTime.className = "grey-cell";
            }
            tr.appendChild(tdTime);

            // --- 2. Add ACTIVITY cells (Merged or Individual) ---
            
            if (eventBlock && (eventBlock.event === 'League Game' || eventBlock.event === 'Specialty League')) {
                // === LEAGUE GAME / SPECIALTY LEAGUE: MERGED CELL ===
                const tdLeague = document.createElement("td");
                tdLeague.colSpan = bunks.length;
                tdLeague.style.verticalAlign = "top";
                tdLeague.style.textAlign = "left";
                tdLeague.style.padding = "5px 8px";
                tdLeague.style.background = "#e8f5e9";
                
                const firstSlotIndex = findFirstSlotForTime(eventBlock.startMin);
                
                if (eventBlock.event === 'Specialty League') {
                    // --- Specialty League Formatting (Group by Field) ---
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

                    let html = '<div style="margin: 0; padding: 4px;">';
                    if (gamesByField.size === 0) {
                        html = '<p class="muted" style="margin:0; padding: 4px;">Specialty League</p>';
                    }
                    gamesByField.forEach((matchups, field) => {
                        const matchupNames = matchups.map(m => m.substring(0, m.lastIndexOf('(')).trim());
                        html += `<div style="margin-bottom: 2px;">
                                    <strong>${matchupNames.join(', ')}</strong> - ${field}
                                 </div>`;
                    });
                    if (gamesByField.size > 0) { html += '</div>'; }
                    tdLeague.innerHTML = html;

                } else {
                    // --- Regular League Formatting (List) ---
                    let games = new Map();
                    if (firstSlotIndex !== -1) {
                        bunks.forEach(bunk => {
                            const entry = getEntry(bunk, firstSlotIndex);
                            if (entry && entry._h2h && entry.sport) {
                                games.set(entry.sport, fieldLabel(entry.field));
                            }
                        });
                    }
                    
                    let html = '<ul style="margin: 0; padding-left: 18px;">';
                    if (games.size === 0) {
                        html = '<p class="muted" style="margin:0; padding: 4px;">Leagues</p>';
                    }
                    games.forEach((field, matchup) => {
                        html += `<li>${matchup} @ ${field}</li>`;
                    });
                    if (games.size > 0) { html += '</ul>'; }
                    tdLeague.innerHTML = html;
                }
                
                tr.appendChild(tdLeague);

            } else {
                // === REGULAR GAME / SPLIT GAME: INDIVIDUAL CELLS ===
                bunks.forEach(bunk => {
                    const tdActivity = document.createElement("td");
                    tdActivity.style.border = "1px solid #ccc";
                    tdActivity.style.verticalAlign = "top";
                    
                    if (eventBlock) {
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
                    
                    } else {
                        tdActivity.className = "grey-cell";
                    }
                    tr.appendChild(tdActivity);
                });
            }
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
        
    } catch (e) {
        updateTable();
    }
}

// ===== Exports =====
window.updateTable = window.updateTable || updateTable;
window.initScheduleSystem = window.initScheduleSystem || initScheduleSystem;
window.saveSchedule = window.saveSchedule || saveSchedule;

})();
