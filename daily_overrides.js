// =================================================================
// daily_overrides.js
// This file creates the UI for the "Daily Overrides" tab.
//
// UPDATED:
// - Replaced the confusing `renderDailyAvailabilityControls` with
//   a new `renderTimeRulesUI` (similar to app1.js).
// - This new UI allows adding multiple, specific time rules
//   (e.g., "Available 9-11", "Unavailable 11-12") for the
//   *specific day* only.
// - Logic Core will now check for these daily rules first.
// =================================================================

(function() {
'use strict';

let container = null;
let masterSettings = {};
let currentOverrides = {
  // fieldAvailability is GONE
  dailyFieldAvailability: {}, // <-- NEW
  leagues: []
};
// let currentTrips = []; // No longer needed

// --- Helper containers ---
let skeletonContainer = null;
let fieldOverridesContainer = null;
let tripsFormContainer = null;
let leaguesContainer = null;

// =================================================================
// ===== START: SKELETON EDITOR LOGIC (Unchanged from previous) =====
// =================================================================
let dailyOverrideSkeleton = []; 
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
function mapEventNameForOptimizer(name) {
    if (!name) name = "Free";
    const lowerName = name.toLowerCase().trim();
    if (lowerName === 'activity') return { type: 'slot', event: 'General Activity Slot' };
    if (lowerName === 'sports') return { type: 'slot', event: 'Sports Slot' };
    if (lowerName === 'special activity' || lowerName === 'special') return { type: 'slot', event: 'Special Activity' };
    if (lowerName === 'swim' || lowerName === 'lunch' || lowerName === 'snacks') return { type: 'pinned', event: name };
    return { type: 'pinned', event: name };
}
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
        el.ondragend = () => { el.style.cursor = 'grab'; };
        paletteContainer.appendChild(el);
    });
}
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
        earliestMin = 540; latestMin = 960;
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
        gridHtml += `<div style="position: absolute; top: ${top}px; left: 0; width: 100%; height: ${INCREMENT_MINS * PIXELS_PER_MINUTE}px; border-bottom: 1px dashed #ddd; box-sizing: border-box; font-size: 10px; padding: 2px; color: #777;">${minutesToTime(min)}</div>`;
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
function loadDailySkeleton() {
    const dailyData = window.loadCurrentDailyData?.() || {};
    if (dailyData.manualSkeleton && dailyData.manualSkeleton.length > 0) {
        dailyOverrideSkeleton = dailyData.manualSkeleton;
    } else {
        const globalSettings = window.loadGlobalSettings?.() || {};
        const app1Data = globalSettings.app1 || {};
        dailyOverrideSkeleton = JSON.parse(JSON.stringify(app1Data.defaultSkeleton || []));
    }
}
function saveDailySkeleton() {
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
    if (hh === 12) hh = mer === "am" ? 0 : 12;
    else if (mer === "pm") hh += 12;
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
      <div id="override-scheduler-content"></div>
    </div>
    
    <div class="override-section" id="daily-trips-section">
      <h3>Daily Trips (Adds to Skeleton)</h3>
      <div id="trips-form-container"></div>
    </div>

    <div class="override-section" id="field-overrides-container">
      <h3>Field & Special Activity Time Overrides</h3>
    </div>
    
    <div class="override-section" id="league-overrides-container">
      <h3>Disabled Leagues</h3>
    </div>
  `;

  // Get references to the containers
  skeletonContainer = document.getElementById("override-scheduler-content");
  fieldOverridesContainer = document.getElementById("field-overrides-container");
  tripsFormContainer = document.getElementById("trips-form-container");
  leaguesContainer = document.getElementById("league-overrides-container");

  // 1. Load Master "Setup" Data
  masterSettings.global = window.loadGlobalSettings?.() || {};
  masterSettings.app1 = masterSettings.global.app1 || {};
  masterSettings.leaguesByName = masterSettings.global.leaguesByName || {};

  // 2. Load the data for the *current* day
  const dailyData = window.loadCurrentDailyData?.() || {};
  
  // --- NEW: Load new daily field availability rules ---
  currentOverrides.dailyFieldAvailability = dailyData.dailyFieldAvailability || {};
  
  // --- One-time migration from old system ---
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
    // This is safe to delete now, but we'll leave it for one cycle
    // delete dailyData.fieldAvailability; 
  }
  // --- End Migration ---
  
  currentOverrides.leagues = dailyData.overrides?.leagues || [];

  // 3. Render ALL UI sections
  initDailySkeletonUI(); // Render the skeleton editor
  renderTripsForm();     // Render the trip form
  renderFieldsOverride();
  renderLeaguesOverride();
}


// --- START OF NEW TIME RULE UI ---
/**
 * Renders the new, simplified "Time Rules" UI for DAILY overrides.
 * This replaces the old `renderDailyAvailabilityControls`.
 */
function renderTimeRulesUI(itemName, globalRules, dailyRules, onSave) {
    const container = document.createElement("div");
    container.style.marginTop = "10px";
    container.style.paddingLeft = "15px";
    container.style.borderLeft = "3px solid #eee";

    // --- 1. Show Global Rules (Read-only) ---
    const globalContainer = document.createElement("div");
    globalContainer.innerHTML = `<strong style="font-size: 0.9em;">Global Rules (from Setup):</strong>`;
    if (globalRules.length === 0) {
        globalContainer.innerHTML += `<p class="muted" style="margin: 0; font-size: 0.9em;">Available all day</p>`;
    }
    globalRules.forEach(rule => {
        const ruleEl = document.createElement("div");
        ruleEl.style.margin = "2px 0";
        ruleEl.style.fontSize = "0.9em";
        const ruleType = document.createElement("span");
        ruleType.textContent = rule.type;
        ruleType.style.color = rule.type === 'Available' ? 'green' : 'red';
        ruleType.style.textTransform = "capitalize";
        ruleEl.innerHTML = `&bull; <span style="color: ${rule.type === 'Available' ? 'green' : 'red'}; text-transform: capitalize;">${rule.type}</span> from ${rule.start} to ${rule.end}`;
        globalContainer.appendChild(ruleEl);
    });
    container.appendChild(globalContainer);

    // --- 2. Show Daily Rules (Editable) ---
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

    // --- 3. Add New Rule Form ---
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
* Renders the "Field & Special Activity Time Overrides" section
* UPDATED: This function now uses the new `renderTimeRulesUI`
*/
function renderFieldsOverride() {
  fieldOverridesContainer.innerHTML = '<h3>Field & Special Activity Time Overrides</h3>';

  const allFields = (masterSettings.app1.fields || []).concat(masterSettings.app1.specialActivities || []);

  if (allFields.length === 0) {
    fieldOverridesContainer.innerHTML += '<p class="muted">No fields or special activities found in Setup.</p>';
    return;
  }

  allFields.forEach(item => {
    const itemName = item.name;
    
    // Get the global rules (read-only)
    const globalRules = item.timeRules || [];
    
    // Get the daily rules (editable)
    if (!currentOverrides.dailyFieldAvailability[itemName]) {
        currentOverrides.dailyFieldAvailability[itemName] = [];
    }
    const dailyRules = currentOverrides.dailyFieldAvailability[itemName];
    
    const itemWrapper = document.createElement("div");
    itemWrapper.style.padding = "10px";
    itemWrapper.style.border = "1px solid #ddd";
    itemWrapper.style.borderRadius = "5px";
    itemWrapper.style.marginBottom = "10px";
    
    const title = document.createElement("strong");
    title.textContent = itemName;
    itemWrapper.appendChild(title);

    // Function to save data and re-render *only* this item's controls
    const saveAndRefreshControls = () => {
      window.saveCurrentDailyData("dailyFieldAvailability", currentOverrides.dailyFieldAvailability);
      // Re-render just the controls for this item
      controlsPlaceholder.innerHTML = "";
      controlsPlaceholder.appendChild(
        renderTimeRulesUI(itemName, globalRules, dailyRules, saveAndRefreshControls)
      );
    };

    const controlsPlaceholder = document.createElement("div");
    controlsPlaceholder.appendChild(
         renderTimeRulesUI(itemName, globalRules, dailyRules, saveAndRefreshControls)
    );
    
    itemWrapper.appendChild(controlsPlaceholder);
    fieldOverridesContainer.appendChild(itemWrapper);
  });
}

/**
 * UPDATED: Renders the "Daily Trips" form
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

  // --- NEW OnClick Logic ---
  addBtn.onclick = () => {
    console.log("Daily Overrides: 'Add Trip to Skeleton' button clicked.");

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

    const selectedDivisions = Array.from(divisionChipBox.querySelectorAll('.bunk-button.selected')).map(el => el.dataset.value);

    if (!name || !start || !end) {
      alert('Please enter a name, start time, and end time for the trip.');
      return;
    }
    if (selectedDivisions.length === 0) {
      alert('Please select at least one division for the trip.');
      return;
    }

    // --- 1. Get trip time range ---
    const tripStartMin = parseTimeToMinutes(start);
    const tripEndMin = parseTimeToMinutes(end);
    if (tripStartMin == null || tripEndMin == null || tripEndMin <= tripStartMin) {
        alert('Invalid time range. Please use formats like "9:00am" and ensure end is after start.');
        return;
    }

    // --- 2. Remove conflicting blocks from skeleton ---
    loadDailySkeleton(); // Ensure we have the latest
    
    dailyOverrideSkeleton = dailyOverrideSkeleton.filter(item => {
        if (!selectedDivisions.includes(item.division)) return true; 
        const itemStartMin = parseTimeToMinutes(item.startTime);
        const itemEndMin = parseTimeToMinutes(item.endTime);
        if (itemStartMin == null || itemEndMin == null) return true;
        const overlaps = (itemStartMin < tripEndMin) && (itemEndMin > tripStartMin);
        return !overlaps;
    });
    
    // --- 3. Add new trip blocks ---
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
    
    // --- 4. Save, Re-render, and Clear ---
    saveDailySkeleton(); // Saves `dailyOverrideSkeleton` to current day
    
    const gridContainer = skeletonContainer.querySelector('#daily-skeleton-grid');
    if (gridContainer) renderGrid(gridContainer);
    
    nameEl.value = ""; startEl.value = ""; endEl.value = "";
    form.querySelectorAll('.bunk-button.selected').forEach(chip => chip.click());
  };
  // --- END of NEW OnClick Logic ---

  form.appendChild(addBtn);
  tripsFormContainer.appendChild(form);
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
        if (!currentOverrides.leagues.includes(leagueName)) currentOverrides.leagues.push(leagueName);
      } else {
        currentOverrides.leagues = currentOverrides.leagues.filter(l => l !== leagueName);
      }
      
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
