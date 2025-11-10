// =================================================================
// daily_overrides.js
// This file creates the UI for the "Daily Overrides" tab.
//
// UPDATED:
// - **NEW:** `renderGrid` now reads `globalStartTime` and `globalEndTime`
//   from the global settings (set in app1.js) to determine the
//   grid's time range.
// - **RESTORED** `division.timeline` logic in the skeleton
//   editor's `renderGrid` function to show grayed-out areas.
// =================================================================

(function() {
'use strict';

let container = null;
let masterSettings = {};
let currentOverrides = {
  dailyFieldAvailability: {},
  leagues: [],
  disabledSpecialtyLeagues: []
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

// --- UPDATED TILES array with descriptions ---
const TILES = [
    { 
        type: 'activity', 
        name: 'Activity', 
        style: 'background: #e0f7fa; border: 1px solid #007bff;',
        description: "A flexible slot. The optimizer will fill this with the best available Sport OR Special Activity based on availability and rotation."
    },
    { 
        type: 'sports', 
        name: 'Sports', 
        style: 'background: #dcedc8; border: 1px solid #689f38;',
        description: "A dedicated sports slot. The optimizer will fill this *only* with a Sport (e.g., Basketball, Soccer) from your 'Fields' list."
    },
    { 
        type: 'special', 
        name: 'Special Activity', 
        style: 'background: #e8f5e9; border: 1px solid #43a047;',
        description: "A dedicated special slot. The optimizer will fill this *only* with a Special Activity (e.g., Canteen, Arts & Crafts) from your 'Special Activities' list."
    },
    { 
        type: 'split', 
        name: 'Split Activity', 
        style: 'background: #fff3e0; border: 1px solid #f57c00;',
        description: "Creates a block that is split in two. You will be asked to name two different activities (e.g., Swim / Activity). The division will be split, and they will switch activities halfway through the block."
    },
    { 
        type: 'league', 
        name: 'League Game', 
        style: 'background: #d1c4e9; border: 1px solid #5e35b1;',
        description: "A dedicated slot for a regular League Game. The optimizer will automatically create matchups from your 'Leagues' tab (e.g., Team A vs. Team B) and find a field for them."
    },
    { 
        type: 'specialty_league', 
        name: 'Specialty League', 
        style: 'background: #fff8e1; border: 1px solid #f9a825;',
        description: "A dedicated slot for a Specialty League. The optimizer will create matchups from your custom teams (e.g., Blue vs. Gold) and assign them to their exclusive fields."
    },
    { 
        type: 'swim', 
        name: 'Swim', 
        style: 'background: #bbdefb; border: 1px solid #1976d2;',
        description: "A 'pinned' event. The optimizer will block out this time for 'Swim' and will not schedule anything else here. This is a simple block and does not use the optimizer."
    },
    { 
        type: 'lunch', 
        name: 'Lunch', 
        style: 'background: #fbe9e7; border: 1px solid #d84315;',
        description: "A 'pinned' event. The optimizer will block out this time for 'Lunch' and will not schedule anything else here. This is a simple block and does not use the optimizer."
    },
    { 
        type: 'snacks', 
        name: 'Snacks', 
        style: 'background: #fff9c4; border: 1px solid #fbc02d;',
        description: "A 'pinned' event. The optimizer will block out this time for 'Snacks' and will not schedule anything else here. This is a simple block and does not use the optimizer."
    },
    { 
        type: 'custom', 
        name: 'Custom Pinned Event', 
        style: 'background: #eee; border: 1px solid #616161;',
        description: "A 'pinned' event. You will be asked to give it a custom name (e.g., 'Assembly' or 'Trip'). The optimizer will block out this time and will not schedule anything else here."
    }
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

        // --- NEW CLICK LISTENER ---
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
    
    // --- NEW: Load global times from app1 settings ---
    const globalSettings = window.loadGlobalSettings?.() || {};
    const app1Data = globalSettings.app1 || {};
    const globalStart = app1Data.globalStartTime || "9:00 AM";
    const globalEnd = app1Data.globalEndTime || "4:00 PM";
    
    let earliestMin = parseTimeToMinutes(globalStart);
    let latestMin = parseTimeToMinutes(globalEnd);

    // Failsafe if times are invalid
    if (earliestMin == null) earliestMin = 540; // 9:00 AM
    if (latestMin == null) latestMin = 960; // 4:00 PM
    if (latestMin <= earliestMin) latestMin = earliestMin + 60; // Ensure at least 1 hour
    
    // --- OLD logic removed ---
    
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
        // --- RESTORED ---
        const divTimeline = divisions[divName]?.timeline;
        const divStart = parseTimeToMinutes(divTimeline?.start);
        const divEnd = parseTimeToMinutes(divTimeline?.end);
        
        gridHtml += `<div class="grid-cell" data-div="${divName}" data-start-min="${earliestMin}" style="grid-row: 2; grid-column: ${i + 2}; position: relative; height: ${totalHeight}px; border-right: 1px solid #ccc;">`;
        
        // --- RESTORED ---
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
            
            // Clamp rendering to the grid boundaries
            const visibleStartMin = Math.max(startMin, earliestMin);
            const visibleEndMin = Math.min(endMin, latestMin);

            if (visibleEndMin <= visibleStartMin) return; // Skip if not visible

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
  
  // --- UPDATED: Re-ordered layout ---
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
  
