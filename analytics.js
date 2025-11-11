// =================================================================
// analytics.js
// NEW FILE - Phase 3
// This file creates the "Rotation Report" dashboard.
// =================================================================

(function() {
'use strict';

let container = null;
let allBunks = [];
let allActivities = [];

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
        
        <label for="bunk-select" style="font-weight: 600; font-size: 1.1em; margin-right: 10px;">Select a Bunk:</label>
        <select id="bunk-select" style="font-size: 1.1em; padding: 5px;"></select>
        
        <div id="report-table-container" style="margin-top: 20px;">
            <p class="muted">Please select a bunk to view its report.</p>
        </div>
    `;
    
    // 3. Populate the bunk dropdown
    const select = document.getElementById("bunk-select");
    let options = '<option value="">-- Select a bunk --</option>';
    allBunks.forEach(bunk => {
        options += `<option value="${bunk}">${bunk}</option>`;
    });
    select.innerHTML = options;
    
    // 4. Hook up the onchange event
    select.onchange = (e) => {
        const bunkName = e.target.value;
        if (bunkName) {
            renderReport(bunkName);
        } else {
            document.getElementById("report-table-container").innerHTML = `<p class="muted">Please select a bunk to view its report.</p>`;
        }
    };
}

/**
 * Loads the master list of all bunks and activities
 */
function loadMasterData() {
    const app1Data = window.loadGlobalSettings?.().app1 || {};
    
    // Get all bunks
    allBunks = (app1Data.bunks || []).sort();
    
    // Get all activities (fields + specials)
    const fields = app1Data.fields || [];
    const specials = app1Data.specialActivities || [];
    
    const sportActivities = fields.flatMap(f => f.activities || []);
    const specialActivities = specials.map(s => s.name);
    
    // Get a unique, sorted list of all activity names
    allActivities = Array.from(new Set([...sportActivities, ...specialActivities])).sort();
}

/**
 * Renders the report table for the selected bunk.
 */
function renderReport(bunkName) {
    const tableContainer = document.getElementById("report-table-container");
    tableContainer.innerHTML = `<p>Loading report for ${bunkName}...</p>`;

    const history = window.loadScheduleHistory?.(7) || {};
    const historyDays = Object.keys(history).sort().reverse(); // [yesterday, 2_days_ago, ...]
    
    // This object will hold the report data
    const report = {};
    allActivities.forEach(act => {
        report[act] = {
            count: 0,
            lastDone: "7+ days ago"
        };
    });

    // Loop from yesterday (i=0) to 7 days ago (i=6)
    for (let i = 0; i < historyDays.length; i++) {
        const day = historyDays[i];
        const daySchedule = history[day][bunkName] || [];
        const daysAgo = i + 1;

        daySchedule.forEach(entry => {
            if (!entry) return;
            
            // --- This is the key logic from our plan ---
            // Ignore leagues, pinned events, and "Free"
            if (entry._h2h || entry._fixed || !entry.sport) {
                return;
            }
            
            const activityName = entry.sport;
            
            if (report[activityName]) {
                report[activityName].count++;
                
                // Only set "lastDone" the first time we see it
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
                    <th style="text-align: left;">Activity</th>
                    <th style="text-align: left;">Times (Last 7 Days)</th>
                    <th style="text-align: left;">Last Done</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    // Sort the report: 0 count first, then by name
    const sortedActivities = allActivities.sort((a, b) => {
        if (report[a].count !== report[b].count) {
            return report[a].count - report[b].count; // Show 0-count first
        }
        return a.localeCompare(b); // Then sort alphabetically
    });
    
    sortedActivities.forEach(actName => {
        const data = report[actName];
        const isFresh = data.count === 0;
        tableHtml += `
            <tr style="background: ${isFresh ? '#e8f5e9' : '#fff'};">
                <td style="padding: 8px; border-bottom: 1px solid #ddd;"><strong>${actName}</strong></td>
                <td style="padding: 8px; border-bottom: 1px solid #ddd;">${data.count}</td>
                <td style="padding: 8px; border-bottom: 1px solid #ddd;">${data.lastDone}</td>
            </tr>
        `;
    });
    
    tableHtml += `</tbody></table>`;
    tableContainer.innerHTML = tableHtml;
}


// Expose the init function
window.initRotationReport = initRotationReport;

})();
