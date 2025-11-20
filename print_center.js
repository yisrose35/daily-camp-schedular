// =================================================================
// print_center.js
//
// Handles generating printable schedules for:
// 1. Individual Bunks
// 2. Whole Divisions
// 3. Locations (Fields)
// =================================================================

(function() {
'use strict';

function initPrintCenter() {
    const container = document.getElementById("print-content");
    if (!container) return;

    container.innerHTML = `
        <div class="print-dashboard">
            <h1>🖨️ Print Center</h1>
            <p class="no-print">Select a report type below to generate a printable view.</p>

            <div class="print-cards no-print">
                <div class="print-card">
                    <h3>👤 Bunk Schedule</h3>
                    <p>Print a schedule for a specific bunk.</p>
                    <select id="print-bunk-select"></select>
                    <button onclick="window.printBunkSchedule()">Generate & Print</button>
                </div>

                <div class="print-card">
                    <h3>grid_on Division Grid</h3>
                    <p>Print the master grid for a division.</p>
                    <select id="print-div-select"></select>
                    <button onclick="window.printDivisionGrid()">Generate & Print</button>
                </div>

                <div class="print-card">
                    <h3>📍 Location Schedule</h3>
                    <p>Print a schedule for a field (e.g. to post on the door).</p>
                    <select id="print-loc-select"></select>
                    <button onclick="window.printLocationSchedule()">Generate & Print</button>
                </div>
            </div>

            <div id="printable-area" class="printable-area"></div>
        </div>
    `;

    populateSelectors();
}

function populateSelectors() {
    const bunkSel = document.getElementById("print-bunk-select");
    const divSel = document.getElementById("print-div-select");
    const locSel = document.getElementById("print-loc-select");
    
    const app1 = window.loadGlobalSettings?.().app1 || {};
    const divisions = app1.divisions || {};
    const fields = app1.fields || [];
    const specials = app1.specialActivities || [];
    
    // Bunks & Divisions
    bunkSel.innerHTML = '<option value="">-- Select Bunk --</option>';
    divSel.innerHTML = '<option value="">-- Select Division --</option>';
    
    Object.keys(divisions).sort().forEach(divName => {
        divSel.innerHTML += `<option value="${divName}">${divName}</option>`;
        (divisions[divName].bunks || []).sort().forEach(bunk => {
            bunkSel.innerHTML += `<option value="${bunk}">${bunk}</option>`;
        });
    });

    // Locations
    locSel.innerHTML = '<option value="">-- Select Location --</option>';
    const allLocs = [...fields.map(f=>f.name), ...specials.map(s=>s.name)].sort();
    allLocs.forEach(loc => {
        locSel.innerHTML += `<option value="${loc}">${loc}</option>`;
    });
}

// --- GENERATORS ---

window.printBunkSchedule = function() {
    const bunk = document.getElementById("print-bunk-select").value;
    if (!bunk) return alert("Please select a bunk.");
    
    const daily = window.loadCurrentDailyData?.() || {};
    const schedule = daily.scheduleAssignments?.[bunk] || [];
    const times = window.unifiedTimes || [];

    let html = `
        <div class="print-page">
            <div class="print-header">
                <h2>📅 Schedule: ${bunk}</h2>
                <p>Date: ${window.currentScheduleDate}</p>
            </div>
            <table class="print-table">
                <thead><tr><th>Time</th><th>Activity</th></tr></thead>
                <tbody>
    `;

    times.forEach((t, i) => {
        const entry = schedule[i];
        if (!entry || entry.continuation) return; // Skip continuations for cleaner list

        let label = entry.field;
        if (typeof label === 'object') label = label.name;
        if (entry._h2h && entry.sport) label = entry.sport; // Show match details

        html += `<tr>
            <td class="time-col">${t.label}</td>
            <td>${label}</td>
        </tr>`;
    });

    html += `</tbody></table></div>`;
    
    triggerPrint(html);
};

window.printDivisionGrid = function() {
    const divName = document.getElementById("print-div-select").value;
    if (!divName) return alert("Please select a division.");
    
    const daily = window.loadCurrentDailyData?.() || {};
    const times = window.unifiedTimes || [];
    const bunks = (window.divisions[divName]?.bunks || []).sort();

    let html = `
        <div class="print-page landscape">
            <div class="print-header">
                <h2>📅 Schedule: ${divName}</h2>
                <p>Date: ${window.currentScheduleDate}</p>
            </div>
            <table class="print-table grid-table">
                <thead>
                    <tr>
                        <th>Time</th>
                        ${bunks.map(b => `<th>${b}</th>`).join('')}
                    </tr>
                </thead>
                <tbody>
    `;

    times.forEach((t, i) => {
        html += `<tr><td class="time-col">${t.label}</td>`;
        bunks.forEach(b => {
            const entry = daily.scheduleAssignments?.[b]?.[i];
            let label = "";
            if (entry && !entry.continuation) {
                label = (typeof entry.field === 'object') ? entry.field.name : entry.field;
                if(entry._h2h) label = "League Game"; // Shorten for grid
            } else if (entry && entry.continuation) {
                label = '<span class="text-muted">↓</span>';
            }
            html += `<td>${label}</td>`;
        });
        html += `</tr>`;
    });

    html += `</tbody></table></div>`;
    triggerPrint(html);
};

window.printLocationSchedule = function() {
    const loc = document.getElementById("print-loc-select").value;
    if (!loc) return alert("Please select a location.");

    const daily = window.loadCurrentDailyData?.() || {};
    const times = window.unifiedTimes || [];
    const assignments = daily.scheduleAssignments || {};

    let html = `
        <div class="print-page">
            <div class="print-header">
                <h2>📍 ${loc} Schedule</h2>
                <p>Date: ${window.currentScheduleDate}</p>
            </div>
            <table class="print-table">
                <thead><tr><th>Time</th><th>Bunks / Activity</th></tr></thead>
                <tbody>
    `;

    times.forEach((t, i) => {
        // Find who is here
        const bunksHere = [];
        Object.keys(assignments).forEach(b => {
            const entry = assignments[b][i];
            if (entry) {
                const fName = (typeof entry.field === 'object') ? entry.field.name : entry.field;
                if (fName === loc) {
                    // Avoid duplicates if it's a match
                    if(!bunksHere.includes(b)) bunksHere.push(b);
                }
            }
        });

        if (bunksHere.length > 0) {
             // Group by activity if possible? usually location implies activity
             // Just list bunks
             html += `<tr>
                <td class="time-col">${t.label}</td>
                <td>${bunksHere.join(", ")}</td>
             </tr>`;
        } else {
             html += `<tr>
                <td class="time-col">${t.label}</td>
                <td class="text-muted">-- Free --</td>
             </tr>`;
        }
    });

    html += `</tbody></table></div>`;
    triggerPrint(html);
};

function triggerPrint(content) {
    const area = document.getElementById("printable-area");
    area.innerHTML = content;
    window.print();
    // Optional: Clear after print? area.innerHTML = "";
}

window.initPrintCenter = initPrintCenter;

})();
