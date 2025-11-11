// =================================================================
// daily_overrides.js
//
// UPDATED:
// - **CRITICAL FIX:** `loadDailySkeleton` has been rewritten.
//   - It now *first* checks for a `manualSkeleton` saved
//     to the specific day.
//   - If one is *not* found, it falls back to loading the
//     correct day-of-week assigned template (e.g., "Friday Short").
// - **NEW FEATURE:** `createOverrideMasterListItem` now adds an
//   on/off toggle to each item in the master lists.
// - `init` now loads/saves these new disabled lists
//   (disabledFields, disabledSpecials) to the daily `overrides` object.
// - `renderOverrideMasterLists` now reads this new data to set
//   the toggle state.
// =================================================================

(function() {
'use strict';

let container = null;
let masterSettings = {};
// Add new disabled lists to the overrides object
let currentOverrides = {
  dailyFieldAvailability: {},
  leagues: [],
  disabledSpecialtyLeagues: [],
  dailyDisabledSportsByField: {},
  disabledFields: [],    // <-- NEW
  disabledSpecials: [] // <-- NEW
};

// --- Helper containers ---
let skeletonContainer = null;
let tripsFormContainer = null;
// --- NEW UI Elements ---
let selectedOverrideId = null; // e.g., "field-Court 1", "league-5th Grade"
let overrideFieldsListEl = null;
let overrideSpecialsListEl = null;
let overrideLeaguesListEl = null;
let overrideSpecialtyLeaguesListEl = null;
let overrideDetailPaneEl = null;

// =================================================================
// ===== START: SKELETON EDITOR LOGIC =====
// =================================================================

let dailyOverrideSkeleton = []; 
const PIXELS_PER_MINUTE = 2;
const INCREMENT_MINS = 30;

const TILES = [
    { type: 'activity', name: 'Activity', style: 'background: #e0f7fa; border: 1px solid #007bff;', description: "A flexible slot. The optimizer will fill this with the best available Sport OR Special Activity based on availability and rotation." },
    { type: 'sports', name: 'Sports', style: 'background: #dcedc8; border: 1px solid #689f38;', description: "A dedicated sports slot. The optimizer will fill this *only* with a Sport (e.g., Basketball, Soccer) from your 'Fields' list." },
    { type: 'special', name: 'Special Activity', style: 'background: #e8f5e9; border: 1px solid #43a047;', description: "A dedicated special slot. The optimizer will fill this *only* with a Special Activity (e.g., Canteen, Arts & Crafts) from your 'Special Activities' list." },
    { type: 'split', name: 'Split Activity', style: 'background: #fff3e0; border: 1px solid #f57c00;', description: "Creates a block that is split in two. You will be asked to name two different activities (e.g., Swim / Activity). The division will be split, and they will switch activities halfway through the block." },
    { type: 'league', name: 'League Game', style: 'background: #d1c4e9; border: 1px solid #5e35b1;', description: "A dedicated slot for a regular League Game. The optimizer will automatically create matchups from your 'Leagues' tab (e.g., Team A vs. Team B) and find a field for them." },
    { type: 'specialty_league', name: 'Specialty League', style: 'background: #fff8e1; border: 1px solid #f9a825;', description: "A dedicated slot for a Specialty League. The optimizer will create matchups from your custom teams (e.g., Blue vs. Gold) and assign them to their exclusive fields." },
    { type: 'swim', name: 'Swim', style: 'background: #bbdefb; border: 1px solid #1976d2;', description: "A 'pinned' event. The optimizer will block out this time for 'Swim' and will not schedule anything else here. This is a simple block and does not use the optimizer." },
    { type: 'lunch', name: 'Lunch', style: 'background: #fbe9e7; border: 1px solid #d84315;', description: "A 'pinned' event. The optimizer will block out this time for 'Lunch' and will not schedule anything else here. This is a simple block and does not use the optimizer." },
    { type: 'snacks', name: 'Snacks', style: 'background: #fff9c4; border: 1px solid #fbc02d;', description: "A 'pinned' event. The optimizer will block out this time for 'Snacks' and will not schedule anything else here. This is a simple block and does not use the optimizer." },
    { type: 'custom', name: 'Custom Pinned Event', style: 'background: #eee; border: 1px solid #616161;', description: "A 'pinned' event. You will be asked to give it a custom name (e.g., 'Assembly' or 'Trip'). The optimizer will block out this time and will not schedule anything else here." }
];

function mapEventNameForOptimizer(name) {
    if (!name) name = "Free";
    const lowerName = name.toLowerCase().trim();
    if (lowerName === 'activity') return { type: 'slot', event: 'General Activity Slot' };
    if (lowerName === 'sports') return { type: 'slot', event: 'Sports Slot' };
    if (lowerName === 'special activity' || lowerName === 'special') return { type: 'slot', event: 'Special Activity' };
    if (lowerName === 'swim' || lowerName === 'lunch' || lowerName === 'snacks') return { type: 'pinned', event: name };
    return { type: 'pinned', event: name };
}

/**
 * Renders the draggable tiles
 */
function renderPalette(paletteContainer) {
    paletteContainer.innerHTML = '<span style="font-weight: 600; align-self: center;">Drag to add:</span>';
    TILES.forEach(tile => {
        const el = document.createElement('div');
        el.className = 'grid-tile-draggable';
        el.textContent = tile.name;
        el.style.cssText = tile.style;
        el.style.padding = '8px 12px';
        el.style.borderRadius = '5px';
        el.style.cursor = 'grab';

        el.onclick = () => alert(tile.description);
        
        el.draggable = true;
        el.ondragstart = (e) => {
            e.dataTransfer.setData('application/json', JSON.stringify(tile));
            e.dataTransfer.effectAllowed = 'copy';
            el.style.cursor = 'grabbing';
        };
        el.ondragend = () => { el.style.cursor = 'grab'; };
        paletteContainer.appendChild(el);
    });
}

function renderGrid(gridContainer) {
    const divisions = window.divisions || {};
    const availableDivisions = window.availableDivisions || [];
    
    const globalSettings = window.loadGlobalSettings?.() || {};
    const app1Data = globalSettings.app1 || {};
    const globalStart = app1Data.globalStartTime || "9:00 AM";
    const globalEnd = app1Data.globalEndTime || "4:00 PM";
    
    let earliestMin = parseTimeToMinutes(globalStart);
    let latestMin = parseTimeToMinutes(globalEnd);

    if (earliestMin == null) earliestMin = 540; 
    if (latestMin == null) latestMin = 960; 
    if (latestMin <= earliestMin) latestMin = earliestMin + 60; 
    
    const totalMinutes = latestMin - earliestMin;
    const totalHeight = totalMinutes * PIXELS_PER_MINUTE;
    let gridHtml = `<div style="display: grid; grid-template-columns: 60px repeat(${availableDivisions.length}, 1fr); position: relative;">`;
    gridHtml += `<div style="grid-row: 1; position: sticky; top: 0; background: #fff; z-index: 10; border-bottom: 1px solid #999; padding: 8px;">Time</div>`;
    availableDivisions.forEach((divName, i) => {
        gridHtml += `<div style="grid-row: 1; grid-column: ${i + 2}; position: sticky; top: 0; background: ${divisions[divName]?.color || '#333'}; color: #fff; z-index: 10; border-bottom: 1px solid #999; padding: 8px; text-align: center;">${divName}</div>`;
    });
    gridHtml += `<div style="grid-row: 2; grid-column: 1; height: ${totalHeight}px; position: relative; background: #f9f9f9; border-right: 1px solid #ccc;">`;
    for (let min = earliestMin; min < latestMin; min += INCREMENT_MINS) {
        const top = (min - earliestMin) * PIXELS_PER_MINUTE;
        gridHtml += `<div style="position: absolute; top: ${top}px; left: 0; width: 100%; height: ${INCREMENT_MINS * PIXELS_PER_MINUTE}px; border-bottom: 1px dashed #ddd; box-sizing: border-box; font-size: 10px; padding: 2px; color: #777;">${minutesToTime(min)}</div>`;
    }
    gridHtml += `</div>`;
    availableDivisions.forEach((divName, i) => {
        gridHtml += `<div class="grid-cell" data-div="${divName}" data-start-min="${earliestMin}" style="grid-row: 2; grid-column: ${i + 2}; position: relative; height: ${totalHeight}px; border-right: 1px solid #ccc;">`;
        
        dailyOverrideSkeleton.filter(ev => ev.division === divName).forEach(event => {
            const startMin = parseTimeToMinutes(event.startTime);
            const endMin = parseTimeToMinutes(event.endTime);
            if (startMin == null || endMin == null) return;
            
            const visibleStartMin = Math.max(startMin, earliestMin);
            const visibleEndMin = Math.min(endMin, latestMin);

            if (visibleEndMin <= visibleStartMin) return; 

            const top = (visibleStartMin - earliestMin) * PIXELS_PER_MINUTE;
            const height = (visibleEndMin - visibleStartMin) * PIXELS_PER_MINUTE;
            
            gridHtml += renderEventTile(event, top, height);
        });
        gridHtml += `</div>`;
    });
    gridHtml += `</div>`;
    gridContainer.innerHTML = gridHtml;
    addDropListeners(gridContainer);
    addRemoveListeners(gridContainer);
}
function addDropListeners(gridContainer) {
    gridContainer.querySelectorAll('.grid-cell').forEach(cell => {
        cell.ondragover = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; cell.style.backgroundColor = '#e0ffe0'; };
        cell.ondragleave = () => { cell.style.backgroundColor = ''; };
        cell.ondrop = (e) => {
            e.preventDefault();
            cell.style.backgroundColor = '';
            const tileData = JSON.parse(e.dataTransfer.getData('application/json'));
            const divName = cell.dataset.div;
            const rect = cell.getBoundingClientRect();
            const scrollTop = cell.closest('#daily-skeleton-grid')?.scrollTop || 0; 
            const y = e.clientY - rect.top + scrollTop;
            const droppedMin = Math.round(y / PIXELS_PER_MINUTE / 15) * 15;
            const earliestMin = parseInt(cell.dataset.startMin, 10);
            const defaultStartTime = minutesToTime(earliestMin + droppedMin);
            let eventType = 'slot';
            let eventName = tileData.name;
            let newEvent = null; 
            if (tileData.type === 'activity') eventName = 'General Activity Slot';
            else if (tileData.type === 'sports') eventName = 'Sports Slot';
            else if (tileData.type === 'special') eventName = 'Special Activity';
            else if (tileData.type === 'league' || tileData.type === 'specialty_league' || tileData.type === 'swim') eventName = tileData.name; 
            if (tileData.type === 'split') {
                const startTime = prompt(`Enter Start Time for the *full* block:`, defaultStartTime); if (!startTime) return;
                const endTime = prompt(`Enter End Time for the *full* block:`); if (!endTime) return;
                const eventName1 = prompt("Enter name for FIRST activity (e.g., Swim, Sports):"); if (!eventName1) return;
                const eventName2 = prompt("Enter name for SECOND activity (e.g., Activity, Sports):"); if (!eventName2) return;
                const event1 = mapEventNameForOptimizer(eventName1);
                const event2 = mapEventNameForOptimizer(eventName2);
                newEvent = { id: `evt_${Math.random().toString(36).slice(2, 9)}`, type: 'split', event: `${eventName1} / ${eventName2}`, division: divName, startTime: startTime, endTime: endTime, subEvents: [ event1, event2 ] };
            } else if (tileData.type === 'lunch' || tileData.type === 'snacks' || tileData.type === 'custom') {
                eventType = 'pinned';
                if (tileData.type === 'custom') {
                    eventName = prompt("Enter the name for this custom event (e.g., 'Snacks'):"); if (!eventName) return;
                    if (confirm("Is this a 'Slot' to be filled (OK) or a 'Pinned' event (Cancel)?")) eventType = 'slot';
                } else { eventName = tileData.name; }
            }
            if (!newEvent) {
                const startTime = prompt(`Add "${eventName}" for ${divName}?\nEnter Start Time:`, defaultStartTime); if (!startTime) return;
                const endTime = prompt(`Enter End Time:`); if (!endTime) return;
                newEvent = { id: `evt_${Math.random().toString(36).slice(2, 9)}`, type: eventType, event: eventName, division: divName, startTime: startTime, endTime: endTime };
            }
            dailyOverrideSkeleton.push(newEvent);
            saveDailySkeleton(); 
            renderGrid(gridContainer); 
        };
    });
}
function addRemoveListeners(gridContainer) {
    gridContainer.querySelectorAll('.grid-event').forEach(tile => {
        tile.onclick = (e) => {
            e.stopPropagation(); 
            const eventId = tile.dataset.eventId; if (!eventId) return;
            const event = dailyOverrideSkeleton.find(ev => ev.id === eventId);
            if (confirm(`Remove "${event?.event || 'this event'}"?`)) {
                dailyOverrideSkeleton = dailyOverrideSkeleton.filter(ev => ev.id !== eventId);
                saveDailySkeleton(); 
                renderGrid(gridContainer); 
            }
        };
    });
}
function renderEventTile(event, top, height) {
    let tile = TILES.find(t => t.name === event.event);
    if (!tile) {
        if (event.type === 'split') tile = TILES.find(t => t.type === 'split');
        else if (event.event === 'General Activity Slot') tile = TILES.find(t => t.type === 'activity');
        else if (event.event === 'Sports Slot') tile = TILES.find(t => t.type === 'sports');
        else if (event.event === 'Special Activity') tile = TILES.find(t => t.type === 'special');
        else tile = TILES.find(t => t.type === 'custom');
    }
    const style = tile ? tile.style : 'background: #eee; border: 1px solid #616161;';
    let tripStyle = '';
    if (event.type === 'pinned' && tile.type === 'custom') {
        tripStyle = 'background: #455a64; color: white; border: 1px solid #000;';
    }
    return `
        <div class="grid-event" data-event-id="${event.id}" title="Click to remove this event"
             style="${tripStyle || style}; padding: 2px 5px; border-radius: 4px; text-align: center; 
                    margin: 0 1px; font-size: 0.9em; position: absolute;
                    top: ${top}px; height: ${height}px; width: calc(100% - 4px);
                    box-sizing: border-box; overflow: hidden; cursor: pointer;">
            <strong>${event.event}</strong>
            <div style="font-size: 0.85em;">${event.startTime} - ${event.endTime}</div>
        </div>`;
}

// --- THIS IS THE KEY FIX ---
function loadDailySkeleton() {
    // 1. Check for a saved *daily* override first.
    const dailyData = window.loadCurrentDailyData?.() || {};
    if (dailyData.manualSkeleton && dailyData.manualSkeleton.length > 0) {
        // A skeleton has been saved for this specific day. Load it.
        dailyOverrideSkeleton = JSON.parse(JSON.stringify(dailyData.manualSkeleton));
        return; // Stop here.
    }
    
    // 2. No daily override exists. Load the default template
    //    based on the day of the week (same as master builder).
    const assignments = window.getSkeletonAssignments?.() || {};
    const skeletons = window.getSavedSkeletons?.() || {};
    
    const dateStr = window.currentScheduleDate || "";
    const [year, month, day] = dateStr.split('-').map(Number);
    let dayOfWeek = 0;
    if (year && month && day) {
        const date = new Date(year, month - 1, day);
        dayOfWeek = date.getDay();
    }
    
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const todayName = dayNames[dayOfWeek];

    let templateName = assignments[todayName]; // Try specific day
    if (!templateName || !skeletons[templateName]) {
        templateName = assignments["Default"]; // Fall back to Default
    }
    
    let skeletonToLoad = skeletons[templateName]; 
    
    if (skeletonToLoad) {
        // Deep-copy the template
        dailyOverrideSkeleton = JSON.parse(JSON.stringify(skeletonToLoad));
    } else {
        // Final fallback
        dailyOverrideSkeleton = [];
    }
}
// --- END OF FIX ---

function saveDailySkeleton() {
    // This saves the skeleton *to this specific day*,
    // which is what we check for in loadDailySkeleton()
    window.saveCurrentDailyData?.("manualSkeleton", dailyOverrideSkeleton);
}
function minutesToTime(min) {
    const hh = Math.floor(min / 60); const mm = min % 60;
    const h = hh % 12 === 0 ? 12 : hh % 12;
    const m = String(mm).padStart(2, '0');
    const ampm = hh < 12 ? 'am' : 'pm';
    return `${h}:${m}${ampm}`;
}
function initDailySkeletonUI() {
    skeletonContainer = document.getElementById("override-scheduler-content");
    if (!skeletonContainer) return;
    loadDailySkeleton();
    skeletonContainer.innerHTML = `
        <div id="daily-skeleton-palette" style="padding: 10px; background: #f4f4f4; border-radius: 8px; margin-bottom: 15px; display: flex; flex-wrap: wrap; gap: 10px;"></div>
        <div id="daily-skeleton-grid" style="overflow-x: auto; border: 1px solid #999; max-height: 600px; overflow-y: auto;"></div>`;
    const palette = document.getElementById("daily-skeleton-palette");
    const grid = document.getElementById("daily-skeleton-grid");
    renderPalette(palette);
    renderGrid(grid);
}
// =================================================================
// ===== END: SKELETON EDITOR LOGIC =====
// =================================================================


/**
 * This is a copy of the helper from scheduler_logic_core.js
 * It's needed here for validation.
 */
function parseTimeToMinutes(str) {
  if (!str || typeof str !== "string") return null;
  let s = str.trim().toLowerCase();
  let mer = null;
  if (s.endsWith("am") || s.endsWith("pm")) {
    mer = s.endsWith("am") ? "am" : "pm";
    s = s.replace(/am|pm/g, "").trim();
  }
  const m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (Number.isNaN(hh) || Number.isNaN(mm) || mm < 0 || mm > 59) return null;
  if (mer) {
    if (hh === 12) hh = mer === "am" ? 0 : 12; // 12am -> 0, 12pm -> 12
    else if (mer === "pm") hh += 12; // 1pm -> 13
  }
  return hh * 60 + mm;
}

/**
* Main entry point. Called by index.html tab click or calendar.js date change.
*/
function init() {
  container = document.getElementById("daily-overrides-content");
  if (!container) {
    console.error("Daily Overrides: Could not find container #daily-overrides-content");
    return;
  }

  console.log("Daily Overrides: Initializing for", window.currentScheduleDate);
  
  // --- UPDATED: Removed the "Daily Sport Availability" section ---
  container.innerHTML = `
    <h2>Overrides & Trips for ${window.currentScheduleDate}</h2>
    
    <div class="override-section" id="daily-skeleton-editor-section">
      <h3>Daily Skeleton Override</h3>
      <p style="font-size: 0.9em; color: #555;">
        Modify the schedule layout for <strong>this day only</strong>.
        Changes here will be saved for this day.
      </p>
      <div id="override-scheduler-content"></div>
    </div>
    
    <div class="override-section" id="daily-trips-section">
      <h3>Daily Trips (Adds to Skeleton)</h3>
      <div id="trips-form-container"></div>
    </div>

    <div class="override-section" id="other-overrides-section">
      <h3>Daily Overrides (Fields, Leagues, etc.)</h3>
      <div style="display: flex; flex-wrap: wrap; gap: 20px;">
          
          <div style="flex: 1; min-width: 300px;">
              <h4>Fields</h4>
              <div id="override-fields-list" class="master-list"></div>
              
              <h4 style="margin-top: 15px;">Special Activities</h4>
              <div id="override-specials-list" class="master-list"></div>
              
              <h4 style="margin-top: 15px;">Leagues</h4>
              <div id="override-leagues-list" class="master-list"></div>
              
              <h4 style="margin-top: 15px;">Specialty Leagues</h4>
              <div id="override-specialty-leagues-list" class="master-list"></div>
          </div>

          <div style="flex: 2; min-width: 400px; position: sticky; top: 20px;">
              <h4>Details</h4>
              <div id="override-detail-pane" class="detail-pane">
                  <p class="muted">Select an item from the left to edit its daily override.</p>
              </div>
          </div>
      </div>
    </div>
    
    <style>
        .master-list .list-item {
            padding: 10px 8px;
            border: 1px solid #ddd;
            border-radius: 5px;
            margin-bottom: 3px;
            cursor: pointer;
            background: #fff;
            font-size: 0.95em;
            /* NEW: Flex layout for toggle */
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .master-list .list-item:hover {
            background: #f9f9f9;
        }
        .master-list .list-item.selected {
            background: #e7f3ff;
            border-color: #007bff;
        }
        .master-list .list-item-name {
            font-weight: 600;
            flex-grow: 1;
        }
        .master-list .list-item.selected .list-item-name {
            font-weight: 700;
        }
        .detail-pane {
            border: 1px solid #ccc;
            border-radius: 8px;
            padding: 20px;
            background: #fdfdfd;
            min-height: 300px;
        }
        .sport-override-list {
            margin-top: 15px;
            padding-top: 15px;
            border-top: 1px solid #eee;
        }
        .sport-override-list label {
            display: block;
            margin: 5px 0 5px 10px;
            font-size: 1.0em;
        }
        .sport-override-list label input {
            margin-right: 8px;
            vertical-align: middle;
        }
    </style>
  `;

  // Get references to the containers
  skeletonContainer = document.getElementById("override-scheduler-content");
  tripsFormContainer = document.getElementById("trips-form-container");
  
  overrideFieldsListEl = document.getElementById("override-fields-list");
  overrideSpecialsListEl = document.getElementById("override-specials-list");
  overrideLeaguesListEl = document.getElementById("override-leagues-list");
  overrideSpecialtyLeaguesListEl = document.getElementById("override-specialty-leagues-list");
  overrideDetailPaneEl = document.getElementById("override-detail-pane");


  // 1. Load Master "Setup" Data
  masterSettings.global = window.loadGlobalSettings?.() || {};
  masterSettings.app1 = masterSettings.global.app1 || {};
  masterSettings.leaguesByName = masterSettings.global.leaguesByName || {};
  masterSettings.specialtyLeagues = masterSettings.global.specialtyLeagues || {};

  // 2. Load the data for the *current* day
  const dailyData = window.loadCurrentDailyData?.() || {};
  const dailyOverrides = dailyData.overrides || {}; // Get the whole overrides object
  
  currentOverrides.dailyFieldAvailability = dailyData.dailyFieldAvailability || {};
  currentOverrides.leagues = dailyOverrides.leagues || [];
  currentOverrides.disabledSpecialtyLeagues = dailyData.disabledSpecialtyLeagues || [];
  currentOverrides.dailyDisabledSportsByField = dailyData.dailyDisabledSportsByField || {}; 
  
  // --- NEW: Load disabled fields/specials ---
  currentOverrides.disabledFields = dailyOverrides.disabledFields || [];
  currentOverrides.disabledSpecials = dailyOverrides.disabledSpecials || [];
  
  
  // --- One-time migration from old system (can stay) ---
  if (dailyData.fieldAvailability) {
    console.log("Daily Overrides: Migrating old 'fieldAvailability' overrides...");
    const oldRules = dailyData.fieldAvailability || {};
    Object.keys(oldRules).forEach(fieldName => {
        const rule = oldRules[fieldName];
        const newRules = [];
        const type = rule.mode === 'available' ? 'Unavailable' : 'Available';
        (rule.exceptions || []).forEach(rangeStr => {
             const parts = rangeStr.split('-');
             if(parts.length === 2) {
                newRules.push({ type: type, start: parts[0], end: parts[1] });
             }
        });
        if (newRules.length > 0) {
            currentOverrides.dailyFieldAvailability[fieldName] = newRules;
        }
    });
    window.saveCurrentDailyData("dailyFieldAvailability", currentOverrides.dailyFieldAvailability);
  }
  // --- End Migration ---

  // 3. Render ALL UI sections
  initDailySkeletonUI(); // Render the skeleton editor
  renderTripsForm();     // Render the trip form
  
  renderOverrideMasterLists();
  renderOverrideDetailPane();
}


// --- START OF NEW TIME RULE UI ---
function renderTimeRulesUI(itemName, globalRules, dailyRules, onSave) {
    const container = document.createElement("div");
    
    const globalContainer = document.createElement("div");
    globalContainer.innerHTML = `<strong style="font-size: 0.9em;">Global Rules (from Setup):</strong>`;
    if (globalRules.length === 0) {
        globalContainer.innerHTML += `<p class="muted" style="margin: 0; font-size: 0.9em;">Available all day</p>`;
    }
    globalRules.forEach(rule => {
        const ruleEl = document.createElement("div");
        ruleEl.style.margin = "2px 0";
        ruleEl.style.fontSize = "0.9em";
        ruleEl.innerHTML = `&bull; <span style="color: ${rule.type === 'Available' ? 'green' : 'red'}; text-transform: capitalize;">${rule.type}</span> from ${rule.start} to ${rule.end}`;
        globalContainer.appendChild(ruleEl);
    });
    container.appendChild(globalContainer);

    const dailyContainer = document.createElement("div");
    dailyContainer.style.marginTop = "10px";
    dailyContainer.innerHTML = `<strong style="font-size: 0.9em;">Daily Override Rules (replaces global rules):</strong>`;
    
    const ruleList = document.createElement("div");
    if (dailyRules.length === 0) {
        ruleList.innerHTML = `<p class="muted" style="margin: 0; font-size: 0.9em;">No daily rules. Using global rules.</p>`;
    }

    dailyRules.forEach((rule, index) => {
        const ruleEl = document.createElement("div");
        ruleEl.style.margin = "2px 0";
        ruleEl.style.padding = "4px";
        ruleEl.style.background = "#fff8e1";
        ruleEl.style.borderRadius = "4px";
        
        const ruleType = document.createElement("strong");
        ruleType.textContent = rule.type;
        ruleType.style.color = rule.type === 'Available' ? 'green' : 'red';
        ruleType.style.textTransform = "capitalize";
        
        const ruleText = document.createElement("span");
        ruleText.textContent = ` from ${rule.start} to ${rule.end}`;
        
        const removeBtn = document.createElement("button");
        removeBtn.textContent = "✖";
        removeBtn.style.marginLeft = "8px";
        removeBtn.style.border = "none";
        removeBtn.style.background = "transparent";
        removeBtn.style.cursor = "pointer";
        removeBtn.onclick = () => {
            dailyRules.splice(index, 1);
            onSave();
        };
        
        ruleEl.appendChild(ruleType);
        ruleEl.appendChild(ruleText);
        ruleEl.appendChild(removeBtn);
        ruleList.appendChild(ruleEl);
    });
    dailyContainer.appendChild(ruleList);
    container.appendChild(dailyContainer);

    const addContainer = document.createElement("div");
    addContainer.style.marginTop = "10px";
    
    const typeSelect = document.createElement("select");
    typeSelect.innerHTML = `
        <option value="Available">Available</option>
        <option value="Unavailable">Unavailable</option>
    `;
    
    const startInput = document.createElement("input");
    startInput.placeholder = "e.g., 9:00am";
    startInput.style.width = "100px";
    startInput.style.marginLeft = "5px";

    const toLabel = document.createElement("span");
    toLabel.textContent = " to ";
    toLabel.style.margin = "0 5px";

    const endInput = document.createElement("input");
    endInput.placeholder = "e.g., 10:30am";
    endInput.style.width = "100px";

    const addBtn = document.createElement("button");
    addBtn.textContent = "Add Daily Rule";
    addBtn.style.marginLeft = "8px";
    
    addBtn.onclick = () => {
        const type = typeSelect.value;
        const start = startInput.value;
        const end = endInput.value;
        
        if (!start || !end) { alert("Please enter a start and end time."); return; }
        if (parseTimeToMinutes(start) == null || parseTimeToMinutes(end) == null) {
            alert("Invalid time format. Use '9:00am' or '2:30pm'."); return;
        }
        if (parseTimeToMinutes(start) >= parseTimeToMinutes(end)) {
            alert("End time must be after start time."); return;
        }

        dailyRules.push({ type, start, end });
        onSave();
    };

    addContainer.appendChild(typeSelect);
    addContainer.appendChild(startInput);
    addContainer.appendChild(toLabel);
    addContainer.appendChild(endInput);
    addContainer.appendChild(addBtn);
    container.appendChild(addContainer);

    return container;
}
// --- END OF NEW TIME RULE UI ---


/**
 * Renders the "Daily Trips" form
 */
function renderTripsForm() {
  tripsFormContainer.innerHTML = ""; // Clear only the form container

  const form = document.createElement('div');
  form.style.border = '1px solid #ccc';
  form.style.padding = '15px';
  form.style.borderRadius = '8px';

  form.innerHTML = `
<label for="tripName" style="display: block; margin-bottom: 5px; font-weight: 600;">Trip Name:</label>
<input type="text" id="tripName" placeholder="e.g., Museum Trip" style="width: 250px;">

<label for="tripStart" style="display: inline-block; margin-top: 10px; font-weight: 600;">Start Time:</label>
<input id="tripStart" placeholder="e.g., 9:00am" style="margin-right: 8px;">

<label for="tripEnd" style="display: inline-block; font-weight: 600;">End Time:</label>
<input id="tripEnd" placeholder="e.g., 2:00pm" style="margin-right: 8px;">

<p style="margin-top: 15px; font-weight: 600;">Select Divisions (Trip will apply to all bunks in the division):</p>
`;

  const divisions = masterSettings.app1.divisions || {};
  const availableDivisions = masterSettings.app1.availableDivisions || [];

  // 1. Create Division Chip Box
  const divisionChipBox = document.createElement('div');
  divisionChipBox.className = 'chips';
  divisionChipBox.style.marginBottom = '5px';

  availableDivisions.forEach(divName => {
    const divColor = divisions[divName]?.color || '#333';
    const chip = createChip(divName, divColor, true); // true = isDivision
    divisionChipBox.appendChild(chip);
  });

  form.appendChild(divisionChipBox);

  // 2. Add Button
  const addBtn = document.createElement('button');
  addBtn.textContent = 'Add Trip to Skeleton';
  addBtn.className = 'bunk-button';
  addBtn.style.background = '#007BFF';
  addBtn.style.color = 'white';
  addBtn.style.marginTop = '15px';

  // --- OnClick Logic ---
  addBtn.onclick = () => {
    const nameEl = form.querySelector('#tripName');
    const startEl = form.querySelector('#tripStart');
    const endEl = form.querySelector('#tripEnd');
    if (!nameEl || !startEl || !endEl) return;

    const name = nameEl.value.trim();
    const start = startEl.value;
    const end = endEl.value;
    const selectedDivisions = Array.from(divisionChipBox.querySelectorAll('.bunk-button.selected')).map(el => el.dataset.value);

    if (!name || !start || !end) {
      alert('Please enter a name, start time, and end time for the trip.');
      return;
    }
    if (selectedDivisions.length === 0) {
      alert('Please select at least one division for the trip.');
      return;
    }

    const tripStartMin = parseTimeToMinutes(start);
    const tripEndMin = parseTimeToMinutes(end);
    if (tripStartMin == null || tripEndMin == null || tripEndMin <= tripStartMin) {
        alert('Invalid time range. Please use formats like "9:00am" and ensure end is after start.');
        return;
    }

    loadDailySkeleton(); // Ensure we have the latest
    
    dailyOverrideSkeleton = dailyOverrideSkeleton.filter(item => {
        if (!selectedDivisions.includes(item.division)) return true; 
        const itemStartMin = parseTimeToMinutes(item.startTime);
        const itemEndMin = parseTimeToMinutes(item.endTime);
        if (itemStartMin == null || itemEndMin == null) return true;
        const overlaps = (itemStartMin < tripEndMin) && (itemEndMin > tripStartMin);
        return !overlaps;
    });
    
    selectedDivisions.forEach(divName => {
         dailyOverrideSkeleton.push({
            id: `evt_${Math.random().toString(36).slice(2, 9)}`,
            type: 'pinned',
            event: name, // Trip Name
            division: divName,
            startTime: start,
            endTime: end
         });
    });
    
    saveDailySkeleton(); // Saves `dailyOverrideSkeleton` to current day
    
    const gridContainer = skeletonContainer.querySelector('#daily-skeleton-grid');
    if (gridContainer) renderGrid(gridContainer);
    
    nameEl.value = ""; startEl.value = ""; endEl.value = "";
    form.querySelectorAll('.bunk-button.selected').forEach(chip => chip.click());
  };

  form.appendChild(addBtn);
  tripsFormContainer.appendChild(form);
}


// =================================================================
// ===== START: NEW MASTER/DETAIL UI FUNCTIONS =====
// =================================================================

/**
 * Renders all four lists in the left-hand column
 */
function renderOverrideMasterLists() {
    // Clear all lists
    overrideFieldsListEl.innerHTML = "";
    overrideSpecialsListEl.innerHTML = "";
    overrideLeaguesListEl.innerHTML = "";
    overrideSpecialtyLeaguesListEl.innerHTML = "";
    
    // --- Helper to save the main overrides object ---
    const saveOverrides = () => {
        const dailyData = window.loadCurrentDailyData?.() || {};
        const fullOverrides = dailyData.overrides || {};
        fullOverrides.leagues = currentOverrides.leagues;
        fullOverrides.disabledFields = currentOverrides.disabledFields;
        fullOverrides.disabledSpecials = currentOverrides.disabledSpecials;
        window.saveCurrentDailyData("overrides", fullOverrides);
    };

    // --- 1. Fields ---
    const fields = masterSettings.app1.fields || [];
    if (fields.length === 0) {
        overrideFieldsListEl.innerHTML = `<p class="muted" style="font-size: 0.9em;">No fields found in Setup.</p>`;
    }
    fields.forEach(item => {
        const isDisabled = currentOverrides.disabledFields.includes(item.name);
        const onToggle = (isEnabled) => {
            if (isEnabled) {
                currentOverrides.disabledFields = currentOverrides.disabledFields.filter(name => name !== item.name);
            } else {
                if (!currentOverrides.disabledFields.includes(item.name)) {
                    currentOverrides.disabledFields.push(item.name);
                }
            }
            saveOverrides();
        };
        overrideFieldsListEl.appendChild(
            createOverrideMasterListItem('field', item.name, !isDisabled, onToggle)
        );
    });

    // --- 2. Special Activities ---
    const specials = masterSettings.app1.specialActivities || [];
    if (specials.length === 0) {
        overrideSpecialsListEl.innerHTML = `<p class="muted" style="font-size: 0.9em;">No special activities found in Setup.</p>`;
    }
    specials.forEach(item => {
        const isDisabled = currentOverrides.disabledSpecials.includes(item.name);
        const onToggle = (isEnabled) => {
            if (isEnabled) {
                currentOverrides.disabledSpecials = currentOverrides.disabledSpecials.filter(name => name !== item.name);
            } else {
                if (!currentOverrides.disabledSpecials.includes(item.name)) {
                    currentOverrides.disabledSpecials.push(item.name);
                }
            }
            saveOverrides();
        };
        overrideSpecialsListEl.appendChild(
            createOverrideMasterListItem('special', item.name, !isDisabled, onToggle)
        );
    });

    // --- 3. Leagues ---
    const leagues = masterSettings.leaguesByName || {};
    const leagueNames = Object.keys(leagues);
    if (leagueNames.length === 0) {
        overrideLeaguesListEl.innerHTML = `<p class="muted" style="font-size: 0.9em;">No leagues found in Setup.</p>`;
    }
    leagueNames.forEach(name => {
        const isDisabled = currentOverrides.leagues.includes(name);
        const onToggle = (isEnabled) => {
            if (isEnabled) {
                currentOverrides.leagues = currentOverrides.leagues.filter(l => l !== name);
            } else {
                if (!currentOverrides.leagues.includes(name)) {
                    currentOverrides.leagues.push(name);
                }
            }
            saveOverrides();
        };
        overrideLeaguesListEl.appendChild(
            createOverrideMasterListItem('league', name, !isDisabled, onToggle)
        );
    });

    // --- 4. Specialty Leagues ---
    const specialtyLeagues = masterSettings.specialtyLeagues || {};
    const specialtyLeagueNames = Object.values(specialtyLeagues).map(l => l.name).sort();
    if (specialtyLeagueNames.length === 0) {
        overrideSpecialtyLeaguesListEl.innerHTML = `<p class="muted" style="font-size: 0.9em;">No specialty leagues found in Setup.</p>`;
    }
    specialtyLeagueNames.forEach(name => {
        const isDisabled = currentOverrides.disabledSpecialtyLeagues.includes(name);
        const onToggle = (isEnabled) => {
            if (isEnabled) {
                currentOverrides.disabledSpecialtyLeagues = currentOverrides.disabledSpecialtyLeagues.filter(l => l !== name);
            } else {
                if (!currentOverrides.disabledSpecialtyLeagues.includes(name)) {
                    currentOverrides.disabledSpecialtyLeagues.push(name);
                }
            }
            window.saveCurrentDailyData("disabledSpecialtyLeagues", currentOverrides.disabledSpecialtyLeagues);
        };
        overrideSpecialtyLeaguesListEl.appendChild(
            createOverrideMasterListItem('specialty_league', name, !isDisabled, onToggle)
        );
    });
}

/**
 * Creates a single clickable item for the left-hand master lists
 */
function createOverrideMasterListItem(type, name, isEnabled, onToggle) {
    const el = document.createElement('div');
    el.className = 'list-item';
    const id = `${type}-${name}`;
    if (id === selectedOverrideId) {
        el.classList.add('selected');
    }
    
    // Create name span
    const nameEl = document.createElement('span');
    nameEl.className = 'list-item-name';
    nameEl.textContent = name;
    el.appendChild(nameEl);
    
    // Click on name to show details
    nameEl.onclick = () => {
        selectedOverrideId = id;
        renderOverrideMasterLists(); // Re-render lists to update selection
        renderOverrideDetailPane(); // Re-render detail pane
    };

    // Create toggle
    const tog = document.createElement("label"); 
    tog.className = "switch";
    tog.title = isEnabled ? "Click to disable for today" : "Click to enable for today";
    tog.onclick = (e) => e.stopPropagation(); // Prevent selection
    
    const cb = document.createElement("input"); 
    cb.type = "checkbox"; 
    cb.checked = isEnabled;
    cb.onchange = (e) => { 
        e.stopPropagation();
        onToggle(cb.checked); 
        tog.title = cb.checked ? "Click to disable for today" : "Click to enable for today";
    };
    
    const sl = document.createElement("span"); 
    sl.className = "slider";
    
    tog.appendChild(cb); 
    tog.appendChild(sl);
    el.appendChild(tog);

    return el;
}

/**
 * Renders the correct editor in the right-hand pane
 * based on the `selectedOverrideId`
 */
function renderOverrideDetailPane() {
    if (!selectedOverrideId) {
        overrideDetailPaneEl.innerHTML = `<p class="muted">Select an item from the left to edit its daily override.</p>`;
        return;
    }
    
    overrideDetailPaneEl.innerHTML = ""; // Clear
    const [type, name] = selectedOverrideId.split(/-(.+)/); // Splits on first dash

    // --- 1. Handle Fields and Special Activities (Time Rules) ---
    if (type === 'field' || type === 'special') {
        const item = (type === 'field') 
            ? (masterSettings.app1.fields || []).find(f => f.name === name)
            : (masterSettings.app1.specialActivities || []).find(s => s.name === name);
            
        if (!item) {
            overrideDetailPaneEl.innerHTML = `<p style="color: red;">Error: Could not find item.</p>`;
            return;
        }

        const globalRules = item.timeRules || [];
        if (!currentOverrides.dailyFieldAvailability[name]) {
            currentOverrides.dailyFieldAvailability[name] = [];
        }
        const dailyRules = currentOverrides.dailyFieldAvailability[name];

        // Define the save function for this item
        const onSave = () => {
            currentOverrides.dailyFieldAvailability[name] = dailyRules;
            window.saveCurrentDailyData("dailyFieldAvailability", currentOverrides.dailyFieldAvailability);
            renderOverrideDetailPane(); // Re-render this pane
        };

        // Render the Time Rules UI
        overrideDetailPaneEl.appendChild(
            renderTimeRulesUI(name, globalRules, dailyRules, onSave)
        );
        
        // --- NEW: Render Sport Availability for Fields ---
        if (type === 'field') {
            const sportListContainer = document.createElement('div');
            sportListContainer.className = 'sport-override-list';
            sportListContainer.innerHTML = `<strong>Daily Sport Availability for ${name}</strong>`;
            
            const sports = item.activities || [];
            if (sports.length === 0) {
                sportListContainer.innerHTML += `<p class="muted" style="margin: 5px 0 0 10px; font-size: 0.9em;">No sports are assigned to this field in the "Fields" tab.</p>`;
            }
            
            const disabledToday = currentOverrides.dailyDisabledSportsByField[name] || [];
            
            sports.forEach(sport => {
                // A sport is enabled if it's NOT in the disabled list
                const isEnabled = !disabledToday.includes(sport);
                const el = createCheckbox(sport, isEnabled);
                
                el.checkbox.onchange = () => {
                    let list = currentOverrides.dailyDisabledSportsByField[name] || [];
                    
                    if (el.checkbox.checked) {
                        // Sport is ON, so REMOVE it from the disabled list
                        list = list.filter(s => s !== sport);
                    } else {
                        // Sport is OFF, so ADD it to the disabled list
                        if (!list.includes(sport)) {
                            list.push(sport);
                        }
                    }
                    
                    currentOverrides.dailyDisabledSportsByField[name] = list;
                    window.saveCurrentDailyData("dailyDisabledSportsByField", currentOverrides.dailyDisabledSportsByField);
                };
                sportListContainer.appendChild(el.wrapper);
            });
            
            overrideDetailPaneEl.appendChild(sportListContainer);
        }
    }
    
    // --- 2. Handle Regular Leagues (Disable Toggle) ---
    else if (type === 'league') {
        overrideDetailPaneEl.innerHTML = `<p class="muted">Enable or disable this league for today using the toggle in the list on the left.</p>`;
    }
    
    // --- 3. Handle Specialty Leagues (Disable Toggle) ---
    else if (type === 'specialty_league') {
        overrideDetailPaneEl.innerHTML = `<p class="muted">Enable or disable this league for today using the toggle in the list on the left.</p>`;
    }
}

// =================================================================
// ===== END: NEW MASTER/DETAIL UI FUNCTIONS =====
// =================================================================


/**
* Helper to create a standardized checkbox UI element
*/
function createCheckbox(name, isChecked) {
  const wrapper = document.createElement('label');
  wrapper.className = 'override-checkbox';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = isChecked;
  const text = document.createElement('span');
  text.textContent = name;
  wrapper.appendChild(checkbox);
  wrapper.appendChild(text);
  return { wrapper, checkbox };
}

/**
* Helper to create a bunk/division chip
*/
function createChip(name, color = '#007BFF', isDivision = false) {
  const el = document.createElement('span');
  el.className = 'bunk-button';
  el.textContent = name;
  el.dataset.value = name;
  const defaultBorder = isDivision ? color : '#ccc';
  el.style.borderColor = defaultBorder;
  el.style.backgroundColor = 'white';
  el.style.color = 'black';
  el.addEventListener('click', () => {
    const isSelected = el.classList.toggle('selected');
    el.style.backgroundColor = isSelected ? color : 'white';
    el.style.color = isSelected ? 'white' : 'black';
    el.style.borderColor = isSelected ? color : defaultBorder;
  });
  return el;
}

// Expose the init function to the global window
window.initDailyOverrides = init;

})();
