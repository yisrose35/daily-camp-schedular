// =================================================================
// analytics.js
//
// UPDATED (Bunk Report Improvements):
// - **NEW UI:** Replaced the single bunk dropdown with two:
//   "Select a Division" and "Select a Bunk".
// - **FIXED:** The "Bunk" dropdown is now populated based on the
//   selected division, which fixes the "out-of-order" bug.
// - **NEW FEATURE:** Selecting a division shows a new
//   "Division Report" with a separate table for *every*
//   bunk in that division.
// - **NEW FEATURE:** Selecting a single bunk filters the report
//   to show only that bunk's table.
// - `renderReport` is now `renderBunkReport` and can target
//   a specific container for the new Division Report.
// =================================================================

(function() {
'use strict';

let container = null;
let allActivities = [];
let divisions = {};
let availableDivisions = [];

// Keep track of DOM elements
let divisionSelect = null;
let bunkSelect = null;
let reportContainer = null;

/**
 * Main entry point, called by index.html tab click.
 */
function initRotationReport() {
    container = document.getElementById("rotation-report-content");
    if (!container) return;
    
    // 1. Load the data we need
    loadMasterData();
    
    // 2. Build the UI
    container.innerHTML = `
        <h2>Rotation Report</h2>
        <p>See how many times each bunk has done a "regular" (non-league, non-pinned) activity in the past 7 days.</p>
        
        <div style="display: flex; gap: 20px; align-items: flex-end;">
            <div>
                <label for="report-division-select" style="font-weight: 600; font-size: 1.1em; display: block; margin-bottom: 5px;">
                    1. Select a Division:
                </label>
                <select id="report-division-select" style="font-size: 1.1em; padding: 5px; min-width: 200px;"></select>
            </div>
            <div>
                <label for="report-bunk-select" style="font-weight: 600; font-size: 1.1em; display: block; margin-bottom: 5px;">
                    2. Select a Bunk (Optional):
                </label>
                <select id="report-bunk-select" style="font-size: 1.1em; padding: 5px; min-width: 200px;" disabled></select>
            </div>
        </div>
        
        <div id="report-table-container" style="margin-top: 20px;">
            <p class="muted">Please select a division to view its report.</p>
        </div>
    `;
    
    // 3. Get element references
    divisionSelect = document.getElementById("report-division-select");
    bunkSelect = document.getElementById("report-bunk-select");
    reportContainer = document.getElementById("report-table-container");

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
 * --- NEW ---
 * Handles when the user selects a division.
 */
function onDivisionSelect() {
    const divName = divisionSelect.value;
    reportContainer.innerHTML = ""; // Clear old report
    
    if (!divName) {
        bunkSelect.innerHTML = "";
        bunkSelect.disabled = true;
        reportContainer.innerHTML = `<p class="muted">Please select a division to view its report.</p>`;
        return;
    }
    
    // A division is selected, populate the bunk dropdown
    const bunksInDiv = (divisions[divName]?.bunks || []).sort();
    let bunkOptions = `<option value="">--- Show All ${divName} Bunks ---</option>`;
    bunksInDiv.forEach(bunk => {
        bunkOptions += `<option value="${bunk}">${bunk}</option>`;
    });
    bunkSelect.innerHTML = bunkOptions;
    bunkSelect.disabled = false;
    
    // Immediately render the report for all bunks in this division
    renderDivisionReport(divName, bunksInDiv);
}

/**
 * --- NEW ---
 * Handles when the user selects a specific bunk.
 */
function onBunkSelect() {
    const bunkName = bunkSelect.value;
    const divName = divisionSelect.value;
    
    if (!bunkName) {
        // User selected "Show All Bunks", so render the division report
        const bunksInDiv = (divisions[divName]?.bunks || []).sort();
        renderDivisionReport(divName, bunksInDiv);
    } else {
        // User selected a single bunk, render that report
        renderBunkReport(bunkName, reportContainer, true);
    }
}

/**
 * --- NEW ---
 * Renders a report for ALL bunks in a division.
 */
function renderDivisionReport(divName, bunks) {
    reportContainer.innerHTML = ""; // Clear container
    
    if (bunks.length === 0) {
        reportContainer.innerHTML = `<p class="muted">No bunks found in ${divName}.</p>`;
        return;
    }
    
    // Load history ONCE
    const history = window.loadScheduleHistory?.(7) || {};

    // Render a separate report for each bunk
    bunks.forEach(bunkName => {
        const bunkHeader = document.createElement('h3');
        bunkHeader.textContent = bunkName;
        bunkHeader.style.marginTop = "25px";
        bunkHeader.style.borderBottom = "2px solid #eee";
        bunkHeader.style.paddingBottom = "5px";
        
        const tableDiv = document.createElement('div');
        
        reportContainer.appendChild(bunkHeader);
        reportContainer.appendChild(tableDiv);
        
        // Render the single-bunk report into its dedicated div
        renderBunkReport(bunkName, tableDiv, false, history);
    });
}


/**
 * Renders the report table for a SINGLE bunk.
 * --- UPDATED ---
 * Now can target a specific container and accept pre-loaded history.
 */
function renderBunkReport(bunkName, targetContainer, clearContainer = true, preloadedHistory = null) {
    if (clearContainer) {
        targetContainer.innerHTML = `<p>Loading report for ${bunkName}...</p>`;
    }

    // Load history only if it wasn't provided
    const history = preloadedHistory || window.loadScheduleHistory?.(7) || {};
    const historyDays = Object.keys(history).sort().reverse(); // [yesterday, 2_days_ago, ...]
    
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
            
            // This is the key logic from our plan:
            // Ignore leagues, pinned events, and "Free"
            if (entry._h2h || entry._fixed || !entry.sport) {
                return;
            }
            
            const activityName = entry.sport;
            
            if (report[activityName]) {
                report[activityName].count++;
                
                if (report[activityName].lastDone === "7+ days ago") {
                    report[activityName].lastDone = (daysAgo === 1) ? "1 day ago" : `${daysAgo} days ago`;
                }
            }
        });
    }
    
    // --- Build the HTML Table ---
    let tableHtml = `
        <table style="width: 100%; border-collapse: collapse;">
            <thead>
                <tr>
                    <th style="text-align: left; padding: 6px; border-bottom: 2px solid #ccc;">Activity</th>
                    <th style="text-align: left; padding: 6px; border-bottom: 2px solid #ccc;">Times (Last 7 Days)</th>
                    <th style="text-align: left; padding: 6px; border-bottom: 2px solid #ccc;">Last Done</th>
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
        tableHtml += `
            <tr style="background: ${isFresh ? '#f0f9f0' : '#fff'};">
                <td style="padding: 8px; border-bottom: 1px solid #ddd;"><strong>${actName}</strong></td>
                <td style="padding: 8px; border-bottom: 1px solid #ddd;">${data.count}</td>
                <td style="padding: 8px; border-bottom: 1px solid #ddd;">${data.lastDone}</td>
            </tr>
        `;
    });
    
    tableHtml += `</tbody></table>`;
    targetContainer.innerHTML = tableHtml;
}


// Expose the init function
window.initRotationReport = initRotationReport;

})();
