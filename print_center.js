// =================================================================
// print_center.js
//
// Handles generating printable schedules.
// Features:
// - Print Whole Schedule (All Divisions) - Layout matches Daily View
// - Print Selected Divisions (Multi-select)
// - Print Selected Bunks (Multi-select) - Natural Sort & Excel
// - Print Selected Locations (Multi-select) - Excel Export
// - UPDATED: Bunk view shows FULL league schedule (all matchups).
// - UPDATED: Field view shows ONLY the specific matchup on that field.
// =================================================================

(function() {
'use strict';

// --- Helpers Copied/Adapted from scheduler_ui.js for consistency ---
const INCREMENT_MINS = 30;

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
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  if (mer) {
    if (hh === 12) hh = mer === "am" ? 0 : 12;
    else if (mer === "pm") hh += 12;
  }
  return hh * 60 + mm;
}

function minutesToTimeLabel(min) {
  let h = Math.floor(min / 60);
  let m = min % 60;
  let ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, '0')} ${ap}`;
}

function findFirstSlotForTime(startMin) {
  const times = window.unifiedTimes || [];
  if (startMin === null || !times.length) return -1;
  for (let i = 0; i < times.length; i++) {
    const slot = times[i];
    const slotStart = new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes();
    if (slotStart >= startMin && slotStart < startMin + INCREMENT_MINS) {
      return i;
    }
  }
  return -1;
}

function getEntry(bunk, slotIndex) {
  const assignments = window.scheduleAssignments || {};
  if (bunk && assignments[bunk] && assignments[bunk][slotIndex]) {
    return assignments[bunk][slotIndex];
  }
  return null;
}

function formatEntry(entry) {
  if (!entry) return "";
  if (entry._isDismissal) return "Dismissal";
  if (entry._isSnack) return "Snacks";
  
  let label = "";
  if (typeof entry.field === 'string') label = entry.field;
  else if (entry.field && entry.field.name) label = entry.field.name;

  if (entry._h2h) return entry.sport || "League Game";
  if (entry._fixed) return label || entry._activity || "";
  if (entry.sport) return `${label} – ${entry.sport}`;
  return label;
}

// Natural Sort Helper
function naturalSort(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

// -------------------------------------------------------------------

function initPrintCenter() {
    const container = document.getElementById("print-content");
    if (!container) return;

    container.innerHTML = `
        <div class="print-dashboard">
            <h1 style="color:#1a5fb4;">🖨️ Print Center</h1>
            <p class="no-print">Select what you want to print or export. The "Master Schedule" views now look exactly like the Daily Schedule screen.</p>

            <div class="print-cards no-print">
                
                <div class="print-card">
                    <h3>📅 Master Schedule</h3>
                    <p>Print grid views for divisions.</p>
                    
                    <div style="display:flex; gap:10px; margin-bottom:15px;">
                        <button onclick="window.printAllDivisions()" style="background:#28a745; flex:1;">Print All</button>
                        <button onclick="window.exportAllDivisionsToExcel()" style="background:#217346; flex:1;">Export to Excel</button>
                    </div>

                    <hr style="border-top:1px solid #ddd; margin:10px 0;">
                    
                    <label style="font-weight:bold; display:block; margin-bottom:5px;">Or Select Specific Divisions:</label>
                    <div id="print-div-list" class="print-list-box"></div>
                    <div style="display:flex; gap:10px;">
                        <button onclick="window.printSelectedDivisions()" style="flex:1;">Print Selected</button>
                        <button onclick="window.exportSelectedDivisionsToExcel()" style="background:#217346; flex:1;">Export Selected</button>
                    </div>
                </div>

                <div class="print-card">
                    <h3>👤 Individual Bunks</h3>
                    <p>Print list views for specific bunks.</p>
                    <div id="print-bunk-list" class="print-list-box"></div>
                    <div style="display:flex; gap:10px;">
                        <button onclick="window.printSelectedBunks()" style="flex:1;">Print Selected</button>
                        <button onclick="window.exportSelectedBunksToExcel()" style="background:#217346; flex:1;">Export to Excel</button>
                    </div>
                </div>

                <div class="print-card">
                    <h3>📍 Locations / Fields</h3>
                    <p>Print schedules for specific fields.</p>
                    <div id="print-loc-list" class="print-list-box"></div>
                    <div style="display:flex; gap:10px;">
                        <button onclick="window.printSelectedLocations()" style="flex:1;">Print Selected</button>
                        <button onclick="window.exportSelectedLocationsToExcel()" style="background:#217346; flex:1;">Export to Excel</button>
                    </div>
                </div>
            </div>

            <div id="printable-area"></div>
        </div>
        
        <style>
            .print-list-box {
                max-height: 200px;
                overflow-y: auto;
                border: 1px solid #ccc;
                padding: 10px;
                background: white;
                margin-bottom: 10px;
                border-radius: 4px;
            }
            .print-list-group {
                font-weight: bold;
                margin-top: 5px;
                margin-bottom: 3px;
                color: #555;
                background: #eee;
                padding: 2px 5px;
            }
            .print-list-item {
                display: block;
                margin-left: 5px;
                margin-bottom: 2px;
            }
        </style>
    `;

    populateSelectors();
}

function populateSelectors() {
    const divList = document.getElementById("print-div-list");
    const bunkList = document.getElementById("print-bunk-list");
    const locList = document.getElementById("print-loc-list");
    
    const app1 = window.loadGlobalSettings?.().app1 || {};
    const divisions = app1.divisions || {};
    const availableDivisions = app1.availableDivisions || [];
    const fields = app1.fields || [];
    const specials = app1.specialActivities || [];
    
    // 1. Divisions Checkboxes
    divList.innerHTML = "";
    availableDivisions.forEach(divName => {
        divList.innerHTML += `<label class="print-list-item"><input type="checkbox" value="${divName}"> ${divName}</label>`;
    });

    // 2. Bunks Checkboxes (Grouped by Division)
    bunkList.innerHTML = "";
    availableDivisions.forEach(divName => {
        const bunks = (divisions[divName].bunks || []).sort(naturalSort);
        if (bunks.length > 0) {
            bunkList.innerHTML += `<div class="print-list-group">${divName}</div>`;
            bunks.forEach(b => {
                bunkList.innerHTML += `<label class="print-list-item"><input type="checkbox" value="${b}"> ${b}</label>`;
            });
        }
    });

    // 3. Locations Checkboxes
    locList.innerHTML = "";
    const allLocs = [...fields.map(f=>f.name), ...specials.map(s=>s.name)].sort(naturalSort);
    allLocs.forEach(loc => {
        locList.innerHTML += `<label class="print-list-item"><input type="checkbox" value="${loc}"> ${loc}</label>`;
    });
}

// --- GENERATORS ---

/**
 * Generates the HTML for a Division using the "Daily View" logic (Timeline Blocks).
 */
function generateDivisionHTML(divName) {
    const daily = window.loadCurrentDailyData?.() || {};
    const manualSkeleton = daily.manualSkeleton || [];
    const divisions = window.loadGlobalSettings?.().app1.divisions || {};
    const bunks = (divisions[divName]?.bunks || []).sort(naturalSort);

    if (bunks.length === 0) return "";

    // --- 1. Build Blocks Logic (Ported from scheduler_ui.js) ---
    const tempSortedBlocks = [];
    manualSkeleton.forEach(item => {
        if (item.division === divName) {
            const startMin = parseTimeToMinutes(item.startTime);
            const endMin = parseTimeToMinutes(item.endTime);
            if (startMin === null || endMin === null) return;
            tempSortedBlocks.push({ item, startMin, endMin });
        }
    });
    tempSortedBlocks.sort((a, b) => a.startMin - b.startMin);

    const divisionBlocks = [];
    let leagueCounter = 0; 
    let specialtyCounter = 0;

    tempSortedBlocks.forEach(block => {
        let eventName = block.item.event;
        if (block.item.event === "League Game") {
            leagueCounter++;
            eventName = `League Game ${leagueCounter}`;
        } else if (block.item.event === "Specialty League") {
            specialtyCounter++;
            eventName = `Specialty League ${specialtyCounter}`;
        }

        divisionBlocks.push({
            label: `${minutesToTimeLabel(block.startMin)} - ${minutesToTimeLabel(block.endMin)}`,
            startMin: block.startMin,
            endMin: block.endMin,
            event: eventName,
            type: block.item.type
        });
    });

    // Filter duplicates and handle splits
    const uniqueBlocks = divisionBlocks.filter((block, index, self) => 
        index === self.findIndex((t) => t.label === block.label)
    );

    const flattenedBlocks = [];
    uniqueBlocks.forEach((block) => {
        if (block.type === "split" && block.startMin !== null && block.endMin !== null) {
            const midMin = Math.round(block.startMin + (block.endMin - block.startMin) / 2);
            flattenedBlocks.push({
                ...block,
                label: `${minutesToTimeLabel(block.startMin)} - ${minutesToTimeLabel(midMin)}`,
                startMin: block.startMin,
                endMin: midMin,
                splitPart: 1
            });
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

    // --- 2. Build HTML Table ---
    let html = `
        <div class="print-page landscape">
            <div class="print-header">
                <h2>📅 ${divName} Schedule</h2>
                <p>Date: ${window.currentScheduleDate}</p>
            </div>
            <table class="print-table grid-table">
                <thead>
                    <tr>
                        <th style="width:130px;">Time</th>
                        ${bunks.map(b => `<th>${b}</th>`).join('')}
                    </tr>
                </thead>
                <tbody>
    `;

    if (flattenedBlocks.length === 0) {
        html += `<tr><td colspan="${bunks.length + 1}" style="text-align:center; padding:20px;">No schedule blocks found.</td></tr>`;
    }

    flattenedBlocks.forEach(eventBlock => {
        html += `<tr>`;
        // Time Cell
        html += `<td class="time-col"><strong>${eventBlock.label}</strong></td>`;

        // Activity Cells
        const isLeague = eventBlock.event.startsWith("League Game") || eventBlock.event.startsWith("Specialty League");
        
        if (isLeague) {
            // --- Merged Cell for League ---
            // Calculate matchups
            const firstSlotIndex = findFirstSlotForTime(eventBlock.startMin);
            let allMatchups = [];
            if (bunks.length > 0) {
                const entry = getEntry(bunks[0], firstSlotIndex);
                if (entry && entry._allMatchups) allMatchups = entry._allMatchups;
            }

            let cellContent = `<strong>${eventBlock.event}</strong>`;
            if (allMatchups.length > 0) {
                cellContent += `<ul style="margin:0; padding-left:15px; text-align:left; font-size:0.9em;">`;
                allMatchups.forEach(m => cellContent += `<li>${m}</li>`);
                cellContent += `</ul>`;
            } else {
                cellContent += `<br><em>(No matchups found)</em>`;
            }

            html += `<td colspan="${bunks.length}" style="background:#e8f4ff; vertical-align:top; text-align:left;">${cellContent}</td>`;

        } else {
            // --- Standard Cells ---
            bunks.forEach(bunk => {
                const slotIndex = findFirstSlotForTime(eventBlock.startMin);
                const entry = getEntry(bunk, slotIndex);
                let text = "";
                let bg = "";

                if (entry) {
                    text = formatEntry(entry);
                    if (entry._fixed) bg = "#fff8e1"; // pinned color
                } else {
                    // Fallback to the block name if nothing is scheduled yet (e.g. "Lunch")
                    if (["Lunch","Snack","Dismissal","Swim"].some(k => eventBlock.event.includes(k))) {
                        text = eventBlock.event;
                        bg = "#fff8e1";
                    }
                }
                
                html += `<td style="background:${bg};">${text}</td>`;
            });
        }
        html += `</tr>`;
    });

    html += `</tbody></table></div><div class="page-break"></div>`;
    return html;
}

// --- 2. Individual Bunk HTML ---
function generateBunkHTML(bunk) {
    const daily = window.loadCurrentDailyData?.() || {};
    const schedule = daily.scheduleAssignments?.[bunk] || [];
    const times = window.unifiedTimes || [];

    let html = `
        <div class="print-page portrait">
            <div class="print-header">
                <h2>👤 Schedule: ${bunk}</h2>
                <p>Date: ${window.currentScheduleDate}</p>
            </div>
            <table class="print-table">
                <thead><tr><th style="width:120px;">Time</th><th>Activity / Location</th></tr></thead>
                <tbody>
    `;

    times.forEach((t, i) => {
        const entry = schedule[i];
        if (!entry || entry.continuation) return; 

        let label = "";
        if (typeof entry.field === 'object') label = entry.field.name;
        else label = entry.field;
        
        // --- NEW: SHOW FULL LEAGUE SCHEDULE ---
        // If it's a league game, we want to see ALL matchups occurring in that block
        if (entry._h2h) {
            if (entry._allMatchups && entry._allMatchups.length > 0) {
                label = `<strong>${entry.sport || "League Game"}</strong><br>`;
                label += `<ul style="margin:5px 0 0 15px; padding:0; font-size:0.9em; color:#555;">`;
                entry._allMatchups.forEach(m => {
                    // Highlight own game? Optional.
                    if (entry.sport && m === entry.sport) {
                         label += `<li><strong>${m}</strong></li>`;
                    } else {
                         label += `<li>${m}</li>`;
                    }
                });
                label += `</ul>`;
            } else {
                // Fallback if no list
                label = `<strong>${entry.sport}</strong>`;
            }
        }

        html += `<tr>
            <td class="time-col"><strong>${t.label}</strong></td>
            <td>${label}</td>
        </tr>`;
    });

    html += `</tbody></table></div>`;
    return html;
}

// --- 3. Location HTML ---
function generateLocationHTML(loc) {
    const daily = window.loadCurrentDailyData?.() || {};
    const times = window.unifiedTimes || [];
    const assignments = daily.scheduleAssignments || {};

    let html = `
        <div class="print-page portrait">
            <div class="print-header">
                <h2>📍 Schedule: ${loc}</h2>
                <p>Date: ${window.currentScheduleDate}</p>
            </div>
            <table class="print-table">
                <thead><tr><th style="width:120px;">Time</th><th>Event / Bunks</th></tr></thead>
                <tbody>
    `;

    times.forEach((t, i) => {
        const bunksHere = [];
        let leagueLabel = null;

        Object.keys(assignments).forEach(b => {
            const entry = assignments[b][i];
            if (entry) {
                const fName = (typeof entry.field === 'object') ? entry.field.name : entry.field;
                if (fName === loc) {
                    if(!bunksHere.includes(b)) bunksHere.push(b);
                    
                    // Check for league matchup label
                    if (entry._h2h && entry.sport) {
                        // For fields, we ONLY want the specific game being played here.
                        // The scheduler ensures entry.sport has the right label if assigned to this field.
                        let matchStr = entry.sport; 
                        // matchStr is usually "A vs B (Sport) @ Field"
                        // We can strip "@ Field" since we are on the field page
                        if(matchStr.includes('@')) matchStr = matchStr.split('@')[0].trim();
                        
                        leagueLabel = matchStr;
                    }
                }
            }
        });

        let content = "";
        let style = "";

        if (leagueLabel) {
            content = `<strong>${leagueLabel}</strong>`;
        } else if (bunksHere.length > 0) {
            content = bunksHere.join(", ");
        } else {
            content = "-- Free --";
            style = "color:#999; font-style:italic;";
        }

        html += `<tr>
            <td class="time-col"><strong>${t.label}</strong></td>
            <td style="${style}">${content}</td>
        </tr>`;
    });

    html += `</tbody></table></div>`;
    return html;
}

// --- ACTIONS ---

function getSelectedDivisions() {
    const checkboxes = document.querySelectorAll("#print-div-list input:checked");
    return Array.from(checkboxes).map(cb => cb.value);
}

function getSelectedBunks() {
    const checkboxes = document.querySelectorAll("#print-bunk-list input:checked");
    return Array.from(checkboxes).map(cb => cb.value);
}

function getSelectedLocations() {
    const checkboxes = document.querySelectorAll("#print-loc-list input:checked");
    return Array.from(checkboxes).map(cb => cb.value);
}

window.printAllDivisions = function() {
    const app1 = window.loadGlobalSettings?.().app1 || {};
    const allDivs = app1.availableDivisions || [];
    if (allDivs.length === 0) return alert("No divisions found.");
    
    let fullHtml = "";
    allDivs.forEach(div => { fullHtml += generateDivisionHTML(div); });
    triggerPrint(fullHtml);
};

window.printSelectedDivisions = function() {
    const selected = getSelectedDivisions();
    if (selected.length === 0) return alert("Please select at least one division.");

    let fullHtml = "";
    selected.forEach(div => { fullHtml += generateDivisionHTML(div); });
    triggerPrint(fullHtml);
};

window.printSelectedBunks = function() {
    const selected = getSelectedBunks();
    if (selected.length === 0) return alert("Please select at least one bunk.");

    let fullHtml = "";
    selected.forEach(bunk => { fullHtml += generateBunkHTML(bunk); });
    triggerPrint(fullHtml);
};

window.printSelectedLocations = function() {
    const selected = getSelectedLocations();
    if (selected.length === 0) return alert("Please select at least one location.");

    let fullHtml = "";
    selected.forEach(loc => { fullHtml += generateLocationHTML(loc); });
    triggerPrint(fullHtml);
};

// --- EXPORT TO EXCEL ---

function downloadXLS(htmlContent, fileName) {
    const blob = new Blob(['<html xmlns:x="urn:schemas-microsoft-com:office:excel">' + htmlContent + '</html>'], { type: 'application/vnd.ms-excel' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

window.exportAllDivisionsToExcel = function() {
    const app1 = window.loadGlobalSettings?.().app1 || {};
    const allDivs = app1.availableDivisions || [];
    if (allDivs.length === 0) return alert("No divisions found.");

    let fullHtml = "";
    allDivs.forEach(div => fullHtml += generateDivisionHTML(div));
    downloadXLS(fullHtml, `Schedule_All_${window.currentScheduleDate}.xls`);
};

window.exportSelectedDivisionsToExcel = function() {
    const selected = getSelectedDivisions();
    if (selected.length === 0) return alert("Please select at least one division.");

    let fullHtml = "";
    selected.forEach(div => fullHtml += generateDivisionHTML(div));
    downloadXLS(fullHtml, `Schedule_Divisions_${window.currentScheduleDate}.xls`);
};

window.exportSelectedBunksToExcel = function() {
    const selected = getSelectedBunks();
    if (selected.length === 0) return alert("Please select at least one bunk.");

    let fullHtml = "";
    selected.forEach(bunk => fullHtml += generateBunkHTML(bunk));
    downloadXLS(fullHtml, `Schedule_Bunks_${window.currentScheduleDate}.xls`);
};

window.exportSelectedLocationsToExcel = function() {
    const selected = getSelectedLocations();
    if (selected.length === 0) return alert("Please select at least one location.");

    let fullHtml = "";
    selected.forEach(loc => fullHtml += generateLocationHTML(loc));
    downloadXLS(fullHtml, `Schedule_Locations_${window.currentScheduleDate}.xls`);
};

function triggerPrint(content) {
    const area = document.getElementById("printable-area");
    area.innerHTML = content;
    window.print();
}

window.initPrintCenter = initPrintCenter;

})();
