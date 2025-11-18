// =================================================================
// analytics.js
//
// --- UPDATED FOR SPECIFIC PARTIAL LOGIC ---
// 1. Starts Blocked -> Shows "X" (Red) + "Avail @ [Time]"
// 2. Starts Free -> Shows "✓" (Green) + "Unavail @ [Time]"
// 3. Strict logic: If blocked at start, it's an X. If free at start, it's a check.
// =================================================================

(function() {
'use strict';

const MIN_USABLE_MINUTES = 1; // Threshold to consider a gap "usable"

// --- Helpers ---
function parseTimeToMinutes(str) {
  if (!str || typeof str !== "string") return null;
  let s = str.trim().toLowerCase();
  let mer = null;
  if (s.endsWith("am") || s.endsWith("pm")) {
    mer = s.endsWith("am") ? "am" : "pm";
    s = s.replace(/am|pm/g, "").trim();
  } else {
    // Attempt to handle 24h or raw HH:MM if passed without AM/PM
  }
  
  // Regex for HH:MM
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

// Convert minutes back to HH:MM AM/PM string
function minutesToTime(totalMinutes) {
    let h = Math.floor(totalMinutes / 60);
    let m = totalMinutes % 60;
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    h = h ? h : 12; // the hour '0' should be '12'
    const mStr = m < 10 ? '0' + m : m;
    return `${h}:${mStr} ${ampm}`;
}

function fieldLabel(f) {
    if (!f) return "";
    if (typeof f === "string") return f;
    if (typeof f === "object" && typeof f.name === "string") return f.name;
    return "";
}

function isTimeAvailable(slotIndex, fieldProps) {
    const INCREMENT_MINS = window.INCREMENT_MINS || 30;

    if (!window.unifiedTimes || !window.unifiedTimes[slotIndex]) return false;
    
    const slot = window.unifiedTimes[slotIndex];
    // Normalize slot start
    const d = new Date(slot.start);
    const slotStartMin = d.getHours() * 60 + d.getMinutes();
    const slotEndMin = slotStartMin + INCREMENT_MINS; 
    
    const rules = fieldProps.timeRules || [];
    
    if (rules.length === 0) return fieldProps.available;
    if (!fieldProps.available) return false;

    // Logic: Default is unavailable if "Available" rules exist, else default is available
    const hasAvailableRules = rules.some(r => r.type === 'Available');
    let isAvailable = !hasAvailableRules;

    // Check "Available" whitelist rules
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

    // Check "Unavailable" blacklist rules
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

/**
 * Main entry point
 */
function initReportTab() {
    try {
        container = document.getElementById("report-content");
        if (!container) return;

        container.innerHTML = `
            <div class="league-nav" style="background: #e3f2fd; border-color: #90caf9; padding: 10px; margin-bottom: 15px; border-radius: 8px;"> 
                <label for="report-view-select" style="color: #1565c0; font-weight: bold;">Select Report:</label>
                <select id="report-view-select" style="font-size: 1em; padding: 5px;">
                    <option value="availability">Field Availability Grid</option>
                    <option value="rotation">Bunk Rotation Report</option>
                </select>
            </div>
            
            <div id="report-availability-content" class="league-content-pane active"></div>
            <div id="report-rotation-content" class="league-content-pane" style="display:none;"></div>
        `;

        // Initial Render
        renderFieldAvailabilityGrid();
        renderBunkRotationUI();

        // Tab Switcher Logic
        const select = document.getElementById("report-view-select");
        if (select) {
            select.onchange = (e) => {
                const selected = e.target.value;
                const rotationPane = document.getElementById("report-rotation-content");
                const availabilityPane = document.getElementById("report-availability-content");
                
                if (selected === 'rotation') {
                    rotationPane.style.display = "block";
                    availabilityPane.style.display = "none";
                    if(divisionSelect && divisionSelect.value) onDivisionSelect(); 
                } else {
                    rotationPane.style.display = "none";
                    availabilityPane.style.display = "block";
                    renderFieldAvailabilityGrid(); 
                }
            };
        }
    } catch (e) {
        console.error("Error initializing report tab:", e);
        if (container) container.innerHTML = `<p style="color:red; padding:20px;">Error loading report: ${e.message}</p>`;
    }
}

// =================================================================
// --- 1. BUNK ROTATION REPORT ---
// =================================================================

function renderBunkRotationUI() {
    const rotationContainer = document.getElementById("report-rotation-content");
    if (!rotationContainer) return;

    loadMasterData();
    
    rotationContainer.innerHTML = `
        <h2 class="report-title" style="border-bottom: 2px solid #007BFF; padding-bottom: 10px;">Bunk Rotation Report</h2>
        <p>Analyze activity frequency over the last 7 days + today's schedule.</p>
        
        <div class="report-controls" style="background:#f9f9f9; padding:15px; border-radius:8px; display:flex; gap:20px; align-items:flex-end; margin-bottom:20px;">
            <div>
                <label for="report-division-select" style="display:block; font-weight:bold; margin-bottom:5px;">Division:</label>
                <select id="report-division-select" class="report-select" style="padding:5px; min-width:150px;"></select>
            </div>
            <div>
                <label for="report-bunk-select" style="display:block; font-weight:bold; margin-bottom:5px;">Bunk (Optional):</label>
                <select id="report-bunk-select" class="report-select" style="padding:5px; min-width:150px;" disabled></select>
            </div>
        </div>
        
        <div id="report-table-container" class="report-container">
            <p class="report-muted" style="padding:20px; background:#f0f0f0; text-align:center; color:#666;">Please select a division to view its report.</p>
        </div>
    `;
    
    divisionSelect = document.getElementById("report-division-select");
    bunkSelect = document.getElementById("report-bunk-select");
    reportContainer = document.getElementById("report-table-container");

    let divOptions = '<option value="">-- Select a division --</option>';
    availableDivisions.forEach(divName => {
        divOptions += `<option value="${divName}">${divName}</option>`;
    });
    divisionSelect.innerHTML = divOptions;
    
    divisionSelect.onchange = onDivisionSelect;
    bunkSelect.onchange = onBunkSelect;
}

function loadMasterData() {
    try {
        const app1Data = window.loadGlobalSettings?.().app1 || {};
        divisions = window.divisions || {};
        availableDivisions = (window.availableDivisions || []).sort();
        
        const fields = app1Data.fields || [];
        const specials = app1Data.specialActivities || [];
        
        const sportActivities = fields.flatMap(f => (f.activities || []).map(a => ({name: a, type: 'sport'})));
        const specialActivities = specials.map(s => ({name: s.name, type: 'special'}));
        
        const uniqueMap = new Map();
        [...sportActivities, ...specialActivities].forEach(item => {
            if(item.name) uniqueMap.set(item.name, item.type);
        });
        
        allActivities = Array.from(uniqueMap.entries())
            .map(([name, type]) => ({name, type}))
            .sort((a,b) => (a.name || "").localeCompare(b.name || ""));
            
    } catch(e) {
        console.error("Error loading master data:", e);
        allActivities = [];
    }
}

function onDivisionSelect() {
    const divName = divisionSelect.value;
    reportContainer.innerHTML = "";
    
    if (!divName) {
        bunkSelect.innerHTML = "";
        bunkSelect.disabled = true;
        reportContainer.innerHTML = `<p class="report-muted" style="padding:20px; background:#f0f0f0; text-align:center; color:#666;">Please select a division.</p>`;
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
        reportContainer.innerHTML = `<p class="report-muted">No bunks found in ${divName}.</p>`;
        return;
    }
    const history = window.loadScheduleHistory(7);
    bunks.forEach(bunkName => {
        const bunkHeader = document.createElement('h3');
        bunkHeader.textContent = bunkName;
        bunkHeader.style.cssText = "background:#eee; padding:10px; margin:20px 0 0 0; border:1px solid #ccc; border-bottom:none; border-radius:5px 5px 0 0;";
        
        const tableDiv = document.createElement('div');
        tableDiv.style.cssText = "border:1px solid #ccc; border-top:none; margin-bottom:20px; overflow-x:auto;";
        
        reportContainer.appendChild(bunkHeader);
        reportContainer.appendChild(tableDiv);
        renderBunkReport(bunkName, tableDiv, false, history);
    });
}

function renderBunkReport(bunkName, targetContainer, clearContainer = true, preloadedHistory = null) {
    if (clearContainer) {
        targetContainer.innerHTML = `<p class="report-loading">Loading...</p>`;
    }

    const history = preloadedHistory || window.loadScheduleHistory(7);
    const historyDays = Object.keys(history).sort().reverse();
    
    // 1. Get Today's Schedule
    const todaySchedule = window.scheduleAssignments?.[bunkName] || [];
    const todayActivities = new Set();
    todaySchedule.forEach(entry => {
        if(entry && entry._activity) {
             todayActivities.add(entry._activity);
        }
    });

    // 2. Build Stats
    const report = {};
    allActivities.forEach(actObj => {
        report[actObj.name] = {
            count: 0,
            lastDone: "7+ days ago",
            isToday: todayActivities.has(actObj.name),
            type: actObj.type
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
                if (allActivities.some(a=>a.name===entry.sport)) activityName = entry.sport;
                else if (allActivities.some(a=>a.name===entry.field)) activityName = entry.field;
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
        <table class="report-table" style="width:100%; border-collapse:collapse;">
            <thead>
                <tr style="background:#f9f9f9; border-bottom:1px solid #ddd;">
                    <th style="padding:8px; text-align:left;">Activity</th>
                    <th style="padding:8px; text-align:center;">Scheduled Today?</th>
                    <th style="padding:8px; text-align:center;">Count (Last 7 Days)</th>
                    <th style="padding:8px; text-align:center;">Last Done</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    const sortedActivities = allActivities.sort((aObj, bObj) => {
        const a = aObj.name;
        const b = bObj.name;
        const rA = report[a];
        const rB = report[b];

        if (rA.isToday !== rB.isToday) return rB.isToday - rA.isToday;
        if (rA.count !== rB.count) return rA.count - rB.count; 
        if (rA.type !== rB.type) return rA.type === 'sport' ? -1 : 1; 
        return a.localeCompare(b); 
    });
    
    sortedActivities.forEach(actObj => {
        const actName = actObj.name;
        const data = report[actName];
        const isNeed = data.count === 0 && !data.isToday;
        const bg = isNeed ? "#e3f2fd" : "white"; 
        
        const checkMark = data.isToday ? '<span style="color:green;font-weight:bold;">YES</span>' : '<span style="color:#ccc;">-</span>';
        
        const typePill = data.type === 'sport' 
            ? '<span style="font-size:0.8em; background:#e3f2fd; color:#1565c0; padding:2px 6px; border-radius:4px;">Sport</span>'
            : '<span style="font-size:0.8em; background:#f3e5f5; color:#7b1fa2; padding:2px 6px; border-radius:4px;">Special</span>';

        tableHtml += `
            <tr style="background:${bg}; border-bottom:1px solid #eee;">
                <td style="padding:6px 8px;">${actName} ${typePill}</td>
                <td style="padding:6px 8px; text-align:center;">${checkMark}</td>
                <td style="padding:6px 8px; text-align:center;">${data.count}</td>
                <td style="padding:6px 8px; text-align:center;">${data.lastDone}</td>
            </tr>
        `;
    });
    
    tableHtml += `</tbody></table>`;
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
        const dateKey = `${y}-${m}-${dayStr}`;
        
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

    if (!document.getElementById("avail-filter-controls")) {
        availabilityContainer.innerHTML = `
            <div id="avail-filter-controls" style="margin-bottom:15px; display:flex; gap:15px; align-items:center; flex-wrap:wrap;">
                <h2 style="margin:0; font-size:1.5em; color:#1a5fb4;">Field Availability</h2>
                <select id="avail-type-filter" style="padding:5px; font-size:1rem;">
                    <option value="all">Show All Resources</option>
                    <option value="field">Fields Only</option>
                    <option value="special">Special Activities Only</option>
                </select>
                <div style="font-size:0.9em; color:#555;">
                    <strong>Key:</strong> 
                    <span style="color:#2e7d32; background:#e8f5e9; padding:0 4px; font-weight:bold;">✓</span> = Start Free. 
                    <span style="color:#c62828; background:#ffebee; padding:0 4px; font-weight:bold;">X</span> = Start Blocked.
                </div>
            </div>
            <div id="avail-grid-wrapper"></div>
        `;
        const filter = document.getElementById("avail-type-filter");
        if(filter) filter.onchange = renderFieldAvailabilityGrid;
    }
    
    const gridWrapper = document.getElementById("avail-grid-wrapper");
    if (gridWrapper) gridWrapper.innerHTML = "";
    
    const filterEl = document.getElementById("avail-type-filter");
    const filterType = filterEl ? filterEl.value : "all";

    const dailyData = window.loadCurrentDailyData?.() || {};
    const scheduleAssignments = dailyData.scheduleAssignments || {};
    const unifiedTimes = window.unifiedTimes || dailyData.unifiedTimes || [];
    const INCREMENT_MINS = window.INCREMENT_MINS || 30;

    if (unifiedTimes.length === 0) {
        if(gridWrapper) gridWrapper.innerHTML = `<p class="report-muted" style="padding:20px; background:#f0f0f0; text-align:center;">No schedule generated yet.</p>`;
        return;
    }

    const app1Data = window.loadGlobalSettings?.().app1 || {};
    const allFields = (app1Data.fields || []).map(f => ({...f, type: 'field'}));
    const allSpecials = (app1Data.specialActivities || []).map(s => ({...s, type: 'special'}));
    
    let resourcesToShow = [...allFields, ...allSpecials];
    if (filterType === 'field') resourcesToShow = allFields;
    if (filterType === 'special') resourcesToShow = allSpecials;
    
    resourcesToShow.sort((a,b) => a.name.localeCompare(b.name));

    // 3. Compile Usage (STRICT + TIMED)
    const fieldBookingsBySlot = {}; 
    
    for (const bunk in scheduleAssignments) {
        const schedule = scheduleAssignments[bunk] || [];
        for (let i = 0; i < schedule.length; i++) {
            const entry = schedule[i];
            if (entry) {
                const fieldName = fieldLabel(entry.field);
                if (fieldName && 
                    fieldName !== "Free" && 
                    fieldName !== "No Field" && 
                    fieldName !== "No Game" && 
                    fieldName !== "Unassigned League") {
                    
                    fieldBookingsBySlot[i] = fieldBookingsBySlot[i] || {};
                    if (!fieldBookingsBySlot[i][fieldName]) fieldBookingsBySlot[i][fieldName] = [];
                    
                    const slotObj = unifiedTimes[i];
                    
                    // IMPORTANT: Use entry.start/end if they exist, otherwise assume full slot
                    let s = entry.start;
                    let e = entry.end;
                    
                    if (!s && slotObj) s = slotObj.start; 
                    if (!e && s) {
                        const startMin = parseTimeToMinutes(s);
                        e = minutesToTime(startMin + INCREMENT_MINS);
                    }

                    fieldBookingsBySlot[i][fieldName].push({ start: s, end: e });
                }
            }
        }
    }

    const fieldProperties = {};
    resourcesToShow.forEach(f => {
        fieldProperties[f.name] = {
            available: f.available !== false,
            timeRules: f.timeRules || []
        };
    });

    // STYLES
    // styleCheck: Pure Green Background
    const styleCheck = "font-size:1.2em; color:#2e7d32; font-weight:900; background-color:#e8f5e9;";
    // styleX: Pure Red Background
    const styleX = "font-size:1.2em; color:#c62828; font-weight:700; background-color:#ffebee;";
    
    // stylePartialCheck: Green Background + Smaller Text
    const stylePartialCheck = "color:#2e7d32; font-weight:900; background-color:#e8f5e9; line-height:1.1;";
    
    // stylePartialX: Red Background + Smaller Text
    const stylePartialX = "color:#c62828; font-weight:700; background-color:#ffebee; line-height:1.1;";

    const styleXClosed = "font-size:1.2em; color:#b71c1c; font-weight:700; background-color:#ffcdd2;";

    let tableHtml = `<div class="schedule-view-wrapper"><table class="availability-grid" style="border-collapse:collapse; width:100%;"><thead><tr><th style="background:#f4f4f4; border:1px solid #999; padding:8px; position:sticky; top:0; z-index:5;">Time</th>`;
    
    resourcesToShow.forEach(r => {
        tableHtml += `<th style="background:#f4f4f4; border:1px solid #999; padding:8px; min-width:80px; position:sticky; top:0; z-index:5;">${r.name}</th>`;
    });
    tableHtml += `</tr></thead><tbody>`;

    unifiedTimes.forEach((slot, i) => {
        let timeLabel = "Invalid Time";
        let slotStartMin = 0;
        let slotEndMin = 0;

        try {
            let d = new Date(slot.start);
            if(isNaN(d.getTime())) {
                 const parts = String(slot.start).split(":");
                 d = new Date();
                 d.setHours(parts[0], parts[1], 0);
            }
            
            let h = d.getHours(), m = d.getMinutes();
            slotStartMin = h * 60 + m;
            slotEndMin = slotStartMin + INCREMENT_MINS;

            let ap = h >= 12 ? "PM" : "AM"; 
            h = h % 12 || 12;
            let mStr = m.toString().padStart(2,"0");
            timeLabel = `${h}:${mStr} ${ap}`;
        } catch(e) { timeLabel = slot.label || "Time?"; }
        
        tableHtml += `<tr><td style="border:1px solid #999; padding:6px; font-weight:bold; background:#fdfdfd; position:sticky; left:0; border-right:2px solid #ccc;">${timeLabel}</td>`;

        resourcesToShow.forEach(r => {
            const props = fieldProperties[r.name];
            const bookings = fieldBookingsBySlot[i]?.[r.name] || [];
            const timeAvail = isTimeAvailable(i, props);
            
            if (!timeAvail) {
                tableHtml += `<td style="${styleXClosed}; border:1px solid #999; text-align:center;" title="Closed by Time Rule">X</td>`;
            } 
            else if (bookings.length === 0) {
                // FULLY FREE
                tableHtml += `<td style="${styleCheck}; border:1px solid #999; text-align:center;" title="Available">✓</td>`;
            } 
            else {
                // HAS BOOKINGS
                bookings.sort((a, b) => parseTimeToMinutes(a.start) - parseTimeToMinutes(b.start));

                let isStartBlocked = false;
                let maxBlockedUntil = slotStartMin; 
                let earliestConflictStart = slotEndMin;

                bookings.forEach(b => {
                    const bStart = parseTimeToMinutes(b.start);
                    const bEnd = parseTimeToMinutes(b.end);
                    
                    if (bStart !== null && bEnd !== null) {
                         // Does this booking block the START?
                         if (bStart <= slotStartMin && bEnd > slotStartMin) {
                             isStartBlocked = true;
                             if (bEnd > maxBlockedUntil) maxBlockedUntil = bEnd;
                         }
                         
                         // When is the FIRST conflict?
                         if (bStart > slotStartMin && bStart < earliestConflictStart) {
                             earliestConflictStart = bStart;
                         }
                    }
                });

                // RENDER LOGIC
                if (isStartBlocked) {
                    // --- SCENARIO 1: Starts Blocked (Red X) ---
                    // Logic: Extend maxBlockedUntil if overlaps exist
                    let extended = true;
                    while(extended) {
                        extended = false;
                        bookings.forEach(b => {
                             const s = parseTimeToMinutes(b.start);
                             const e = parseTimeToMinutes(b.end);
                             if (s !== null && e !== null) {
                                 if (s <= maxBlockedUntil && e > maxBlockedUntil) {
                                     maxBlockedUntil = e;
                                     extended = true;
                                 }
                             }
                        });
                    }

                    if (maxBlockedUntil >= slotEndMin) {
                        // Fully Blocked
                        tableHtml += `<td style="${styleX}; border:1px solid #999; text-align:center;" title="Occupied">X</td>`;
                    } else {
                        // Partial (Starts X, Opens Later)
                        const tStr = minutesToTime(maxBlockedUntil);
                        tableHtml += `<td style="${stylePartialX}; border:1px solid #999; text-align:center; vertical-align:middle;" title="Opens later">
                            <span style="font-size:1.2em;">X</span><br>
                            <span style="font-size:0.7em; font-weight:normal;">Avail @ ${tStr}</span>
                        </td>`;
                    }
                } else {
                    // --- SCENARIO 2: Starts Free (Green Check) ---
                    if (earliestConflictStart >= slotEndMin) {
                        // Effectively free (bookings just touch edges)
                        tableHtml += `<td style="${styleCheck}; border:1px solid #999; text-align:center;" title="Available">✓</td>`;
                    } else {
                        // Partial (Starts Check, Closes Later)
                        const tStr = minutesToTime(earliestConflictStart);
                        tableHtml += `<td style="${stylePartialCheck}; border:1px solid #999; text-align:center; vertical-align:middle;" title="Closes soon">
                            <span style="font-size:1.2em;">✓</span><br>
                            <span style="font-size:0.7em; font-weight:normal;">Unavail @ ${tStr}</span>
                        </td>`;
                    }
                }
            }
        });
        tableHtml += `</tr>`;
    });
    
    tableHtml += `</tbody></table></div>`;
    if(gridWrapper) gridWrapper.innerHTML = tableHtml;
}


window.initReportTab = initReportTab;

})();
