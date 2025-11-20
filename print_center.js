// =================================================================
// print_center.js
//
// Handles generating printable schedules.
// Features:
// - Print Whole Schedule (All Divisions)
// - Print Selected Divisions (Multi-select)
// - Print Selected Bunks (Multi-select) - UPDATED
// - Print Selected Locations (Multi-select) - UPDATED
// - Shows full League Matchups on both Bunk and Field schedules
// =================================================================

(function() {
'use strict';

function initPrintCenter() {
    const container = document.getElementById("print-content");
    if (!container) return;

    container.innerHTML = `
        <div class="print-dashboard">
            <h1 style="color:#1a5fb4;">🖨️ Print Center</h1>
            <p class="no-print">Select the items you want to print. You can select multiple Bunks or Fields at once.</p>

            <div class="print-cards no-print">
                
                <div class="print-card">
                    <h3>📅 Master Schedule</h3>
                    <p>Print grid views for divisions.</p>
                    
                    <button onclick="window.printAllDivisions()" style="background:#28a745; margin-bottom:15px;">
                        Print Whole Schedule (All Divisions)
                    </button>

                    <hr style="border-top:1px solid #ddd; margin:10px 0;">
                    
                    <label style="font-weight:bold; display:block; margin-bottom:5px;">Or Select Specific Divisions:</label>
                    <div id="print-div-list" class="print-list-box"></div>
                    <button onclick="window.printSelectedDivisions()">Print Selected Divisions</button>
                </div>

                <div class="print-card">
                    <h3>👤 Individual Bunks</h3>
                    <p>Print list views for specific bunks.</p>
                    <div id="print-bunk-list" class="print-list-box"></div>
                    <button onclick="window.printSelectedBunks()">Print Selected Bunks</button>
                </div>

                <div class="print-card">
                    <h3>📍 Locations / Fields</h3>
                    <p>Print schedules for specific fields.</p>
                    <div id="print-loc-list" class="print-list-box"></div>
                    <button onclick="window.printSelectedLocations()">Print Selected Locations</button>
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
        const bunks = (divisions[divName].bunks || []).sort();
        if (bunks.length > 0) {
            bunkList.innerHTML += `<div class="print-list-group">${divName}</div>`;
            bunks.forEach(b => {
                bunkList.innerHTML += `<label class="print-list-item"><input type="checkbox" value="${b}"> ${b}</label>`;
            });
        }
    });

    // 3. Locations Checkboxes
    locList.innerHTML = "";
    const allLocs = [...fields.map(f=>f.name), ...specials.map(s=>s.name)].sort();
    allLocs.forEach(loc => {
        locList.innerHTML += `<label class="print-list-item"><input type="checkbox" value="${loc}"> ${loc}</label>`;
    });
}

// --- HELPERS ---

function getDailyData() {
    return window.loadCurrentDailyData?.() || {};
}

function getUnifiedTimes() {
    return window.unifiedTimes || [];
}

// --- GENERATORS ---

// 1. Division Grid HTML
function generateDivisionHTML(divName) {
    const daily = getDailyData();
    const times = getUnifiedTimes();
    const divisions = window.loadGlobalSettings?.().app1.divisions || {};
    const bunks = (divisions[divName]?.bunks || []).sort();

    if (bunks.length === 0) return "";

    let html = `
        <div class="print-page landscape">
            <div class="print-header">
                <h2>📅 ${divName} Schedule</h2>
                <p>Date: ${window.currentScheduleDate}</p>
            </div>
            <table class="print-table grid-table">
                <thead>
                    <tr>
                        <th style="width:80px;">Time</th>
                        ${bunks.map(b => `<th>${b}</th>`).join('')}
                    </tr>
                </thead>
                <tbody>
    `;

    times.forEach((t, i) => {
        html += `<tr><td class="time-col"><strong>${t.label}</strong></td>`;
        bunks.forEach(b => {
            const entry = daily.scheduleAssignments?.[b]?.[i];
            let label = "";
            let cssClass = "";

            if (entry) {
                if (entry.continuation) {
                    label = "↓";
                    cssClass = "continuation";
                } else {
                    if (entry._h2h) {
                        // For grid, keep it short, but maybe show sport
                        label = entry.sport ? entry.sport.split('(')[1]?.split(')')[0] || "League" : "League";
                        // Or if entry.sport has "1 vs 2", that's too long for grid.
                        // Let's try to just show the Sport Name if possible
                        if (entry._activity) label = entry._activity + " (League)";
                        cssClass = "league-cell";
                    } else if (entry._fixed) {
                        label = (typeof entry.field === 'object') ? entry.field.name : entry.field;
                        cssClass = "pinned-cell";
                    } else {
                        label = (typeof entry.field === 'object') ? entry.field.name : entry.field;
                    }
                }
            }
            html += `<td class="${cssClass}">${label}</td>`;
        });
        html += `</tr>`;
    });

    html += `</tbody></table></div>`;
    return html;
}

// 2. Individual Bunk HTML
function generateBunkHTML(bunk) {
    const daily = getDailyData();
    const schedule = daily.scheduleAssignments?.[bunk] || [];
    const times = getUnifiedTimes();

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

        let label = (typeof entry.field === 'object') ? entry.field.name : entry.field;
        
        // SHOW FULL LEAGUE MATCHUP
        if (entry._h2h && entry.sport) {
            label = `<strong>${entry.sport}</strong>`;
        }

        html += `<tr>
            <td class="time-col"><strong>${t.label}</strong></td>
            <td>${label}</td>
        </tr>`;
    });

    html += `</tbody></table></div>`;
    return html;
}

// 3. Location HTML
function generateLocationHTML(loc) {
    const daily = getDailyData();
    const times = getUnifiedTimes();
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
                    
                    // CHECK FOR LEAGUE MATCHUP LABEL
                    if (entry._h2h && entry.sport && !leagueLabel) {
                        // Only grab the matchup part "Team A vs Team B (Sport)"
                        // The label usually comes as "A vs B (Sport) @ Field"
                        // We want to strip the "@ Field" part since we are ON the field page.
                        let matchStr = entry.sport;
                        if(matchStr.includes('@')) matchStr = matchStr.split('@')[0].trim();
                        leagueLabel = matchStr;
                    }
                }
            }
        });

        let content = "";
        let style = "";

        if (leagueLabel) {
            // It's a league game, show the matchup!
            content = `<strong>${leagueLabel}</strong> <br><span style="font-size:0.9em; color:#666;">(${bunksHere.join(", ")})</span>`;
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

window.printAllDivisions = function() {
    const app1 = window.loadGlobalSettings?.().app1 || {};
    const allDivs = app1.availableDivisions || [];
    
    if (allDivs.length === 0) return alert("No divisions found.");
    
    let fullHtml = "";
    allDivs.forEach(div => { fullHtml += generateDivisionHTML(div); });
    triggerPrint(fullHtml);
};

window.printSelectedDivisions = function() {
    const checkboxes = document.querySelectorAll("#print-div-list input:checked");
    const selected = Array.from(checkboxes).map(cb => cb.value);
    
    if (selected.length === 0) return alert("Please select at least one division.");

    let fullHtml = "";
    selected.forEach(div => { fullHtml += generateDivisionHTML(div); });
    triggerPrint(fullHtml);
};

// NEW: Print multiple bunks
window.printSelectedBunks = function() {
    const checkboxes = document.querySelectorAll("#print-bunk-list input:checked");
    const selected = Array.from(checkboxes).map(cb => cb.value);

    if (selected.length === 0) return alert("Please select at least one bunk.");

    let fullHtml = "";
    selected.forEach(bunk => { fullHtml += generateBunkHTML(bunk); });
    triggerPrint(fullHtml);
};

// NEW: Print multiple locations
window.printSelectedLocations = function() {
    const checkboxes = document.querySelectorAll("#print-loc-list input:checked");
    const selected = Array.from(checkboxes).map(cb => cb.value);

    if (selected.length === 0) return alert("Please select at least one location.");

    let fullHtml = "";
    selected.forEach(loc => { fullHtml += generateLocationHTML(loc); });
    triggerPrint(fullHtml);
};

function triggerPrint(content) {
    const area = document.getElementById("printable-area");
    area.innerHTML = content;
    window.print();
}

window.initPrintCenter = initPrintCenter;

})();
