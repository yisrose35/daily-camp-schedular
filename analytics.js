
// =================================================================
// analytics.js
//
// --- UPDATED (MAJOR REFACTOR) ---
// - Renamed "Rotation Report" to "Report".
// - `initRotationReport` is now `initReportTab`.
// - `initReportTab` creates a dropdown to select one of two reports:
//   1. "Bunk Rotation Report" (the original report).
//   2. "Field Availability Grid" (the new report).
// - Both reports are hidden by default, per your request.
//
// - **NEW:** `renderBunkRotationUI` contains the UI logic for
//   the original rotation report.
// - **NEW:** `renderFieldAvailabilityGrid` builds the new
//   grid you specified, showing `✓` (Available) or `X` (Used/Unavailable).
// =================================================================

(function() {
'use strict';

// --- Copied Helpers (needed for Field Availability) ---
function parseTimeToMinutes(str) {
  if (!str || typeof str !== "string") return null;
  let s = str.trim().toLowerCase();
  let mer = null;
  if (s.endsWith("am") || s.endsWith("pm")) {
    mer = s.endsWith("am") ? "am" : "pm";
    s = s.replace(/am|pm/g, "").trim();
  } else {
    return null; // REQUIRE am/pm
  }
  
  const m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (Number.isNaN(hh) || Number.isNaN(mm) || mm < 0 || mm > 59) return null;
  if (mer) {
    if (hh === 12) hh = mer === "am" ? 0 : 12; 
    else if (mer === "pm") hh += 12; 
  }
  return hh * 60 + mm;
}

function fieldLabel(f) {
    if (typeof f === "string") return f;
    if (f && typeof f === "object" && typeof f.name === "string") return f.name;
    return "";
}

/**
 * Checks if a field is available for a specific time slot,
 * respecting the new timeRules array.
 * (Copied from scheduler_logic_fillers.js)
 */
function isTimeAvailable(slotIndex, fieldProps) {
    if (!window.unifiedTimes || !window.unifiedTimes[slotIndex]) return false;
    
    const slot = window.unifiedTimes[slotIndex];
    const slotStartMin = new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes();
    const slotEndMin = slotStartMin + (window.INCREMENT_MINS || 30); 
    
    const rules = fieldProps.timeRules || [];
    
    if (rules.length === 0) {
        return fieldProps.available;
    }
    
    if (!fieldProps.available) {
        return false;
    }

    const hasAvailableRules = rules.some(r => r.type === 'Available');
    let isAvailable = !hasAvailableRules;

    for (const rule of rules) {
        if (rule.type === 'Available') {
            if (slotStartMin >= rule.startMin && slotEndMin <= rule.endMin) {
                isAvailable = true;
                break;
            }
        }
    }

    for (const rule of rules) {
        if (rule.type === 'Unavailable') {
            if (slotStartMin < rule.endMin && slotEndMin > rule.startMin) {
                isAvailable = false;
                break;
            }
        }
    }
    
    return isAvailable;
}
// --- End of Copied Helpers ---


let container = null;
let allActivities = []; // For Bunk Report
let divisions = {};
let availableDivisions = [];

// Keep track of DOM elements
let divisionSelect = null;
let bunkSelect = null;
let rotationReportContainer = null;
let availabilityReportContainer = null;

/**
 * --- NEW: Main entry point, called by index.html tab click ---
 */
function initReportTab() {
    container = document.getElementById("report-content");
    if (!container) return;

    // 1. Build the new navigation UI
    container.innerHTML = `
        <div class="league-nav"> <label for="report-view-select">Select Report:</label>
            <select id="report-view-select">
                <option value="">-- Select View --</option>
                <option value="rotation">Bunk Rotation Report</option>
                <option value="availability">Field Availability Grid</option>
            </select>
        </div>
        
        <div id="report-rotation-content" class="league-content-pane">
            </div>
        <div id="report-availability-content" class="league-content-pane">
            </div>
    `;

    // 2. Get references
    rotationReportContainer = document.getElementById("report-rotation-content");
    availabilityReportContainer = document.getElementById("report-availability-content");

    // 3. Render the (hidden) content for both panes
    renderBunkRotationUI();
    renderFieldAvailabilityGrid();

    // 4. Hook up the dropdown
    document.getElementById("report-view-select").onchange = (e) => {
        const selected = e.target.value;
        if (selected === 'rotation') {
            rotationReportContainer.classList.add("active");
            availabilityReportContainer.classList.remove("active");
        } else if (selected === 'availability') {
            rotationReportContainer.classList.remove("active");
            availabilityReportContainer.classList.add("active");
        } else {
            rotationReportContainer.classList.remove("active");
            availabilityReportContainer.classList.remove("active");
        }
    };
}

// =================================================================
// --- 1. BUNK ROTATION REPORT (Original Report) ---
// =================================================================

/**
 * --- NEW: Renders the Bunk Rotation Report UI ---
 * (This is the old initRotationReport, refactored)
 */
function renderBunkRotationUI() {
    // 1. Load the data we need
    loadMasterData();
    
    // 2. Build the UI
    rotationReportContainer.innerHTML = `
        <h2 class="report-title">Bunk Rotation Report</h2>
        <p>See how many times each bunk has done a "regular" (non-league, non-pinned) activity in the past 7 days.</p>
        
        <div class="report-controls">
            <div>
                <label for="report-division-select">1. Select a Division:</label>
                <select id="report-division-select" class="report-select"></select>
            </div>
            <div>
                <label for="report-bunk-select">2. Select a Bunk (Optional):</label>
                <select id="report-bunk-select" class="report-select" disabled></select>
            </div>
        </div>
        
        <div id="report-table-container" class="report-container">
            <p class="report-muted">Please select a division to view its report.</p>
        </div>
    `;
    
    // 3. Get element references
    divisionSelect = document.getElementById("report-division-select");
    bunkSelect = document.getElementById("report-bunk-select");
    reportContainer = document.getElementById("report-table-container"); // This is the inner container

    // 4. Populate the division dropdown
    let divOptions = '<option value="">-- Select a division --</option>';
    availableDivisions.forEach(divName => {
        divOptions += `<option value="${divName}">${divName}</option>`;
    });
    divisionSelect.innerHTML = divOptions;
    
    // 5. Hook up event listeners
    divisionSelect.onchange = onDivisionSelect;
    bunkSelect.onchange = onBunkSelect;
}

/**
 * Loads the master list of all bunks and activities
 */
function loadMasterData() {
    const app1Data = window.loadGlobalSettings?.().app1 || {};
    
    // Get division and bunk structure
    divisions = window.divisions || {};
    availableDivisions = (window.availableDivisions || []).sort();
    
    // Get all activities (fields + specials)
    const fields = app1Data.fields || [];
    const specials = app1Data.specialActivities || [];
    
    // We only care about sports/activities that can be *in* a rotation
    const sportActivities = fields.flatMap(f => f.activities || []);
    const specialActivities = specials.map(s => s.name);
    
    allActivities = Array.from(new Set([...sportActivities, ...specialActivities])).sort();
}

/**
 * Handles when the user selects a division.
 */
function onDivisionSelect() {
    const divName = divisionSelect.value;
    reportContainer.innerHTML = ""; // Clear old report
    
    if (!divName) {
        bunkSelect.innerHTML = "";
        bunkSelect.disabled = true;
        reportContainer.innerHTML = `<p class="report-muted">Please select a division to view its report.</p>`;
        return;
    }
    
    const bunksInDiv = (divisions[divName]?.bunks || []).sort();
    let bunkOptions = `<option value="">--- Show All ${divName} Bunks ---</option>`;
    bunksInDiv.forEach(bunk => {
        bunkOptions += `<option value="${bunk}">${bunk}</option>`;
    });
    bunkSelect.innerHTML = bunkOptions;
    bunkSelect.disabled = false;
    
    renderDivisionReport(divName, bunksInDiv);
}

/**
 * Handles when the user selects a specific bunk.
 */
function onBunkSelect() {
    const bunkName = bunkSelect.value;
    const divName = divisionSelect.value;
    
    if (!bunkName) {
        const bunksInDiv = (divisions[divName]?.bunks || []).sort();
        renderDivisionReport(divName, bunksInDiv);
    } else {
        renderBunkReport(bunkName, reportContainer, true);
    }
}

/**
 * Renders a report for ALL bunks in a division.
 */
function renderDivisionReport(divName, bunks) {
    reportContainer.innerHTML = ""; // Clear container
    
    if (bunks.length === 0) {
        reportContainer.innerHTML = `<p class="report-muted">No bunks found in ${divName}.</p>`;
        return;
    }
    
    const history = window.loadScheduleHistory(7);

    bunks.forEach(bunkName => {
        const bunkHeader = document.createElement('h3');
        bunkHeader.textContent = bunkName;
        bunkHeader.className = "report-bunk-header";
        
        const tableDiv = document.createElement('div');
        tableDiv.className = "report-bunk-table-wrapper";
        
        reportContainer.appendChild(bunkHeader);
        reportContainer.appendChild(tableDiv);
        
        renderBunkReport(bunkName, tableDiv, false, history);
    });
}


/**
 * Renders the report table for a SINGLE bunk.
 */
function renderBunkReport(bunkName, targetContainer, clearContainer = true, preloadedHistory = null) {
    if (clearContainer) {
        targetContainer.innerHTML = `<p class="report-loading">Loading report for ${bunkName}...</p>`;
    }

    const history = preloadedHistory || window.loadScheduleHistory(7);
    const historyDays = Object.keys(history).sort().reverse();
    
    const report = {};
    allActivities.forEach(act => {
        report[act] = {
            count: 0,
            lastDone: "7+ days ago"
        };
    });

    for (let i = 0; i < historyDays.length; i++) {
        const day = historyDays[i];
        const daySchedule = history[day][bunkName] || [];
        const daysAgo = i + 1;

        daySchedule.forEach(entry => {
            if (!entry) return;
            if (entry._h2h || entry._fixed || !entry.sport) {
                return;
            }
            
            let activityName = entry._activity;
            if (!activityName) {
                if (allActivities.includes(entry.sport)) activityName = entry.sport;
                else if (allActivities.includes(entry.field)) activityName = entry.field;
            }
            
            if (activityName && report[activityName]) {
                report[activityName].count++;
                
                if (report[activityName].lastDone === "7+ days ago") {
                    report[activityName].lastDone = (daysAgo === 1) ? "1 day ago" : `${daysAgo} days ago`;
                }
            }
        });
    }
    
    let tableHtml = `
        <table class="report-table">
            <thead>
                <tr>
                    <th>Activity</th>
                    <th>Times (Last 7 Days)</th>
                    <th>Last Done</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    const sortedActivities = allActivities.sort((a, b) => {
        if (report[a].count !== report[b].count) {
            return report[a].count - report[b].count; 
        }
        return a.localeCompare(b); 
    });
    
    sortedActivities.forEach(actName => {
        const data = report[actName];
        const isFresh = data.count === 0;
        const rowClass = isFresh ? "report-row-fresh" : "";
        
        tableHtml += `
            <tr class="${rowClass}">
                <td>${actName} ${isFresh ? '🌟' : ''}</td>
                <td>${data.count}</td>
                <td>${data.lastDone}</td>
            </tr>
        `;
    });
    
    tableHtml += `</tbody></table>`;
    targetContainer.innerHTML = tableHtml;
}


/**
 * Helper: Loads the last N days of schedule data for analysis
 */
window.loadScheduleHistory = function(daysToLoad) {
    const allData = window.loadAllDailyData?.() || {};
    const today = new Date(window.currentScheduleDate);
    const history = {};
    
    for (let i = 1; i <= daysToLoad; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const dayStr = String(d.getDate()).padStart(2, '0');
        const dateKey = `${y}-${m}-${dayStr}`;
        
        if (allData[dateKey] && allData[dateKey].scheduleAssignments) {
            history[dateKey] = allData[dateKey].scheduleAssignments;
        }
    }
    return history;
}

// =================================================================
// --- 2. FIELD AVAILABILITY GRID (New Report) ---
// =================================================================

/**
 * --- NEW: Renders the Field Availability Grid ---
 */
function renderFieldAvailabilityGrid() {
    availabilityReportContainer.innerHTML = ""; // Clear
    
    // 1. Load Data
    const dailyData = window.loadCurrentDailyData?.() || {};
    const scheduleAssignments = dailyData.scheduleAssignments || {};
    const unifiedTimes = dailyData.unifiedTimes || [];

    if (unifiedTimes.length === 0) {
        availabilityReportContainer.innerHTML = `<p class="report-muted">No schedule has been generated for this day. Please go to the "Daily Adjustments" tab and click "Run Optimizer" first.</p>`;
        return;
    }

    const app1Data = window.loadGlobalSettings?.().app1 || {};
    const allFields = app1Data.fields || [];
    const allSpecials = app1Data.specialActivities || [];
    const allResources = [...allFields, ...allSpecials].sort((a,b) => a.name.localeCompare(b.name));

    // 2. Compile Field Usage
    const fieldUsageBySlot = {}; // { slotIndex: { fieldName: count } }
    for (const bunk in scheduleAssignments) {
        const schedule = scheduleAssignments[bunk] || [];
        for (let i = 0; i < schedule.length; i++) {
            const entry = schedule[i];
            // We only count non-continuing, non-fixed, non-league entries
            if (entry && !entry.continuation && !entry._fixed && !entry._h2h) {
                const fieldName = fieldLabel(entry.field);
                if (fieldName && fieldName !== "Free" && fieldName !== "No Field") {
                    fieldUsageBySlot[i] = fieldUsageBySlot[i] || {};
                    fieldUsageBySlot[i][fieldName] = (fieldUsageBySlot[i][fieldName] || 0) + 1;
                }
            }
        }
    }

    // 3. Compile Field Properties
    const fieldProperties = {};
    allResources.forEach(f => {
        const rules = (f.timeRules || []).map(r => {
            const startMin = parseTimeToMinutes(r.start);
            const endMin = parseTimeToMinutes(r.end);
            if (startMin == null || endMin == null) return null;
            return { type: r.type, startMin: startMin, endMin: endMin };
        }).filter(Boolean);

        fieldProperties[f.name] = {
            available: f.available !== false,
            sharable: f.sharableWith?.type === 'all' || f.sharableWith?.type === 'custom',
            timeRules: rules
        };
    });

    // 4. Build the Grid
    let tableHtml = `<div class="schedule-view-wrapper"> `;
    tableHtml += `<table class="availability-grid"><thead><tr><th>Time</th>`;
    
    allResources.forEach(r => {
        tableHtml += `<th>${r.name}</th>`;
    });
    tableHtml += `</tr></thead><tbody>`;

    unifiedTimes.forEach((slot, i) => {
        const timeLabel = slot.label || `${new Date(slot.start).toLocaleTimeString()} - ${new Date(slot.end).toLocaleTimeString()}`;
        tableHtml += `<tr><td>${timeLabel}</td>`;

        allResources.forEach(r => {
            const props = fieldProperties[r.name];
            const limit = props.sharable ? 2 : 1;
            const used = fieldUsageBySlot[i]?.[r.name] || 0;
            
            const timeAvail = isTimeAvailable(i, props);
            
            if (!timeAvail) {
                tableHtml += `<td class="avail-x">X</td>`; // Unavailable by time rule
            } else if (used >= limit) {
                tableHtml += `<td class="avail-x">X</td>`; // Used to capacity
            } else {
                tableHtml += `<td class="avail-check">✓</td>`; // Available
            }
        });
        tableHtml += `</tr>`;
    });
    
    tableHtml += `</tbody></table></div>`;
    availabilityReportContainer.innerHTML = tableHtml;
}


// Expose the new init function
window.initReportTab = initReportTab;

})();
