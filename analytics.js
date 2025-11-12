// =================================================================
// analytics.js
//
// NEW FILE: "Rotation Report" Tab
// This file reads the persistent `rotationHistory` (from calendar.js)
// and displays a report for a selected bunk, showing which activities
// they have done recently and which are "fresh".
// =================================================================

(function() {
'use strict';

let container = null;
let allActivities = [];
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
        
        <div style="display: flex; gap: 10px; align-items: center; margin-bottom: 20px;">
            <label for="report-bunk-select" style="font-weight: 600; font-size: 1.1em;">Select a Bunk:</label>
            <select id="report-bunk-select" style="font-size: 1.1em; padding: 5px; min-width: 200px;">
                <option value="">-- Select Bunk --</option>
            </select>
        </div>
        
        <div id="report-table-container">
            <p class="muted">Please select a bunk to view its report.</p>
        </div>
    `;
    
    bunkSelect = document.getElementById("report-bunk-select");
    reportContainer = document.getElementById("report-table-container");
    
    // 3. Populate the dropdown
    populateBunkDropdown();
    
    // 4. Hook up change listener
    bunkSelect.onchange = renderReport;
}

/**
 * Loads the master list of all bunks and activities
 */
function loadMasterData() {
    const app1Data = window.loadGlobalSettings?.().app1 || {};
    
    // Get all bunks
    const divisions = app1Data.divisions || {};
    window.allBunksForReport = [];
    Object.values(divisions).forEach(div => {
        if (div.bunks) {
            window.allBunksForReport.push(...div.bunks);
        }
    });
    window.allBunksForReport.sort();
    
    // Get all activities (fields + specials)
    const fields = app1Data.fields || [];
    const specials = app1Data.specialActivities || [];
    
    // We only care about sports/activities that can be *in* a rotation
    const sportActivities = fields.flatMap(f => f.activities || []);
    const specialActivities = specials.map(s => s.name);
    
    // Combine and deduplicate
    allActivities = Array.from(new Set([...sportActivities, ...specialActivities])).sort();
}

function populateBunkDropdown() {
    let options = '<option value="">-- Select Bunk --</option>';
    window.allBunksForReport.forEach(bunk => {
        options += `<option value="${bunk}">${bunk}</option>`;
    });
    bunkSelect.innerHTML = options;
}

/**
 * Renders the report table for the selected bunk
 */
function renderReport() {
    const bunkName = bunkSelect.value;
    if (!bunkName) {
        reportContainer.innerHTML = `<p class="muted">Please select a bunk to view its report.</p>`;
        return;
    }
    
    // --- 1. Calculate Stats from History ---
    // We need to scan the daily schedule history, not just the "last used" timestamp.
    // The 'rotationHistory' object only stores the *last* time something happened.
    // To get a count (e.g., "Played 2 times this week"), we need to load the actual daily data.
    
    // Let's load the last 7 days of history
    const history = window.loadScheduleHistory(7); // Helper we'll add below
    const historyDays = Object.keys(history).sort().reverse(); // [yesterday, 2_days_ago, ...]
    
    const report = {};
    // Initialize counts
    allActivities.forEach(act => {
        report[act] = {
            count: 0,
            lastDone: "7+ days ago" // Default
        };
    });

    // Scan the last 7 days
    for (let i = 0; i < historyDays.length; i++) {
        const day = historyDays[i];
        const daySchedule = history[day][bunkName] || [];
        const daysAgo = i + 1; // 1 = yesterday

        daySchedule.forEach(entry => {
            if (!entry) return;
            
            // This is the key logic from our plan:
            // Ignore leagues, pinned events, and "Free"
            if (entry._h2h || entry._fixed || !entry.sport) {
                return;
            }
            
            // The activity name is either in .sport (for fields) or .field.name (for specials)
            // Our new scheduler saves `_activity` which is perfect, but older schedules might not have it.
            // Fallback logic:
            let activityName = entry._activity;
            if (!activityName) {
                // Try to infer
                if (allActivities.includes(entry.sport)) activityName = entry.sport;
                else if (allActivities.includes(entry.field)) activityName = entry.field;
            }
            
            if (activityName && report[activityName]) {
                report[activityName].count++;
                
                // Update "last done" only if it's the most recent finding
                if (report[activityName].lastDone === "7+ days ago") {
                    report[activityName].lastDone = (daysAgo === 1) ? "1 day ago" : `${daysAgo} days ago`;
                }
            }
        });
    }
    
    // --- 2. Build the HTML Table ---
    let tableHtml = `
        <table style="width: 100%; border-collapse: collapse;">
            <thead>
                <tr>
                    <th style="text-align: left; padding: 8px; border-bottom: 2px solid #ccc;">Activity</th>
                    <th style="text-align: left; padding: 8px; border-bottom: 2px solid #ccc;">Times (Last 7 Days)</th>
                    <th style="text-align: left; padding: 8px; border-bottom: 2px solid #ccc;">Last Done</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    // Sort: Least played first (Freshness), then alphabetical
    const sortedActivities = allActivities.sort((a, b) => {
        if (report[a].count !== report[b].count) {
            return report[a].count - report[b].count; // Ascending count (0 first)
        }
        return a.localeCompare(b); 
    });
    
    sortedActivities.forEach(actName => {
        const data = report[actName];
        const isFresh = data.count === 0;
        const rowStyle = isFresh ? "background: #e8f5e9; font-weight: bold;" : ""; // Light green for fresh
        
        tableHtml += `
            <tr style="${rowStyle}">
                <td style="padding: 8px; border-bottom: 1px solid #ddd;">${actName} ${isFresh ? '🌟' : ''}</td>
                <td style="padding: 8px; border-bottom: 1px solid #ddd;">${data.count}</td>
                <td style="padding: 8px; border-bottom: 1px solid #ddd;">${data.lastDone}</td>
            </tr>
        `;
    });
    
    tableHtml += `</tbody></table>`;
    
    reportContainer.innerHTML = tableHtml;
}

/**
 * Helper: Loads the last N days of schedule data for analysis
 */
window.loadScheduleHistory = function(daysToLoad) {
    const allData = window.loadAllDailyData?.() || {};
    const today = new Date(window.currentScheduleDate);
    const history = {}; // { "YYYY-MM-DD": { bunk: [assignments...] } }
    
    for (let i = 1; i <= daysToLoad; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        
        // Format YYYY-MM-DD manually to match keys
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

// Expose the init function
window.initRotationReport = initRotationReport;

})();
