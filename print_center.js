// =================================================================
// print_center.js
//
// Handles generating printable schedules.
// Features:
// - Print Whole Schedule (All Divisions)
// - Print Selected Divisions (Multi-select)
// - Print Individual Bunk
// - Print Location (Field)
// =================================================================

(function() {
'use strict';

function initPrintCenter() {
    const container = document.getElementById("print-content");
    if (!container) return;

    container.innerHTML = `
        <div class="print-dashboard">
            <h1 style="color:#1a5fb4;">🖨️ Print Center</h1>
            <p class="no-print">Generate paper-friendly schedules for handouts or posting.</p>

            <div class="print-cards no-print">
                
                <div class="print-card">
                    <h3>📅 Master Schedule</h3>
                    <p>Print grid views for divisions.</p>
                    
                    <button onclick="window.printAllDivisions()" style="background:#28a745; margin-bottom:15px;">
                        Print Whole Schedule (All Divisions)
                    </button>

                    <hr style="border-top:1px solid #ddd; margin:10px 0;">
                    
                    <label style="font-weight:bold; display:block; margin-bottom:5px;">Or Select Specific Divisions:</label>
                    <div id="print-div-list" style="max-height:150px; overflow-y:auto; border:1px solid #ccc; padding:10px; background:white; margin-bottom:10px;">
                        </div>
                    <button onclick="window.printSelectedDivisions()">Print Selected Divisions</button>
                </div>

                <div class="print-card">
                    <h3>👤 Individual Bunk</h3>
                    <p>Print a list view for a single bunk.</p>
                    <select id="print-bunk-select" style="width:100%; padding:8px; margin-bottom:10px;"></select>
                    <button onclick="window.printBunkSchedule()">Generate & Print</button>
                </div>

                <div class="print-card">
                    <h3>📍 Location / Field</h3>
                    <p>Print a schedule for a specific field.</p>
                    <select id="print-loc-select" style="width:100%; padding:8px; margin-bottom:10px;"></select>
                    <button onclick="window.printLocationSchedule()">Generate & Print</button>
                </div>
            </div>

            <div id="printable-area"></div>
        </div>
    `;

    populateSelectors();
}

function populateSelectors() {
    const divList = document.getElementById("print-div-list");
    const bunkSel = document.getElementById("print-bunk-select");
    const locSel = document.getElementById("print-loc-select");
    
    const app1 = window.loadGlobalSettings?.().app1 || {};
    const divisions = app1.divisions || {};
    const availableDivisions = app1.availableDivisions || [];
    const fields = app1.fields || [];
    const specials = app1.specialActivities || [];
    
    // 1. Divisions Checkboxes
    divList.innerHTML = "";
    availableDivisions.forEach(divName => {
        const label = document.createElement("label");
        label.style.display = "block";
        label.style.marginBottom = "4px";
        label.innerHTML = `<input type="checkbox" value="${divName}"> ${divName}`;
        divList.appendChild(label);
    });

    // 2. Bunks Dropdown
    bunkSel.innerHTML = '<option value="">-- Select Bunk --</option>';
    availableDivisions.forEach(divName => {
        const bunks = (divisions[divName].bunks || []).sort();
        if (bunks.length > 0) {
            const optgroup = document.createElement("optgroup");
            optgroup.label = divName;
            bunks.forEach(b => {
                const opt = document.createElement("option");
                opt.value = b;
                opt.textContent = b;
                optgroup.appendChild(opt);
            });
            bunkSel.appendChild(optgroup);
        }
    });

    // 3. Locations Dropdown
    locSel.innerHTML = '<option value="">-- Select Location --</option>';
    const allLocs = [...fields.map(f=>f.name), ...specials.map(s=>s.name)].sort();
    allLocs.forEach(loc => {
        const opt = document.createElement("option");
        opt.value = loc;
        opt.textContent = loc;
        locSel.appendChild(opt);
    });
}

// --- HELPERS ---

function getDailyData() {
    return window.loadCurrentDailyData?.() || {};
}

function getUnifiedTimes() {
    return window.unifiedTimes || [];
}

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
                    // Format Label
                    if (entry._h2h) {
                        label = entry.sport || "League Game";
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

    html += `</tbody></table></div><div class="page-break"></div>`;
    return html;
}

// --- ACTIONS ---

window.printAllDivisions = function() {
    const app1 = window.loadGlobalSettings?.().app1 || {};
    const allDivs = app1.availableDivisions || [];
    
    if (allDivs.length === 0) return alert("No divisions found.");
    
    let fullHtml = "";
    allDivs.forEach(div => {
        fullHtml += generateDivisionHTML(div);
    });
    triggerPrint(fullHtml);
};

window.printSelectedDivisions = function() {
    const checkboxes = document.querySelectorAll("#print-div-list input:checked");
    const selected = Array.from(checkboxes).map(cb => cb.value);
    
    if (selected.length === 0) return alert("Please select at least one division.");

    let fullHtml = "";
    selected.forEach(div => {
        fullHtml += generateDivisionHTML(div);
    });
    triggerPrint(fullHtml);
};

window.printBunkSchedule = function() {
    const bunk = document.getElementById("print-bunk-select").value;
    if (!bunk) return alert("Please select a bunk.");
    
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
                <thead><tr><th style="width:100px;">Time</th><th>Activity</th></tr></thead>
                <tbody>
    `;

    times.forEach((t, i) => {
        const entry = schedule[i];
        if (!entry || entry.continuation) return; 

        let label = (typeof entry.field === 'object') ? entry.field.name : entry.field;
        if (entry._h2h && entry.sport) label = entry.sport;

        html += `<tr>
            <td class="time-col"><strong>${t.label}</strong></td>
            <td>${label}</td>
        </tr>`;
    });

    html += `</tbody></table></div>`;
    triggerPrint(html);
};

window.printLocationSchedule = function() {
    const loc = document.getElementById("print-loc-select").value;
    if (!loc) return alert("Please select a location.");

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
                <thead><tr><th style="width:100px;">Time</th><th>Bunks / Activity</th></tr></thead>
                <tbody>
    `;

    times.forEach((t, i) => {
        const bunksHere = [];
        Object.keys(assignments).forEach(b => {
            const entry = assignments[b][i];
            if (entry) {
                const fName = (typeof entry.field === 'object') ? entry.field.name : entry.field;
                if (fName === loc) {
                    if(!bunksHere.includes(b)) bunksHere.push(b);
                }
            }
        });

        const content = bunksHere.length > 0 ? bunksHere.join(", ") : "-- Free --";
        const style = bunksHere.length > 0 ? "" : "color:#999; font-style:italic;";

        html += `<tr>
            <td class="time-col"><strong>${t.label}</strong></td>
            <td style="${style}">${content}</td>
        </tr>`;
    });

    html += `</tbody></table></div>`;
    triggerPrint(html);
};

function triggerPrint(content) {
    const area = document.getElementById("printable-area");
    area.innerHTML = content;
    window.print();
    // setTimeout(() => area.innerHTML = "", 1000); // Optional cleanup
}

window.initPrintCenter = initPrintCenter;

})();
