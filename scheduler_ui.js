(function(){
'use strict';

// =================================================================
// scheduler_ui.js
//
// UPDATED (CRITICAL BUG FIX):
// - renderStaggeredView: fixed duplicate rows via per-division unique filter
// - findFirstSlotForTime: robust overlap check for short events
// - Added proper IIFE wrapper and clean exports
// - Verified balanced braces; removed stray closing brace
// - Ensured window.* exports are assigned unconditionally
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
    let h = d.getHours();
    const m = d.getMinutes().toString().padStart(2,"0");
    const ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${m} ${ap}`;
}

/** Converts minutes (e.g., 740) to a 12-hour string (e.g., "12:20 PM") */
function minutesToTimeLabel(min) {
    if (min == null) return "";
    let h = Math.floor(min / 60);
    const m = (min % 60).toString().padStart(2, '0');
    const ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${m} ${ap}`;
}

// ===== Main updateTable function =====
function updateTable() {
    const container = document.getElementById("scheduleTable");
    if (!container) return;
    // Always render the Staggered View
    renderStaggeredView(container);
}

/** Helper: get the schedule entry for a slot */
function getEntry(bunk, slotIndex) {
    const assignments = window.scheduleAssignments || {};
    if (bunk && assignments[bunk] && assignments[bunk][slotIndex]) {
        return assignments[bunk][slotIndex];
    }
    return null;
}

/** Helper: format a schedule entry into text */
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
 * UPDATED: Fix for "Free" slots bug
 * Finds the *first* 30-min slot index that *overlaps* the custom block start
 */
function findFirstSlotForTime(startMin) {
    if (!Array.isArray(window.unifiedTimes) || startMin == null) return -1;
    for (let i = 0; i < window.unifiedTimes.length; i++) {
        const slot = window.unifiedTimes[i];
        const s = (slot.start instanceof Date) ? slot.start : new Date(slot.start);
        const e = (slot.end instanceof Date) ? slot.end : new Date(slot.end);
        const slotStart = s.getHours() * 60 + s.getMinutes();
        const slotEnd = e.getHours() * 60 + e.getMinutes();
        // Overlap test: (blockStart < slotEnd) && (blockStart + 1 > slotStart)
        if (startMin < slotEnd && (startMin + 1) > slotStart) {
            return i;
        }
    }
    return -1;
}

/** Renders the "Staggered" (YKLI) view */
function renderStaggeredView(container) {
    container.innerHTML = "";

    const availableDivisions = window.availableDivisions || [];
    const divisions = window.divisions || {};

    const dailyData = (typeof window.loadCurrentDailyData === 'function') ? (window.loadCurrentDailyData() || {}) : {};
    // Read the same skeleton the optimizer used
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
    const tr2 = document.createElement("tr"); // Column titles (Time, Bunk 1...)

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
        // Unique by both time label and event name
        blocksByDivision[div] = divBlocks.filter((block, index, self) =>
            index === self.findIndex((t) => (t.label === block.label && t.event === block.event))
        );
    });

    // --- "Flatten" split blocks into halves ---
    const splitBlocksByDivision = {};
    let maxEvents = 0;

    availableDivisions.forEach(div => {
        const flattenedBlocks = [];
        const originalBlocks = blocksByDivision[div] || [];

        originalBlocks.forEach(block => {
            if (block.type === 'split' && block.startMin != null && block.endMin != null) {
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
        splitBlocksByDivision[div] = flattenedBlocks;
        if (flattenedBlocks.length > maxEvents) maxEvents = flattenedBlocks.length;
    });

    // --- Render rows, one per event index ---
    for (let i = 0; i < maxEvents; i++) {
        const tr = document.createElement("tr");
        
        availableDivisions.forEach(div => {
            const bunks = divisions[div]?.bunks || [];
            const blocks = splitBlocksByDivision[div] || []; 
            const eventBlock = blocks[i];
            
            // 1) TIME cell
            const tdTime = document.createElement("td");
            tdTime.style.border = "1px solid #ccc";
            tdTime.style.verticalAlign = "top";
            if (eventBlock) {
                tdTime.textContent = eventBlock.label; 
            } else {
                tdTime.className = "grey-cell";
            }
            tr.appendChild(tdTime);

            // 2) ACTIVITY cells (merged for leagues)
            if (eventBlock && (eventBlock.event === 'League Game' || eventBlock.event === 'Specialty League')) {
                const tdLeague = document.createElement("td");
                tdLeague.colSpan = bunks.length;
                tdLeague.style.verticalAlign = "top";
                tdLeague.style.textAlign = "left";
                tdLeague.style.padding = "5px 8px";
                tdLeague.style.background = "#e8f5e9";
                
                const firstSlotIndex = findFirstSlotForTime(eventBlock.startMin);
                
                if (eventBlock.event === 'Specialty League') {
                    // Group by field
                    const gamesByField = new Map();
                    if (firstSlotIndex !== -1) {
                        const uniqueMatchups = new Set(); 
                        bunks.forEach(bunk => {
                            const entry = getEntry(bunk, firstSlotIndex);
                            if (entry && entry._h2h && entry.sport) {
                                if (!uniqueMatchups.has(entry.sport)) {
                                    uniqueMatchups.add(entry.sport);
                                    const field = fieldLabel(entry.field);
                                    if (!gamesByField.has(field)) gamesByField.set(field, []);
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
                        html += `<div style="margin-bottom: 2px;"><strong>${matchupNames.join(', ')}</strong> - ${field}</div>`;
                    });
                    if (gamesByField.size > 0) { html += '</div>'; }
                    tdLeague.innerHTML = html;

                } else {
                    // Regular leagues (list)
                    const games = new Map();
                    if (firstSlotIndex !== -1) {
                        bunks.forEach(bunk => {
                            const entry = getEntry(bunk, firstSlotIndex);
                            if (entry && entry._h2h && entry.sport) {
                                games.set(entry.sport, fieldLabel(entry.field));
                            }
                        });
                    }
                    let html = '<ul style="margin: 0; padding-left: 18px;">';
                    if (games.size === 0) html = '<p class="muted" style="margin:0; padding: 4px;">Leagues</p>';
                    games.forEach((field, matchup) => {
                        html += `<li>${matchup} @ ${field}</li>`;
                    });
                    if (games.size > 0) { html += '</ul>'; }
                    tdLeague.innerHTML = html;
                }
                tr.appendChild(tdLeague);

            } else {
                // Regular / split games: individual bunk cells
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
        if (typeof window.saveCurrentDailyData === 'function') {
            window.saveCurrentDailyData("scheduleAssignments", window.scheduleAssignments);
            window.saveCurrentDailyData("leagueAssignments", window.leagueAssignments);
            window.saveCurrentDailyData("unifiedTimes", window.unifiedTimes);
        }
    } catch (e) {
        // no-op
    }
}

function reconcileOrRenderSaved() {
    try {
        const data = (typeof window.loadCurrentDailyData === 'function') ? (window.loadCurrentDailyData() || {}) : {};
        window.scheduleAssignments = data.scheduleAssignments || {};
        window.leagueAssignments = data.leagueAssignments || {};
        const savedTimes = data.unifiedTimes || [];
        window.unifiedTimes = savedTimes.map(slot => ({
            ...slot,
            start: (slot.start instanceof Date) ? slot.start : new Date(slot.start),
            end: (slot.end instanceof Date) ? slot.end : new Date(slot.end)
        }));
    } catch (e) {
        window.scheduleAssignments = {};
        window.leagueAssignments = {};
        window.unifiedTimes = [];
    }
    updateTable();
}

function initScheduleSystem() {
    try {
        if (!window.scheduleAssignments) window.scheduleAssignments = {};
        if (!window.leagueAssignments) window.leagueAssignments = {};
        reconcileOrRenderSaved();
    } catch (e) {
        updateTable();
    }
}

// ===== Exports =====
window.updateTable = updateTable;
window.initScheduleSystem = initScheduleSystem;
window.saveSchedule = saveSchedule;

})();
