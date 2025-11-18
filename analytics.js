{
type: "uploaded file",
fileName: "yisrose35/daily-camp-schedular/daily-camp-schedular-a06297415476e09773a64453edeaba22e822d2fb/analytics.js",
fullContent: `// =================================================================
// analytics.js
//
// --- UPDATED (BOLSTERED REPORTING) ---
// 1. Field Availability Grid:
//    - STRICT RULE applied: If usage > 0, it is 'X'.
//    - '✓' only appears if the slot is completely empty.
//    - Added filters (All / Fields / Specials).
//
// 2. Bunk Rotation Report:
//    - Added "Scheduled Today" column.
//    - Better sorting (Least recently used at the top).
//    - Visual improvements.
// =================================================================

(function() {
'use strict';

// --- Helpers ---
function parseTimeToMinutes(str) {
  if (!str || typeof str !== "string") return null;
  let s = str.trim().toLowerCase();
  let mer = null;
  if (s.endsWith("am") || s.endsWith("pm")) {
    mer = s.endsWith("am") ? "am" : "pm";
    s = s.replace(/am|pm/g, "").trim();
  } else {
    return null;
  }
  
  const m = s.match(/^(\\d{1,2})\\s*:\\s*(\\d{2})$/);
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

function isTimeAvailable(slotIndex, fieldProps) {
    const INCREMENT_MINS = window.INCREMENT_MINS || 30;

    if (!window.unifiedTimes || !window.unifiedTimes[slotIndex]) return false;
    
    const slot = window.unifiedTimes[slotIndex];
    const slotStartMin = new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes();
    const slotEndMin = slotStartMin + INCREMENT_MINS; 
    
    const rules = fieldProps.timeRules || [];
    
    if (rules.length === 0) return fieldProps.available;
    if (!fieldProps.available) return false;

    const hasAvailableRules = rules.some(r => r.type === 'Available');
    let isAvailable = !hasAvailableRules;

    for (const rule of rules) {
        if (rule.type === 'Available') {
            const startMin = parseTimeToMinutes(rule.start);
            const endMin = parseTimeToMinutes(rule.end);
            if (startMin === null || endMin === null) continue;
            
            if (slotStartMin >= startMin && slotEndMin <= endMin) {
                isAvailable = true;
                break;
            }
        }
    }

    for (const rule of rules) {
        if (rule.type === 'Unavailable') {
            const startMin = parseTimeToMinutes(rule.start);
            const endMin = parseTimeToMinutes(rule.end);
            if (startMin === null || endMin === null) continue;

            if (slotStartMin < endMin && slotEndMin > startMin) {
                isAvailable = false;
                break;
            }
        }
    }
    
    return isAvailable;
}

// --- Globals for this module ---
let container = null;
let allActivities = []; 
let divisions = {};
let availableDivisions = [];

let divisionSelect = null;
let bunkSelect = null;
let reportContainer = null;
let availabilityFilterSelect = null;

/**
 * Main entry point
 */
function initReportTab() {
    container = document.getElementById("report-content");
    if (!container) return;

    container.innerHTML = \`
        <div class="league-nav" style="background: #e3f2fd; border-color: #90caf9;"> 
            <label for="report-view-select" style="color: #1565c0;">Select Report:</label>
            <select id="report-view-select">
                <option value="availability">Field Availability Grid</option>
                <option value="rotation">Bunk Rotation Report</option>
            </select>
        </div>
        
        <div id="report-availability-content" class="league-content-pane active"></div>
        <div id="report-rotation-content" class="league-content-pane"></div>
    \`;

    // Initial Render
    renderFieldAvailabilityGrid();
    renderBunkRotationUI();

    // Tab Switcher Logic
    document.getElementById("report-view-select").onchange = (e) => {
        const selected = e.target.value;
        const rotationPane = document.getElementById("report-rotation-content");
        const availabilityPane = document.getElementById("report-availability-content");
        
        if (selected === 'rotation') {
            rotationPane.classList.add("active");
            availabilityPane.classList.remove("active");
            // Refresh rotation data when tab is opened
            const currentDiv = divisionSelect ? divisionSelect.value : "";
            if(currentDiv) onDivisionSelect(); 
        } else {
            rotationPane.classList.remove("active");
            availabilityPane.classList.add("active");
            renderFieldAvailabilityGrid(); // Refresh grid when tab is opened
        }
    };
}

// =================================================================
// --- 1. BUNK ROTATION REPORT ---
// =================================================================

function renderBunkRotationUI() {
    const rotationContainer = document.getElementById("report-rotation-content");
    if (!rotationContainer) return;

    loadMasterData();
    
    rotationContainer.innerHTML = \`
        <h2 class="report-title">Bunk Rotation Report</h2>
        <p>Analyze activity frequency over the last 7 days + today's schedule.</p>
        
        <div class="report-controls">
            <div>
                <label for="report-division-select">Division:</label>
                <select id="report-division-select" class="report-select"></select>
            </div>
            <div>
                <label for="report-bunk-select">Bunk (Optional):</label>
                <select id="report-bunk-select" class="report-select" disabled></select>
            </div>
        </div>
        
        <div id="report-table-container" class="report-container">
            <p class="report-muted">Please select a division to view its report.</p>
        </div>
    \`;
    
    divisionSelect = document.getElementById("report-division-select");
    bunkSelect = document.getElementById("report-bunk-select");
    reportContainer = document.getElementById("report-table-container");

    let divOptions = '<option value="">-- Select a division --</option>';
    availableDivisions.forEach(divName => {
        divOptions += \`<option value="\${divName}">\${divName}</option>\`;
    });
    divisionSelect.innerHTML = divOptions;
    
    divisionSelect.onchange = onDivisionSelect;
    bunkSelect.onchange = onBunkSelect;
}

function loadMasterData() {
    const app1Data = window.loadGlobalSettings?.().app1 || {};
    divisions = window.divisions || {};
    availableDivisions = (window.availableDivisions || []).sort();
    
    const fields = app1Data.fields || [];
    const specials = app1Data.specialActivities || [];
    
    const sportActivities = fields.flatMap(f => f.activities || []);
    const specialActivities = specials.map(s => s.name);
    
    allActivities = Array.from(new Set([...sportActivities, ...specialActivities])).sort();
}

function onDivisionSelect() {
    const divName = divisionSelect.value;
    reportContainer.innerHTML = "";
    
    if (!divName) {
        bunkSelect.innerHTML = "";
        bunkSelect.disabled = true;
        reportContainer.innerHTML = \`<p class="report-muted">Please select a division.</p>\`;
        return;
    }
    
    const bunksInDiv = (divisions[divName]?.bunks || []).sort();
    let bunkOptions = \`<option value="">--- Show All \${divName} Bunks ---</option>\`;
    bunksInDiv.forEach(bunk => {
        bunkOptions += \`<option value="\${bunk}">\${bunk}</option>\`;
    });
    bunkSelect.innerHTML = bunkOptions;
    bunkSelect.disabled = false;
    
    renderDivisionReport(divName, bunksInDiv);
}

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

function renderDivisionReport(divName, bunks) {
    reportContainer.innerHTML = "";
    if (bunks.length === 0) {
        reportContainer.innerHTML = \`<p class="report-muted">No bunks found in \${divName}.</p>\`;
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

function renderBunkReport(bunkName, targetContainer, clearContainer = true, preloadedHistory = null) {
    if (clearContainer) {
        targetContainer.innerHTML = \`<p class="report-loading">Loading...</p>\`;
    }

    const history = preloadedHistory || window.loadScheduleHistory(7);
    const historyDays = Object.keys(history).sort().reverse();
    
    // 1. Get Today's Schedule
    const todaySchedule = window.scheduleAssignments?.[bunkName] || [];
    const todayActivities = new Set();
    todaySchedule.forEach(entry => {
        if(entry && entry._activity && !entry._h2h && !entry._fixed) {
             todayActivities.add(entry._activity);
        }
    });

    // 2. Build Stats
    const report = {};
    allActivities.forEach(act => {
        report[act] = {
            count: 0,
            lastDone: "7+ days ago",
            isToday: todayActivities.has(act)
        };
    });

    for (let i = 0; i < historyDays.length; i++) {
        const day = historyDays[i];
        const daySchedule = history[day][bunkName] || [];
        const daysAgo = i + 1;

        daySchedule.forEach(entry => {
            if (!entry) return;
            if (entry._h2h || entry._fixed || !entry.sport) return;
            
            let activityName = entry._activity;
            if (!activityName) {
                if (allActivities.includes(entry.sport)) activityName = entry.sport;
                else if (allActivities.includes(entry.field)) activityName = entry.field;
            }
            
            if (activityName && report[activityName]) {
                report[activityName].count++;
                if (report[activityName].lastDone === "7+ days ago") {
                    report[activityName].lastDone = (daysAgo === 1) ? "1 day ago" : \`\${daysAgo} days ago\`;
                }
            }
        });
    }
    
    let tableHtml = \`
        <table class="report-table">
            <thead>
                <tr>
                    <th>Activity</th>
                    <th>Scheduled Today?</th>
                    <th>Count (Last 7 Days)</th>
                    <th>Last Done</th>
                </tr>
            </thead>
            <tbody>
    \`;
    
    // Sort: Today -> Count (ascending) -> Alphabetical
    const sortedActivities = allActivities.sort((a, b) => {
        const rA = report[a];
        const rB = report[b];

        if (rA.isToday !== rB.isToday) return rB.isToday - rA.isToday; // True first
        if (rA.count !== rB.count) return rA.count - rB.count; // Low count first
        return a.localeCompare(b); 
    });
    
    sortedActivities.forEach(actName => {
        const data = report[actName];
        // Highlight if fresh (0 count) and NOT scheduled today
        const isNeed = data.count === 0 && !data.isToday;
        const rowClass = isNeed ? "report-row-fresh" : "";
        
        const checkMark = data.isToday ? '<span style="color:green;font-weight:bold;">YES</span>' : '<span style="color:#ccc;">-</span>';

        tableHtml += \`
            <tr class="\${rowClass}">
                <td>\${actName}</td>
                <td style="text-align:center;">\${checkMark}</td>
                <td>\${data.count}</td>
                <td>\${data.lastDone}</td>
            </tr>
        \`;
    });
    
    tableHtml += \`</tbody></table>\`;
    targetContainer.innerHTML = tableHtml;
}


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
        const dateKey = \`\${y}-\${m}-\${dayStr}\`;
        
        if (allData[dateKey] && allData[dateKey].scheduleAssignments) {
            history[dateKey] = allData[dateKey].scheduleAssignments;
        }
    }
    return history;
}

// =================================================================
// --- 2. FIELD AVAILABILITY GRID (BOLSTERED) ---
// =================================================================

function renderFieldAvailabilityGrid() {
    const availabilityContainer = document.getElementById("report-availability-content");
    if (!availabilityContainer) return;

    // 1. Setup Filter if not exists
    if (!document.getElementById("avail-filter-controls")) {
        availabilityContainer.innerHTML = \`
            <div id="avail-filter-controls" style="margin-bottom:15px; display:flex; gap:15px; align-items:center;">
                <h2 class="report-title" style="margin:0; border:none;">Field Availability</h2>
                <select id="avail-type-filter" style="padding:5px; font-size:1rem;">
                    <option value="all">Show All Resources</option>
                    <option value="field">Fields Only</option>
                    <option value="special">Special Activities Only</option>
                </select>
            </div>
            <p><strong>Key:</strong> <span class="avail-check">✓</span> = Completely Empty (30min). <span class="avail-x">X</span> = In use by at least 1 bunk OR Closed.</p>
            <div id="avail-grid-wrapper"></div>
        \`;
        document.getElementById("avail-type-filter").onchange = renderFieldAvailabilityGrid;
    }
    
    const gridWrapper = document.getElementById("avail-grid-wrapper");
    gridWrapper.innerHTML = "";
    
    const filterType = document.getElementById("avail-type-filter").value; // 'all', 'field', 'special'

    // 2. Load Data
    const dailyData = window.loadCurrentDailyData?.() || {};
    const scheduleAssignments = dailyData.scheduleAssignments || {};
    const unifiedTimes = window.unifiedTimes || dailyData.unifiedTimes || [];

    if (unifiedTimes.length === 0) {
        gridWrapper.innerHTML = \`<p class="report-muted">No schedule generated yet.</p>\`;
        return;
    }

    const app1Data = window.loadGlobalSettings?.().app1 || {};
    const allFields = (app1Data.fields || []).map(f => ({...f, type: 'field'}));
    const allSpecials = (app1Data.specialActivities || []).map(s => ({...s, type: 'special'}));
    
    // Filter Resources
    let resourcesToShow = [...allFields, ...allSpecials];
    if (filterType === 'field') resourcesToShow = allFields;
    if (filterType === 'special') resourcesToShow = allSpecials;
    
    resourcesToShow.sort((a,b) => a.name.localeCompare(b.name));

    // 3. Compile Usage
    const fieldUsageBySlot = {}; 
    for (const bunk in scheduleAssignments) {
        const schedule = scheduleAssignments[bunk] || [];
        for (let i = 0; i < schedule.length; i++) {
            const entry = schedule[i];
            // Count EVERYTHING except pure 'Free' slots.
            // Even pinned items, leagues, etc count as usage.
            if (entry && !entry.continuation) {
                const fieldName = fieldLabel(entry.field);
                if (fieldName && fieldName !== "Free" && fieldName !== "No Field") {
                    fieldUsageBySlot[i] = fieldUsageBySlot[i] || {};
                    fieldUsageBySlot[i][fieldName] = (fieldUsageBySlot[i][fieldName] || 0) + 1;
                }
            }
        }
    }

    // 4. Compile Properties
    const fieldProperties = {};
    resourcesToShow.forEach(f => {
        fieldProperties[f.name] = {
            available: f.available !== false,
            timeRules: f.timeRules || []
        };
    });

    // 5. Build Grid
    let tableHtml = \`<div class="schedule-view-wrapper"><table class="availability-grid"><thead><tr><th>Time</th>\`;
    
    resourcesToShow.forEach(r => {
        tableHtml += \`<th>\${r.name}</th>\`;
    });
    tableHtml += \`</tr></thead><tbody>\`;

    unifiedTimes.forEach((slot, i) => {
        const start = new Date(slot.start);
        const end = new Date(slot.end);
        let h = start.getHours(), m = start.getMinutes().toString().padStart(2,"0"), ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
        const timeLabel = \`\${h}:\${m} \${ap}\`;
        
        tableHtml += \`<tr><td>\${timeLabel}</td>\`;

        resourcesToShow.forEach(r => {
            const props = fieldProperties[r.name];
            const usedCount = fieldUsageBySlot[i]?.[r.name] || 0;
            const timeAvail = isTimeAvailable(i, props);
            
            // --- STRICT LOGIC ---
            if (!timeAvail) {
                // Closed by rule
                tableHtml += \`<td class="avail-x" style="background:#fce4ec;" title="Closed by Time Rule">X</td>\`;
            } else if (usedCount > 0) {
                // Used by ANYONE (even 1 bunk) -> X
                tableHtml += \`<td class="avail-x" title="Occupied by \${usedCount} bunk(s)">X</td>\`;
            } else {
                // Completely empty -> Check
                tableHtml += \`<td class="avail-check" title="Available">✓</td>\`;
            }
        });
        tableHtml += \`</tr>\`;
    });
    
    tableHtml += \`</tbody></table></div>\`;
    gridWrapper.innerHTML = tableHtml;
}


window.initReportTab = initReportTab;

})();
`
}
