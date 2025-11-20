// -------------------- scheduler_ui.js (MODERNIZED) --------------------
(function() {
'use strict';
const INCREMENT_MINS = 30;

function parseTimeToMinutes(str) { /* Standard helper logic */ if(!str)return null; let s=str.trim().toLowerCase(),mer=null; if(s.endsWith('am')||s.endsWith('pm')){mer=s.endsWith('am')?'am':'pm';s=s.replace(/am|pm/g,'').trim();} const m=s.match(/^(\d{1,2})\s*:\s*(\d{2})$/); if(!m)return null; let hh=parseInt(m[1],10),mm=parseInt(m[2],10); if(mer){if(hh===12)hh=mer==='am'?0:12;else if(mer==='pm')hh+=12;} return hh*60+mm; }
function fieldLabel(f) { return (typeof f==="string")?f: (f&&f.name)?f.name:""; }
function minutesToTimeLabel(min) { if(min==null||isNaN(min))return""; let h=Math.floor(min/60),m=min%60,ap=h>=12?"PM":"AM"; h=h%12||12; return `${h}:${String(m).padStart(2,"0")} ${ap}`; }

const UI_GENERATED_EVENTS = new Set(["activity","activities","general activity","general activity slot","sports","sport","sports slot","special activity","league game","specialty league","swim"]);
function uiIsGeneratedEventName(name) { return name && UI_GENERATED_EVENTS.has(String(name).trim().toLowerCase()); }
function findSlotsForRange(startMin, endMin) { const slots=[]; if(!window.unifiedTimes)return slots; for(let i=0;i<window.unifiedTimes.length;i++){ const s=new Date(window.unifiedTimes[i].start).getHours()*60+new Date(window.unifiedTimes[i].start).getMinutes(); if(s>=startMin && s<endMin) slots.push(i); } return slots; }

function editCell(bunkName, startMin, endMin, currentActivity) {
  if (!bunkName) return;
  const newActivityName = prompt(`Edit activity for ${bunkName} (${minutesToTimeLabel(startMin)} - ${minutesToTimeLabel(endMin)}):\n(Type 'CLEAR' to empty)`, currentActivity);
  if (newActivityName === null) return;
  
  const finalName = newActivityName.trim();
  const slots = findSlotsForRange(startMin, endMin);
  if (!slots.length) return;
  
  if (!window.scheduleAssignments[bunkName]) window.scheduleAssignments[bunkName] = new Array(window.unifiedTimes.length);
  
  const isClear = !finalName || finalName.toUpperCase()==='CLEAR' || finalName.toUpperCase()==='FREE';
  slots.forEach((slotIndex, idx) => {
    window.scheduleAssignments[bunkName][slotIndex] = {
        field: isClear ? "Free" : finalName,
        sport: null,
        continuation: idx > 0,
        _fixed: true,
        _h2h: false,
        _activity: isClear ? "Free" : finalName
    };
  });
  saveSchedule();
  updateTable();
}

function updateTable() {
  const container = document.getElementById("scheduleTable");
  if (!container) return;
  renderStaggeredView(container);
}

function getEntry(bunk, slotIndex) {
  const a = window.scheduleAssignments || {};
  return (a[bunk] && a[bunk][slotIndex]) ? a[bunk][slotIndex] : null;
}

function formatEntry(entry) {
  if (!entry) return "";
  if (entry._isDismissal) return "Dismissal";
  if (entry._isSnack) return "Snacks";
  const label = fieldLabel(entry.field) || "";
  if (entry._h2h) return entry.sport || "League Game";
  if (entry._fixed) return label || entry._activity || "";
  if (entry.sport) return `${label} – ${entry.sport}`;
  return label;
}

function findFirstSlotForTime(startMin) {
  if (startMin===null || !window.unifiedTimes) return -1;
  for (let i=0; i<window.unifiedTimes.length; i++) {
    const s = new Date(window.unifiedTimes[i].start).getHours()*60 + new Date(window.unifiedTimes[i].start).getMinutes();
    if(s>=startMin && s<startMin+INCREMENT_MINS) return i;
  }
  return -1;
}

function renderStaggeredView(container) {
  container.innerHTML = "";
  const availableDivisions = window.availableDivisions || [];
  const divisions = window.divisions || {};
  const dailyData = window.loadCurrentDailyData?.() || {};
  const manualSkeleton = dailyData.manualSkeleton || [];
  const prevDailyData = window.loadPreviousDailyData?.() || {};
  const prevCounters = prevDailyData.leagueDayCounters || {};
  const todayCounters = {};

  if (manualSkeleton.length === 0) {
    container.innerHTML = "<div class='alert alert-info'>No schedule built for this day. Go to 'Daily Adjustments'.</div>";
    return;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "schedule-view-wrapper";
  container.appendChild(wrapper);

  availableDivisions.forEach((div) => {
    const bunks = (divisions[div]?.bunks || []).sort();
    if (bunks.length === 0) return;

    const table = document.createElement("table");
    table.className = "schedule-table"; 

    // Header
    const thead = document.createElement("thead");
    const tr1 = document.createElement("tr");
    const thDiv = document.createElement("th");
    thDiv.colSpan = 1 + bunks.length;
    thDiv.textContent = div;
    // Inline background required for dynamic user color preference
    thDiv.style.backgroundColor = divisions[div]?.color || '#333';
    thDiv.style.color = '#fff';
    tr1.appendChild(thDiv);

    const tr2 = document.createElement("tr");
    const thTime = document.createElement("th");
    thTime.textContent = "Time";
    thTime.className = "th-time";
    tr2.appendChild(thTime);

    bunks.forEach(b => {
        const thBunk = document.createElement("th");
        thBunk.textContent = b;
        tr2.appendChild(thBunk);
    });
    thead.appendChild(tr1);
    thead.appendChild(tr2);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    
    // --- BLOCK BUILDER LOGIC (Same as before) ---
    const tempSortedBlocks = [];
    manualSkeleton.forEach((item) => {
      if (item.division === div) {
        const startMin = parseTimeToMinutes(item.startTime);
        const endMin = parseTimeToMinutes(item.endTime);
        if (startMin === null || endMin === null) return;
        tempSortedBlocks.push({ item, startMin, endMin });
      }
    });
    tempSortedBlocks.sort((a, b) => a.startMin - b.startMin);

    let todayLeagueCount = (prevCounters[div] || {}).league || 0;
    let todaySpecialtyCount = (prevCounters[div] || {}).specialty || 0;
    const divisionBlocks = [];

    tempSortedBlocks.forEach((block) => {
      let eventName = block.item.event;
      if (block.item.event === "League Game") eventName = `League Game ${++todayLeagueCount}`;
      else if (block.item.event === "Specialty League") eventName = `Specialty League ${++todaySpecialtyCount}`;

      divisionBlocks.push({
        label: `${minutesToTimeLabel(block.startMin)} - ${minutesToTimeLabel(block.endMin)}`,
        startMin: block.startMin, endMin: block.endMin, event: eventName, type: block.item.type
      });
    });
    todayCounters[div] = { league: todayLeagueCount, specialty: todaySpecialtyCount };

    const uniqueBlocks = divisionBlocks.filter((b, i, s) => i === s.findIndex((t) => t.label === b.label));
    const flattenedBlocks = [];
    uniqueBlocks.forEach((block) => {
      if (block.type === "split" && block.startMin!==null && block.endMin!==null) {
        const mid = Math.round(block.startMin + (block.endMin - block.startMin) / 2);
        flattenedBlocks.push({ ...block, label: `${minutesToTimeLabel(block.startMin)} - ${minutesToTimeLabel(mid)}`, endMin: mid, splitPart: 1 });
        flattenedBlocks.push({ ...block, label: `${minutesToTimeLabel(mid)} - ${minutesToTimeLabel(block.endMin)}`, startMin: mid, splitPart: 2 });
      } else flattenedBlocks.push(block);
    });
    // --- END LOGIC ---

    if (flattenedBlocks.length === 0) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="${bunks.length + 1}" class="text-muted text-center p-4">No schedule blocks found.</td>`;
      tbody.appendChild(tr);
    }

    flattenedBlocks.forEach((eventBlock) => {
      const tr = document.createElement("tr");
      
      // Time
      const tdTime = document.createElement("td");
      tdTime.className = "time-cell";
      tdTime.textContent = eventBlock.label;
      tr.appendChild(tdTime);

      // Content
      const isLeague = eventBlock.event.startsWith("League Game") || eventBlock.event.startsWith("Specialty League");

      if (isLeague) {
        const tdLeague = document.createElement("td");
        tdLeague.colSpan = bunks.length;
        tdLeague.className = "cell-league-merged"; // New class

        const firstSlot = findFirstSlotForTime(eventBlock.startMin);
        let allMatchups = [];
        if (bunks.length > 0) {
            const ent = getEntry(bunks[0], firstSlot);
            if (ent && ent._allMatchups) allMatchups = ent._allMatchups;
        }
        
        let html = `<div class="fw-bold mb-1">${eventBlock.event}</div>`;
        if (allMatchups.length) {
            html += `<ul class="matchup-list">` + allMatchups.map(m=>`<li>${m}</li>`).join('') + `</ul>`;
        } else {
            html += `<div class="text-muted small">(No matchups)</div>`;
        }
        tdLeague.innerHTML = html;
        tr.appendChild(tdLeague);
      } else {
        // Standard Cells
        const rawName = (eventBlock.event || "").toLowerCase();
        const isDismissal = rawName.includes("dismiss");
        const isSnack = rawName.includes("snack");
        let isGen = uiIsGeneratedEventName(rawName) || (rawName.includes("/") && rawName.split("/").some(p=>UI_GENERATED_EVENTS.has(p.trim())));
        const isPin = !isGen && !isDismissal && !isSnack;

        bunks.forEach(bunk => {
            const td = document.createElement("td");
            td.className = "schedule-cell"; // Base class
            
            const slotIndex = findFirstSlotForTime(eventBlock.startMin);
            const entry = getEntry(bunk, slotIndex);
            
            let text = rawName;
            // Determine specific styling class
            if (isDismissal) {
                td.classList.add("cell-dismissal");
                text = "Dismissal";
            } else if (isSnack) {
                td.classList.add("cell-snack");
                text = "Snacks";
            } else if (isPin) {
                td.classList.add("cell-pin");
            } else {
                // Generated logic
                if (entry) {
                    text = formatEntry(entry);
                    if (entry._h2h) td.classList.add("cell-league");
                    else if (entry._fixed) td.classList.add("cell-pin");
                }
            }
            td.textContent = text;
            td.onclick = () => editCell(bunk, eventBlock.startMin, eventBlock.endMin, text);
            tr.appendChild(td);
        });
      }
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrapper.appendChild(table);
  });
  window.saveCurrentDailyData?.("leagueDayCounters", todayCounters);
}

function saveSchedule() {
  try {
    window.saveCurrentDailyData?.("scheduleAssignments", window.scheduleAssignments);
    window.saveCurrentDailyData?.("leagueAssignments", window.leagueAssignments);
    window.saveCurrentDailyData?.("unifiedTimes", window.unifiedTimes);
  } catch (e) {}
}

function reconcileOrRenderSaved() {
  try {
    const data = window.loadCurrentDailyData?.() || {};
    window.scheduleAssignments = data.scheduleAssignments || {};
    window.leagueAssignments = data.leagueAssignments || {};
    const savedTimes = data.unifiedTimes || [];
    window.unifiedTimes = savedTimes.map((slot) => ({ ...slot, start: new Date(slot.start), end: new Date(slot.end) }));
  } catch (e) {
    window.scheduleAssignments = {}; window.leagueAssignments = {}; window.unifiedTimes = [];
  }
  updateTable();
}

function initScheduleSystem() {
  try {
    window.scheduleAssignments = window.scheduleAssignments || {};
    window.leagueAssignments = window.leagueAssignments || {};
    reconcileOrRenderSaved();
  } catch (e) { updateTable(); }
}

window.updateTable = window.updateTable || updateTable;
window.initScheduleSystem = window.initScheduleSystem || initScheduleSystem;
window.saveSchedule = window.saveSchedule || saveSchedule;
})();
