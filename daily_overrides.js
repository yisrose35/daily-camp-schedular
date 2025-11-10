// =================================================================
// daily_overrides.js
// This file creates the UI for the "Daily Overrides" tab.
//
// UPDATED (User Fix):
// - `loadDailySkeleton`: This function's logic is now correct.
//   It loads the `dailyData.manualSkeleton` first.
//   If that is empty, it loads a *deep copy* of the
//   `app1.defaultSkeleton`, which prevents the bug
//   where editing the override accidentally edited the default.
// =================================================================

(function() {
'use strict';

let container = null;
let masterSettings = {};
let currentOverrides = {
  fieldAvailability: {}, // NEW
  leagues: []
};
let currentTrips = [];

// --- Helper containers ---
let skeletonContainer = null; // <-- NEW
let fieldOverridesContainer = null;
let tripsFormContainer = null;
let tripsListContainer = null;
let leaguesContainer = null;

// =================================================================
// ===== START: SKELETON EDITOR LOGIC (Copied from master_schedule_builder.js) =====
// =================================================================

let dailyOverrideSkeleton = []; // This file's copy of the skeleton
const PIXELS_PER_MINUTE = 2;
const INCREMENT_MINS = 30;

const TILES = [
    { type: 'activity', name: 'Activity', style: 'background: #e0f7fa; border: 1px solid #007bff;' },
    { type: 'sports', name: 'Sports', style: 'background: #dcedc8; border: 1px solid #689f38;' },
    { type: 'special', name: 'Special Activity', style: 'background: #e8f5e9; border: 1px solid #43a047;' },
    { type: 'split', name: 'Split Activity', style: 'background: #fff3e0; border: 1px solid #f57c00;' },
    { type: 'league', name: 'League Game', style: 'background: #d1c4e9; border: 1px solid #5e35b1;' },
    { type: 'specialty_league', name: 'Specialty League', style: 'background: #fff8e1; border: 1px solid #f9a825;' },
    { type: 'swim', name: 'Swim', style: 'background: #bbdefb; border: 1px solid #1976d2;' },
    { type: 'lunch', name: 'Lunch', style: 'background: #fbe9e7; border: 1px solid #d84315;' },
    { type: 'snacks', name: 'Snacks', style: 'background: #fff9c4; border: 1px solid #fbc02d;' },
    { type: 'custom', name: 'Custom Pinned Event', style: 'background: #eee; border: 1px solid #616161;' }
];

/**
 * Helper: Translates user-friendly names from prompts
 * into the correct event type and name for the optimizer.
 */
function mapEventNameForOptimizer(name) {
    if (!name) name = "Free";
    const lowerName = name.toLowerCase().trim();

    if (lowerName === 'activity') {
        return { type: 'slot', event: 'General Activity Slot' };
    }
    if (lowerName === 'sports') {
        return { type: 'slot', event: 'Sports Slot' };
    }
    if (lowerName === 'special activity' || lowerName === 'special') {
        return { type: 'slot', event: 'Special Activity' };
    }
    if (lowerName === 'swim' || lowerName === 'lunch' || lowerName === 'snacks') {
        return { type: 'pinned', event: name };
    }
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
        
        el.draggable = true;
        
        el.ondragstart = (e) => {
            e.dataTransfer.setData('application/json', JSON.stringify(tile));
            e.dataTransfer.effectAllowed = 'copy';
            el.style.cursor = 'grabbing';
        };
        
        el.ondragend = () => {
            el.style.cursor = 'grab';
        };
        
        paletteContainer.appendChild(el);
    });
}

/**
 * Renders the main schedule grid
 */
function renderGrid(gridContainer) {
    const divisions = window.divisions || {};
    const availableDivisions = window.availableDivisions || [];
    
    let earliestMin = 1440; 
    let latestMin = 0;

    if (dailyOverrideSkeleton.length > 0) {
        dailyOverrideSkeleton.forEach(item => {
            const start = parseTimeToMinutes(item.startTime);
            const end = parseTimeToMinutes(item.endTime);
            if (start != null && start < earliestMin) earliestMin = start;
            if (end != null && end > latestMin) latestMin = end;
        });
    } else {
        earliestMin = 540; // 9:00 AM
        latestMin = 960; // 4:00 PM
    }
    
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
        gridHtml += `<div style="position: absolute; top: ${top}px; left: 0; width: 100%; height: ${INCREMENT_MINS * PIXELS_PER_MINUTE}px; border-bottom: 1px dashed #ddd; box-sizing: border-box; font-size: 10px; padding: 2px; color: #777;">
            ${minutesToTime(min)}
        </div>`;
    }
    gridHtml += `</div>`;
    
    availableDivisions.forEach((divName, i) => {
        const divTimeline = divisions[divName]?.timeline;
        const divStart = parseTimeToMinutes(divTimeline?.start);
        const divEnd = parseTimeToMinutes(divTimeline?.end);
        
        gridHtml += `<div class="grid-cell" data-div="${divName}" data-start-min="${earliestMin}" style="grid-row: 2; grid-column: ${i + 2}; position: relative; height: ${totalHeight}px; border-right: 1px solid #ccc;">`;

        if (divStart && divStart > earliestMin) {
            gridHtml += `<div style="position: absolute; top: 0; height: ${(divStart - earliestMin) * PIXELS_PER_MINUTE}px; width: 100%; background: #333; opacity: 0.5;"></div>`;
        }
        if (divEnd && divEnd < latestMin) {
            gridHtml += `<div style="position: absolute; top: ${(divEnd - earliestMin) * PIXELS_PER_MINUTE}px; height: ${(latestMin - divEnd) * PIXELS_PER_MINUTE}px; width: 100%; background: #333; opacity: 0.5;"></div>`;
        }

        dailyOverrideSkeleton.filter(ev => ev.division === divName).forEach(event => {
            const startMin = parseTimeToMinutes(event.startTime);
            const endMin = parseTimeToMinutes(event.endTime);
            if (startMin == null || endMin == null) return;

            const top = (startMin - earliestMin) * PIXELS_PER_MINUTE;
            const height = (endMin - startMin) * PIXELS_PER_MINUTE;

            gridHtml += renderEventTile(event, top, height);
        });

        gridHtml += `</div>`;
    });

    gridHtml += `</div>`;
    gridContainer.innerHTML = gridHtml;
    
    // Add Listeners
    addDropListeners(gridContainer);
    addRemoveListeners(gridContainer);
}

/**
 * Helper to add all the drag/drop event listeners
 */
function addDropListeners(gridContainer) {
    gridContainer.querySelectorAll('.grid-cell').forEach(cell => {
        cell.ondragover = (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            cell.style.backgroundColor = '#e0ffe0';
        };
        
        cell.ondragleave = () => {
            cell.style.backgroundColor = '';
        };
        
        cell.ondrop = (e) => {
            e.preventDefault();
            cell.style.backgroundColor = '';
            
            const tileData = JSON.parse(e.dataTransfer.getData('application/json'));
            const divName = cell.dataset.div;
            
            const rect = cell.getBoundingClientRect();
            // Find the correct scroll container
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
                const startTime = prompt(`Enter Start Time for the *full* block:`, defaultStartTime);
                if (!startTime) return;
                const endTime = prompt(`Enter End Time for the *full* block:`);
                if (!endTime) return;
                const eventName1 = prompt("Enter name for FIRST activity (e.g., Swim, Sports):");
                if (!eventName1) return;
                const eventName2 = prompt("Enter name for SECOND activity (e.g., Activity, Sports):");
                if (!eventName2) return;
                const event1 = mapEventNameForOptimizer(eventName1);
                const event2 = mapEventNameForOptimizer(eventName2);
                newEvent = {
                    id: `evt_${Math.random().toString(36).slice(2, 9)}`,
                    type: 'split',
                    event: `${eventName1} / ${eventName2}`,
                    division: divName,
                    startTime: startTime,
                    endTime: endTime,
                    subEvents: [ event1, event2 ]
                };
            } else if (tileData.type === 'lunch' || tileData.type === 'snacks' || tileData.type === 'custom') {
                eventType = 'pinned';
                if (tileData.type === 'custom') {
                    eventName = prompt("Enter the name for this custom event (e.g., 'Snacks'):");
                    if (!eventName) return;
                    if (confirm("Is this a 'Slot' to be filled (OK) or a 'Pinned' event (Cancel)?")) {
                        eventType = 'slot';
                    }
                } else {
                    eventName = tileData.name;
                }
            }

            if (!newEvent) {
                const startTime = prompt(`Add "${eventName}" for ${divName}?\nEnter Start Time:`, defaultStartTime);
                if (!startTime) return;
                const endTime = prompt(`Enter End Time:`);
                if (!endTime) return;
                newEvent = {
                    id: `evt_${Math.random().toString(36).slice(2, 9)}`,
                    type: eventType,
                    event: eventName,
                    division: divName,
                    startTime: startTime,
                    endTime: endTime
                };
            }
            
            dailyOverrideSkeleton.push(newEvent);
            saveDailySkeleton(); // Save to this day's data
            renderGrid(gridContainer); // Re-render this UI
        };
    });
}

/**
 * Helper to add click-to-remove listeners
 */
function addRemoveListeners(gridContainer) {
    gridContainer.querySelectorAll('.grid-event').forEach(tile => {
        tile.onclick = (e) => {
            e.stopPropagation(); 
            const eventId = tile.dataset.eventId;
            if (!eventId) return;
            const event = dailyOverrideSkeleton.find(ev => ev.id === eventId);
            if (confirm(`Remove "${event?.event || 'this event'}"?`)) {
                dailyOverrideSkeleton = dailyOverrideSkeleton.filter(ev => ev.id !== eventId);
                saveDailySkeleton(); // Save to this day's data
                renderGrid(gridContainer); // Re-render this UI
            }
        };
    });
}


/**
 * Renders a single event tile
 */
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
    
    return `
        <div class="grid-event" 
             data-event-id="${event.id}" 
             title="Click to remove this event"
             style="${style}; padding: 2px 5px; border-radius: 4px; text-align: center; 
                    margin: 0 1px; font-size: 0.9em; position: absolute;
                    top: ${top}px; height: ${height}px; width: calc(100% - 4px);
                    box-sizing: border-box; overflow: hidden; cursor: pointer;">
            <strong>${event.event}</strong>
            <div style="font-size: 0.85em;">${event.startTime} - ${event.endTime}</div>
        </div>
    `;
}

/**
 * --- UPDATED: loadDailySkeleton (FIXED) ---
 * Loads the skeleton for the *current day*, falling back to a
 * *deep copy* of the default skeleton.
 */
function loadDailySkeleton() {
    const dailyData = window.loadCurrentDailyData?.() || {};
    
    // Check if a schedule is already saved for *this specific day*
    if (dailyData.manualSkeleton && dailyData.manualSkeleton.length > 0) {
        dailyOverrideSkeleton = dailyData.manualSkeleton;
    } else {
        // If not, load the *global default* skeleton
        const globalSettings = window.loadGlobalSettings?.() || {};
        const app1Data = globalSettings.app1 || {};
        // CRITICAL FIX: Must deep-copy the default skeleton
        // otherwise, edits here will modify the in-memory default.
        dailyOverrideSkeleton = JSON.parse(JSON.stringify(app1Data.defaultSkeleton || []));
    }
}
/**
 * Saves the skeleton *only* to the current day's "manualSkeleton" key.
 */
function saveDailySkeleton() {
    window.saveCurrentDailyData?.("manualSkeleton", dailyOverrideSkeleton);
}

/**
 * Helper to convert 24h minutes to 12h time string
 */
function minutesToTime(min) {
    const hh = Math.floor(min / 60);
    const mm = min % 60;
    const h = hh % 12 === 0 ? 12 : hh % 12;
    const m = String(mm).padStart(2, '0');
    const ampm = hh < 12 ? 'am' : 'pm';
    return `${h}:${m}${ampm}`;
}

/**
 * Main entry point for the SKELETON UI on *this* tab
 */
function initDailySkeletonUI() {
    skeletonContainer = document.getElementById("override-scheduler-content");
    if (!skeletonContainer) return;
    
    loadDailySkeleton();
    
    skeletonContainer.innerHTML = `
        <div id="daily-skeleton-palette" style="padding: 10px; background: #f4f4f4; border-radius: 8px; margin-bottom: 15px; display: flex; flex-wrap: wrap; gap: 10px;">
        </div>
        <div id="daily-skeleton-grid" style="overflow-x: auto; border: 1px solid #999; max-height: 600px; overflow-y: auto;">
        </div>
    `;
    
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
  container.innerHTML = `
    <h2>Overrides & Trips for ${window.currentScheduleDate}</h2>
    
    <div class="override-section" id="daily-skeleton-editor-section">
      <h3>Daily Skeleton Override</h3>
      <p style="font-size: 0.9em; color: #555;">
        Modify the schedule layout for <strong>this day only</strong>.
        Changes here will not affect your default schedule template.
      </p>
      <div id="override-scheduler-content">
          </div>
    </div>
    
    <div class="override-section" id="field-overrides-container">
      <h3>Field & Special Activity Time Overrides</h3>
    </div>
    
    <div class="override-section">
      <h3>Daily Trips</h3>
      <div id="trips-form-container"></div>
      <div id="trips-list-container"></div>
    </div>
    
    <div class="override-section" id="league-overrides-container">
      <h3>Disabled Leagues</h3>
    </div>
  `;

  // Get references to the new containers
  skeletonContainer = document.getElementById("override-scheduler-content"); // <-- NEW
  fieldOverridesContainer = document.getElementById("field-overrides-container");
  tripsFormContainer = document.getElementById("trips-form-container");
  tripsListContainer = document.getElementById("trips-list-container");
  leaguesContainer = document.getElementById("league-overrides-container");


  // 1. Load Master "Setup" Data
  masterSettings.global = window.loadGlobalSettings?.() || {};
  masterSettings.app1 = masterSettings.global.app1 || {};
  masterSettings.leaguesByName = masterSettings.global.leaguesByName || {};

  // 2. Load the data for the *current* day
  const dailyData = window.loadCurrentDailyData?.() || {};
  
  // Load new field availability, fall back to old "fields" list for one-time migration
  currentOverrides.fieldAvailability = dailyData.fieldAvailability || {};
  
  // Check for old "overrides" structure
  if (dailyData.overrides && dailyData.overrides.fields && dailyData.overrides.fields.length > 0 && Object.keys(currentOverrides.fieldAvailability).length === 0) {
    console.log("Daily Overrides: Migrating old 'fields' overrides...");
    // One-time migration from old "unavailable" list
    dailyData.overrides.fields.forEach(fieldName => {
      currentOverrides.fieldAvailability[fieldName] = {
        mode: "unavailable", // Old list only marked items as unavailable
        exceptions: []
      };
    });
    // Save the new structure immediately
    window.saveCurrentDailyData("fieldAvailability", currentOverrides.fieldAvailability);
    
    // Clear the old, now-migrated data
    const newOverrides = dailyData.overrides;
    delete newOverrides.fields;
    window.saveCurrentDailyData("overrides", newOverrides);
  }
  
  currentOverrides.leagues = dailyData.overrides?.leagues || [];
  currentTrips = dailyData.trips || [];

  // 3. Render ALL UI sections
  initDailySkeletonUI(); // <-- NEW: Render the skeleton editor
  renderFieldsOverride();
  renderTripsForm();
  renderTripsList();
  renderLeaguesOverride();
}

/**
 * UPDATED: Renders the new "Available / Unavailable" SLIDER toggle
 */
function renderDailyAvailabilityControls(item, onSave) {
  const container = document.createElement("div");
  container.style.marginTop = "10px";
  container.style.paddingLeft = "15px";
  container.style.borderLeft = "3px solid #eee";

  // --- 1. Mode Toggle (Available / Unavailable) ---
  const modeLabel = document.createElement("label");
  modeLabel.style.display = "flex";
  modeLabel.style.alignItems = "center";
  modeLabel.style.gap = "10px";
  modeLabel.style.cursor = "pointer";
  
  const textAvailable = document.createElement("span");
  textAvailable.textContent = "Available";
  
  const toggleTrack = document.createElement("span");
  Object.assign(toggleTrack.style, {
    width: "44px",
    height: "24px",
    borderRadius: "99px",
    position: "relative",
    display: "inline-block",
    border: "1px solid #ccc",
    backgroundColor: item.mode === 'available' ? '#22c55e' : '#d1d5db', // green or grey
    transition: "background-color 0.2s"
  });

  const toggleKnob = document.createElement("span");
  Object.assign(toggleKnob.style, {
    width: "20px",
    height: "20px",
    borderRadius: "50%",
    backgroundColor: "white",
    position: "absolute",
    top: "1px",
    left: item.mode === 'available' ? '21px' : '1px', // right or left
    transition: "left 0.2s"
  });
  
  toggleTrack.appendChild(toggleKnob);
  
  const textUnavailable = document.createElement("span");
  textUnavailable.textContent = "Unavailable";
  
  // Set initial text style
  textAvailable.style.fontWeight = item.mode === 'available' ? 'bold' : 'normal';
  textUnavailable.style.fontWeight = item.mode === 'unavailable' ? 'bold' : 'normal';

  // Use onclick on the label to toggle state
  modeLabel.onclick = () => {
    item.mode = (item.mode === 'available') ? 'unavailable' : 'available';
    
    // Update styles
    toggleTrack.style.backgroundColor = item.mode === 'available' ? '#22c55e' : '#d1d5db';
    toggleKnob.style.left = item.mode === 'available' ? '21px' : '1px';
    textAvailable.style.fontWeight = item.mode === 'available' ? 'bold' : 'normal';
    textUnavailable.style.fontWeight = item.mode === 'unavailable' ? 'bold' : 'normal';
    
    onSave();
  };

  modeLabel.appendChild(textAvailable);
  modeLabel.appendChild(toggleTrack);
  modeLabel.appendChild(textUnavailable);
  container.appendChild(modeLabel);

  // --- 2. "Except for..." Text ---
  const exceptLabel = document.createElement("span");
  exceptLabel.textContent = " except for:";
  exceptLabel.style.fontWeight = "500";
  container.appendChild(exceptLabel);

  // --- 3. Exception Time List ---
  const exceptionList = document.createElement("div");
  exceptionList.style.display = "flex";
  exceptionList.style.flexWrap = "wrap";
  exceptionList.style.gap = "6px";
  exceptionList.style.marginTop = "6px";

  item.exceptions = item.exceptions || [];
  item.exceptions.forEach((timeStr, index) => {
    const pill = document.createElement("span");
    pill.textContent = `${timeStr} ✖`;
    pill.style.background = "#ddd";
    pill.style.padding = "4px 8px";
    pill.style.borderRadius = "12px";
    pill.style.cursor = "pointer";
    pill.onclick = () => {
      item.exceptions.splice(index, 1);
      onSave(); // This will just save and re-render this specific control
    };
    exceptionList.appendChild(pill);
  });
  container.appendChild(exceptionList);

  // --- 4. Add New Exception Input ---
  const addContainer = document.createElement("div");
  addContainer.style.marginTop = "6px";
  const timeInput = document.createElement("input");
  // UPDATED Placeholder
  timeInput.placeholder = "e.g., 9:00am-10:30am";
  timeInput.style.marginRight = "5px";

  const addBtn = document.createElement("button");
  addBtn.textContent = "Add Time";
  
  // UPDATED Validation Logic
  addBtn.onclick = () => {
    const val = timeInput.value.trim();
    const parts = val.split('-');
    if (parts.length === 2) {
      const startMin = parseTimeToMinutes(parts[0]);
      const endMin = parseTimeToMinutes(parts[1]);
      
      if (startMin != null && endMin != null && endMin > startMin) {
        // Valid! Push the original, user-formatted string
        item.exceptions.push(val);
        timeInput.value = "";
        onSave();
      } else {
        // Invalid time or range
        alert("Invalid time range. Use format '9:00am-10:30am'. Ensure end time is after start time.");
      }
    } else {
      // Invalid format
      alert("Invalid format. Must be a range separated by a hyphen (e.g., '9:00am-10:30am').");
    }
  };
  timeInput.onkeypress = (e) => { if (e.key === "Enter") addBtn.click(); };
  
  addContainer.appendChild(timeInput);
  addContainer.appendChild(addBtn);
  container.appendChild(addContainer);

  return container;
}

/**
* Renders the "Field & Special Activity Time Overrides" section
* NEW: This function now renders in-place and does not cause a page jump.
*/
function renderFieldsOverride() {
  // Clear only its own container
  fieldOverridesContainer.innerHTML = '<h3>Field & Special Activity Time Overrides</h3>';

  const allFields = (masterSettings.app1.fields || []).concat(masterSettings.app1.specialActivities || []);

  if (allFields.length === 0) {
    fieldOverridesContainer.innerHTML += '<p class="muted">No fields or special activities found in Setup.</p>';
    return;
  }

  allFields.forEach(item => {
    const itemName = item.name;
    let overrideData = currentOverrides.fieldAvailability[itemName];
    
    const itemWrapper = document.createElement("div");
    itemWrapper.style.padding = "10px";
    itemWrapper.style.border = "1px solid #ddd";
    itemWrapper.style.borderRadius = "5px";
    itemWrapper.style.marginBottom = "10px";

    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.alignItems = "center";
    
    const title = document.createElement("strong");
    title.textContent = itemName;
    header.appendChild(title);
    
    // --- Create ALL controls, but hide/show them ---
    const addBtn = document.createElement("button");
    addBtn.textContent = "Add Daily Time Override";
    
    const removeBtn = document.createElement("button");
    removeBtn.textContent = "Remove Daily Override";
    removeBtn.style.background = "#c0392b";
    removeBtn.style.color = "white";
    
    const globalEl = document.createElement("p");
    globalEl.style.fontSize = "0.9em";
    globalEl.style.fontStyle = "italic";
    globalEl.style.opacity = "0.7";
    globalEl.style.margin = "5px 0 0 0";
    
    const controlsPlaceholder = document.createElement("div");
    
    // Function to save data and re-render *only* this item's controls
    const saveAndRefreshControls = () => {
      window.saveCurrentDailyData("fieldAvailability", currentOverrides.fieldAvailability);
      // Re-render just the controls for this item
      controlsPlaceholder.innerHTML = "";
      controlsPlaceholder.appendChild(
        renderDailyAvailabilityControls(overrideData, saveAndRefreshControls)
      );
    };

    // --- Button Click Handlers ---
    addBtn.onclick = () => {
      // Create a default override based on the global rule
      overrideData = {
        mode: item.availabilityMode || "available",
        exceptions: JSON.parse(JSON.stringify(item.availabilityExceptions || [])) // Deep copy
      };
      currentOverrides.fieldAvailability[itemName] = overrideData;
      
      window.saveCurrentDailyData("fieldAvailability", currentOverrides.fieldAvailability);
      
      // Show the remove button and controls
      addBtn.style.display = "none";
      removeBtn.style.display = "block";
      globalEl.style.display = "block";
      saveAndRefreshControls(); // Render controls for the first time
    };
    
    removeBtn.onclick = () => {
      delete currentOverrides.fieldAvailability[itemName];
      overrideData = null; // Clear the local reference
      
      window.saveCurrentDailyData("fieldAvailability", currentOverrides.fieldAvailability);
      
      // Show the add button and hide controls
      addBtn.style.display = "block";
      removeBtn.style.display = "none";
      globalEl.style.display = "none";
      controlsPlaceholder.innerHTML = "";
    };

    // --- Initial State ---
    if (overrideData) {
      // Already overridden: Show remove button and controls
      addBtn.style.display = "none";
      removeBtn.style.display = "block";
      
      const globalRule = item.availabilityMode === 'unavailable' ? 'Unavailable' : 'Available';
      const globalExceptions = (item.availabilityExceptions || []).join(', ');
      globalEl.textContent = `(Global Rule: ${globalRule}${globalExceptions ? ` except ${globalExceptions}` : ''})`;
      globalEl.style.display = "block";
      
      controlsPlaceholder.appendChild(
        renderDailyAvailabilityControls(overrideData, saveAndRefreshControls)
      );
    } else {
      // Not overridden: Show add button, hide controls
      addBtn.style.display = "block";
      removeBtn.style.display = "none";
      globalEl.style.display = "none";
    }
    
    header.appendChild(addBtn);
    header.appendChild(removeBtn);
    itemWrapper.appendChild(header);
    itemWrapper.appendChild(globalEl);
    itemWrapper.appendChild(controlsPlaceholder);
    
    fieldOverridesContainer.appendChild(itemWrapper);
  });
}

/**
 * NEW: Renders *only* the "Daily Trips" form
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

<p style="margin-top: 15px; font-weight: 600;">Select Divisions:</p>
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

  // 2. Add a separator
  const bunkHeader = document.createElement('p');
  bunkHeader.textContent = 'Or Select Individual Bunks:';
  bunkHeader.style.marginTop = '15px';
  bunkHeader.style.fontWeight = '600';
  form.appendChild(bunkHeader);

  // 3. Create Bunk Chip Box
  const bunkChipBox = document.createElement('div');
  bunkChipBox.className = 'chips';

  availableDivisions.forEach(divName => {
    const bunkList = divisions[divName]?.bunks || [];
    bunkList.forEach(bunkName => {
      const chip = createChip(bunkName, '#007BFF', false); // false = isBunk
      bunkChipBox.appendChild(chip);
    });
  });

  form.appendChild(bunkChipBox);

  const addBtn = document.createElement('button');
  addBtn.textContent = 'Add Trip';
  addBtn.className = 'bunk-button';
  addBtn.style.background = '#007BFF';
  addBtn.style.color = 'white';
  addBtn.style.marginTop = '15px';

  addBtn.onclick = () => {
    console.log("Daily Overrides: 'Add Trip' button clicked.");

    const nameEl = form.querySelector('#tripName');
    const startEl = form.querySelector('#tripStart');
    const endEl = form.querySelector('#tripEnd');

    if (!nameEl || !startEl || !endEl) {
      console.error("Daily Overrides: Could not find trip form elements!");
      return;
    }

    const name = nameEl.value.trim();
    const start = startEl.value;
    const end = endEl.value;

    const selectedDivChips = Array.from(divisionChipBox.querySelectorAll('.bunk-button.selected')).map(el => el.dataset.value);
    const selectedBunkChips = Array.from(bunkChipBox.querySelectorAll('.bunk-button.selected')).map(el => el.dataset.value);

    const selectedTargets = [...selectedDivChips, ...selectedBunkChips];

    console.log("Daily Overrides: Trip Data:", { name, start, end, selectedTargets });

    if (!name || !start || !end) {
      alert('Please enter a name, start time, and end time for the trip.');
      return;
    }
    if (selectedTargets.length === 0) {
      alert('Please select at least one division or bunk for the trip.');
      return;
    }

    currentTrips.push({
      id: Math.random().toString(36).slice(2,9),
      name,
      start,
      end,
      targets: selectedTargets
    });

    console.log("Daily Overrides: Saving trips...", currentTrips);
    window.saveCurrentDailyData("trips", currentTrips);
    
    // --- FIX: Re-render ONLY the list and clear the form ---
    renderTripsList();
    
    // Clear form
    nameEl.value = "";
    startEl.value = "";
    endEl.value = "";
    form.querySelectorAll('.bunk-button.selected').forEach(chip => {
        chip.click(); // This will toggle the class and style
    });
    // --- END FIX ---
  };

  form.appendChild(addBtn);
  tripsFormContainer.appendChild(form);
}

/**
 * NEW: Renders *only* the list of current trips
 */
function renderTripsList() {
  tripsListContainer.innerHTML = ""; // Clear only the list container

  const listHeader = document.createElement('h4');
  listHeader.textContent = 'Scheduled Trips for This Day:';
  listHeader.style.marginTop = '20px';
  tripsListContainer.appendChild(listHeader);

  if (currentTrips.length === 0) {
    tripsListContainer.innerHTML += '<p class="muted">No trips scheduled for this day.</p>';
  }

  currentTrips.forEach(trip => {
    const item = document.createElement('div');
    item.className = 'item';
    item.innerHTML = `
  <div style="flex-grow:1;">
    <div><strong>${trip.name}</strong></div>
    <div class="muted" style="font-size: 0.9em;">${trip.start} - ${trip.end}</div>
    <div class="muted" style="font-size: 0.8em; padding-left: 10px;">
      &hookrightarrow; Applies to: ${trip.targets.join(', ')}
    </div>
  </div>
  <button data-id="${trip.id}" style="padding: 6px 10px; border-radius:4px; cursor:pointer; background: #c0392b; color: white;">Remove</button>
  `;

    item.querySelector('button').onclick = () => {
      console.log("Daily Overrides: Removing trip", trip.id);
      currentTrips = currentTrips.filter(t => t.id !== trip.id);
      window.saveCurrentDailyData("trips", currentTrips);
      renderTripsList(); // Re-render only this list
    };
    tripsListContainer.appendChild(item);
  });
}


/**
* Renders the "Disabled Leagues" checklist
*/
function renderLeaguesOverride() {
  leaguesContainer.innerHTML = '<h3>Disabled Leagues</h3>'; // Clear only its container

  const leagues = masterSettings.leaguesByName || {};
  const leagueNames = Object.keys(leagues);

  if (leagueNames.length === 0) {
    leaguesContainer.innerHTML += '<p class="muted">No leagues found in Setup.</p>';
    return;
  }

  leagueNames.forEach(leagueName => {
    const el = createCheckbox(leagueName, currentOverrides.leagues.includes(leagueName));
    el.checkbox.onchange = () => {
      if (el.checkbox.checked) {
        if (!currentOverrides.leagues.includes(leagueName)) {
          currentOverrides.leagues.push(leagueName);
        }
      } else {
        currentOverrides.leagues = currentOverrides.leagues.filter(l => l !== leagueName);
      }
      
      // Save under the original "overrides" key for leagues
      const dailyData = window.loadCurrentDailyData?.() || {};
      const fullOverrides = dailyData.overrides || {};
      fullOverrides.leagues = currentOverrides.leagues;
      
      console.log("Daily Overrides: Saving league overrides...", fullOverrides.leagues);
      window.saveCurrentDailyData("overrides", fullOverrides);
    };
    leaguesContainer.appendChild(el.wrapper);
  });
}

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
  // Make sure it renders in the "unselected" state by default
  el.style.backgroundColor = 'white';
  el.style.color = 'black';

  el.addEventListener('click', () => {
    const isSelected = el.classList.toggle('selected');
    console.log("Daily Overrides: Chip clicked:", name, "Selected:", isSelected);
    el.style.backgroundColor = isSelected ? color : 'white';
    el.style.color = isSelected ? 'white' : 'black';
    el.style.borderColor = isSelected ? color : defaultBorder;
  });
  return el;
}

// Expose the init function to the global window
window.initDailyOverrides = init;

})();
