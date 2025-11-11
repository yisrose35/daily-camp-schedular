// =================================================================
// master_schedule_builder.js
//
// UPDATED:
// - **Major UI Overhaul:**
//   - `init` function completely rebuilt to add a
//     "Template Management" and "Day of Week Assignments" section.
//   - Removed the old "Save as Default" button.
// - **New Helper Functions:**
//   - `renderTemplateUI`: Builds the new management controls.
//   - `loadSkeletonToBuilder`: New function to load a selected
//     template into the grid.
// - **Updated `loadDailySkeleton`:**
//   - This function is now the core of your new feature.
//   - It gets the current date from `window.currentScheduleDate`.
//   - It checks `skeletonAssignments` for the day of the week.
//   - It loads the correct skeleton (or a fallback).
// - **BUG FIX:**
//   - The local `runOptimizer` function was loading the wrong
//     skeleton. It is now fixed to run the optimizer on the
//     skeleton *currently visible in the builder* (`dailySkeleton`).
// =================================================================

(function() {
'use strict';

let container = null;
let palette = null;
let grid = null;

let dailySkeleton = []; // This will be the "skeleton" we build
const PIXELS_PER_MINUTE = 2; // Each minute is 2px high
const INCREMENT_MINS = 30; // The "sightseeer" grid resolution

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
 * Main entry point. Called by index.html tab click.
 * --- HEAVILY UPDATED ---
 */
function init() {
    container = document.getElementById("master-scheduler-content");
    if (!container) return;

    // 1. Load the correct skeleton for the current date
    loadDailySkeleton();
    
    // 2. Build the main UI
    container.innerHTML = `
        <div id="scheduler-template-ui" style="padding: 15px; background: #f9f9f9; border: 1px solid #ddd; border-radius: 8px; margin-bottom: 20px;">
            </div>
        
        <div id="scheduler-palette" style="padding: 10px; background: #f4f4f4; border-radius: 8px; margin-bottom: 15px; display: flex; flex-wrap: wrap; gap: 10px;">
            </div>
        
        <div id="scheduler-controls" style="margin-bottom: 15px; display: flex; justify-content: flex-end; align-items: center;">
            <button id="run-optimizer-btn" style="background: #28a745; color: white; padding: 12px 20px; font-size: 1.2em; border: none; border-radius: 5px; cursor: pointer;">
                Run Optimizer & Create Schedule
            </button>
        </div>
        
        <div id="scheduler-grid" style="overflow-x: auto; border: 1px solid #999;">
            </div>
    `;
    
    palette = document.getElementById("scheduler-palette");
    grid = document.getElementById("scheduler-grid");

    // 3. Render all components
    renderTemplateUI(); // NEW
    renderPalette();
    renderGrid();
    
    // 4. Hook up optimizer button
    document.getElementById("run-optimizer-btn").onclick = () => {
        runOptimizer();
    };
}

/**
 * NEW: Renders the new template management UI
 */
function renderTemplateUI() {
    const uiContainer = document.getElementById("scheduler-template-ui");
    if (!uiContainer) return;

    const savedSkeletons = window.getSavedSkeletons?.() || {};
    const skeletonNames = Object.keys(savedSkeletons).sort();
    const assignments = window.getSkeletonAssignments?.() || {};

    let loadOptions = skeletonNames.map(name => `<option value="${name}">${name}</option>`).join('');

    uiContainer.innerHTML = `
        <style>
            .template-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
            .template-section { border: 1px solid #eee; padding: 15px; border-radius: 5px; background: #fff; }
            .template-section h4 { margin-top: 0; }
            .template-section label { display: block; margin-bottom: 5px; font-weight: 600; }
            .template-section input, .template-section select { width: 100%; padding: 8px; box-sizing: border-box; }
            .day-assignment { display: grid; grid-template-columns: 100px 1fr; gap: 10px; align-items: center; margin-bottom: 8px; }
        </style>
        
        <div class="template-grid">
            <div class="template-section">
                <h4>Save / Load Template</h4>
                <label for="template-load-select">Load Saved Template:</label>
                <select id="template-load-select">
                    <option value="">-- Select a template to load --</option>
                    ${loadOptions}
                </select>
                <hr style="margin: 15px 0;">
                <label for="template-save-name">Save Current Schedule as:</label>
                <input type="text" id="template-save-name" placeholder="e.g., 'Regular Day' or 'Friday Short'">
                <button id="template-save-btn" style="margin-top: 10px; padding: 8px 12px;">Save</button>
                <button id="template-delete-btn" style="margin-top: 10px; padding: 8px 12px; background: #c0392b; color: white; border: none; margin-left: 5px;">Delete Selected</button>
            </div>
            
            <div class="template-section">
                <h4>Day of Week Assignments</h4>
                <div class="day-assignment">
                    <label for="assign-Sunday">Sunday:</label>
                    <select id="assign-Sunday" data-day="Sunday">${loadOptions}</select>
                </div>
                <div class="day-assignment">
                    <label for="assign-Monday">Monday:</label>
                    <select id="assign-Monday" data-day="Monday">${loadOptions}</select>
                </div>
                <div class="day-assignment">
                    <label for="assign-Tuesday">Tuesday:</label>
                    <select id="assign-Tuesday" data-day="Tuesday">${loadOptions}</select>
                </div>
                <div class="day-assignment">
                    <label for="assign-Wednesday">Wednesday:</label>
                    <select id="assign-Wednesday" data-day="Wednesday">${loadOptions}</select>
                </div>
                <div class="day-assignment">
                    <label for="assign-Thursday">Thursday:</label>
                    <select id="assign-Thursday" data-day="Thursday">${loadOptions}</select>
                </div>
                <div class="day-assignment">
                    <label for="assign-Friday">Friday:</label>
                    <select id="assign-Friday" data-day="Friday">${loadOptions}</select>
                </div>
                <div class="day-assignment">
                    <label for="assign-Saturday">Saturday:</label>
                    <select id="assign-Saturday" data-day="Saturday">${loadOptions}</select>
                </div>
                <div class="day-assignment" style="border-top: 1px solid #eee; padding-top: 8px;">
                    <label for="assign-Default"><b>Default:</b></label>
                    <select id="assign-Default" data-day="Default">${loadOptions}</select>
                </div>
                <button id="template-assign-save-btn" style="margin-top: 10px; padding: 8px 12px;">Save Assignments</button>
            </div>
        </div>
    `;

    // --- Hook up event listeners ---
    const loadSelect = document.getElementById("template-load-select");
    const saveNameInput = document.getElementById("template-save-name");

    // Load button
    loadSelect.onchange = () => {
        const name = loadSelect.value;
        if (name && savedSkeletons[name]) {
            if (confirm(`Load "${name}"? This will replace the current grid.`)) {
                loadSkeletonToBuilder(name);
                saveNameInput.value = name; // Pre-fill name for re-saving
            } else {
                loadSelect.value = ""; // Reset dropdown
            }
        }
    };
    
    // Save button
    document.getElementById("template-save-btn").onclick = () => {
        const name = saveNameInput.value.trim();
        if (!name) {
            alert("Please enter a name for this template.");
            return;
        }
        if (confirm(`Save current schedule as "${name}"? This will overwrite any existing template with this name.`)) {
            window.saveSkeleton?.(name, dailySkeleton);
            alert("Template saved!");
            renderTemplateUI(); // Re-render to update dropdowns
        }
    };

    // Delete button
    document.getElementById("template-delete-btn").onclick = () => {
        const name = loadSelect.value;
        if (!name) {
            alert("Please select a template to delete from the dropdown first.");
            return;
        }
        if (confirm(`Are you sure you want to permanently delete "${name}"?`)) {
            window.deleteSkeleton?.(name);
            alert("Template deleted!");
            renderTemplateUI(); // Re-render
            loadSkeletonToBuilder(null); // Load an empty grid
        }
    };

    // Populate day assignment dropdowns
    const assignmentSelects = uiContainer.querySelectorAll('.day-assignment select');
    assignmentSelects.forEach(select => {
        const day = select.dataset.day;
        const assignedTemplate = assignments[day] || "";
        // Add a "None" option
        const noneOption = document.createElement('option');
        noneOption.value = "";
        noneOption.textContent = (day === "Default") ? "-- Use No Default --" : "-- Use Default --";
        select.prepend(noneOption);
        
        select.value = assignedTemplate;
    });

    // Save Assignments button
    document.getElementById("template-assign-save-btn").onclick = () => {
        const newAssignments = {};
        assignmentSelects.forEach(select => {
            const day = select.dataset.day;
            const templateName = select.value;
            if (templateName) {
                newAssignments[day] = templateName;
            }
        });
        window.saveSkeletonAssignments?.(newAssignments);
        alert("Assignments saved!");
    };
}

/**
 * Renders the draggable tiles
 */
function renderPalette() {
    palette.innerHTML = '<span style="font-weight: 600; align-self: center;">Drag tiles onto the grid:</span>';
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
        
        el.ondragend = () => {
            el.style.cursor = 'grab';
        };
        
        palette.appendChild(el);
    });
}

/**
 * Renders the main schedule grid
 */
function renderGrid() {
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
        gridHtml += `<div style="position: absolute; top: ${top}px; left: 0; width: 100%; height: ${INCREMENT_MINS * PIXELS_PER_MINUTE}px; border-bottom: 1px dashed #ddd; box-sizing: border-box; font-size: 10px; padding: 2px; color: #777;">
            ${minutesToTime(min)}
        </div>`;
    }
    gridHtml += `</div>`;
    
    availableDivisions.forEach((divName, i) => {
        gridHtml += `<div class="grid-cell" data-div="${divName}" data-start-min="${earliestMin}" style="grid-row: 2; grid-column: ${i + 2}; position: relative; height: ${totalHeight}px; border-right: 1px solid #ccc;">`;
        
        // --- REMOVED Grayed-out area logic ---

        dailySkeleton.filter(ev => ev.division === divName).forEach(event => {
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
    grid.innerHTML = gridHtml;
    
    addDropListeners('.grid-cell');
    addRemoveListeners('.grid-event');
}

/**
 * Helper to add all the drag/drop event listeners
 */
function addDropListeners(selector) {
    grid.querySelectorAll(selector).forEach(cell => {
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
            const scrollTop = grid.scrollTop; 
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

                const eventName1 = prompt("Enter name for FIRST activity (e.g., Swim, Sports, Activity):");
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
                    
                    if (confirm("Does this event require scheduling (like 'General Activity')?\n\n- OK = Yes (it's a 'Slot' to be filled)\n- Cancel = No (it's a 'Pinned' event like 'Snacks')")) {
                        eventType = 'slot';
                    } else {
                        eventType = 'pinned';
                    }
                } else {
                    eventName = tileData.name;
                }
            }

            if (!newEvent) {
                const startTime = prompt(`Add "${eventName}" for ${divName}?\n\nEnter Start Time:`, defaultStartTime);
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
            
            dailySkeleton.push(newEvent);
            renderGrid(); 
        };
    });
}

/**
 * Helper to add click-to-remove listeners
 */
function addRemoveListeners(selector) {
    grid.querySelectorAll(selector).forEach(tile => {
        tile.onclick = (e) => {
            e.stopPropagation(); 
            
            const eventId = tile.dataset.eventId;
            if (!eventId) return;

            const event = dailySkeleton.find(ev => ev.id === eventId);
            const eventName = event ? event.event : 'this event';

            if (confirm(`Are you sure you want to remove "${eventName}"?`)) {
                dailySkeleton = dailySkeleton.filter(ev => ev.id !== eventId);
                renderGrid();
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
             style="${style}; 
                    padding: 2px 5px; 
                    border-radius: 4px; 
                    text-align: center; 
                    margin: 0 1px;
                    font-size: 0.9em;
                    position: absolute;
                    top: ${top}px;
                    height: ${height}px;
                    width: calc(100% - 4px);
                    box-sizing: border-box;
                    overflow: hidden;
                    cursor: pointer;">
            <strong>${event.event}</strong>
            <div style="font-size: 0.85em;">${event.startTime} - ${event.endTime}</div>
        </div>
    `;
}

/**
 * --- BUG FIX ---
 * This function now runs the optimizer on the in-memory
 * `dailySkeleton` instead of re-loading from storage.
 */
function runOptimizer() {
    if (!window.runSkeletonOptimizer) {
        alert("Error: 'runSkeletonOptimizer' function not found. Is scheduler_logic_core.js loaded?");
        return;
    }
    
    // Use the skeleton currently in the builder
    if (dailySkeleton.length === 0) {
        alert("Skeleton is empty. Please add blocks to the schedule before running the optimizer.");
        return;
    }

    // Save this skeleton to the *current day* so the
    // staggered view can read it.
    window.saveCurrentDailyData?.("manualSkeleton", dailySkeleton);
    
    const success = window.runSkeletonOptimizer(dailySkeleton);
    
    if (success) {
        alert("Schedule Generated Successfully!");
        window.showTab?.('schedule');
    } else {
        alert("Error during schedule generation. Check console for details (or skeleton may be empty).");
    }
}

// --- Save/Load Skeleton ---

/**
 * --- UPDATED: loadDailySkeleton ---
 * This function now loads the correct skeleton based on
 * the day of the week and assignments.
 */
function loadDailySkeleton() {
    const assignments = window.getSkeletonAssignments?.() || {};
    const skeletons = window.getSavedSkeletons?.() || {};
    
    // Get day of week (0=Sun, 1=Mon, ..., 6=Sat)
    // We must parse the YYYY-MM-DD string safely
    const dateStr = window.currentScheduleDate || "";
    const [year, month, day] = dateStr.split('-').map(Number);
    let dayOfWeek = 0;
    if (year && month && day) {
        // Note: month is 0-indexed for Date object
        const date = new Date(year, month - 1, day);
        dayOfWeek = date.getDay();
    }
    
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const todayName = dayNames[dayOfWeek];

    let templateName = assignments[todayName]; // 1. Try to find a template for this specific day
    if (!templateName || !skeletons[templateName]) {
        templateName = assignments["Default"]; // 2. Fall back to the "Default" template
    }
    
    let skeletonToLoad = skeletons[templateName]; // 3. Get the skeleton
    
    if (skeletonToLoad) {
        // Deep-copy the skeleton so in-memory edits don't affect the saved template
        dailySkeleton = JSON.parse(JSON.stringify(skeletonToLoad));
    } else {
        // 4. Final fallback: an empty skeleton
        dailySkeleton = [];
    }
}

/**
 * NEW: Loads a specific skeleton into the builder
 */
function loadSkeletonToBuilder(name) {
    if (!name) {
        dailySkeleton = [];
    } else {
        const skeletons = window.getSavedSkeletons?.() || {};
        const skeletonToLoad = skeletons[name];
        if (skeletonToLoad) {
            dailySkeleton = JSON.parse(JSON.stringify(skeletonToLoad));
        } else {
            dailySkeleton = [];
        }
    }
    // Re-render the grid with the newly loaded skeleton
    renderGrid();
}


// --- Helper Functions ---
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

function minutesToTime(min) {
    const hh = Math.floor(min / 60);
    const mm = min % 60;
    const h = hh % 12 === 0 ? 12 : hh % 12;
    const m = String(mm).padStart(2, '0');
    const ampm = hh < 12 ? 'am' : 'pm';
    return `${h}:${m}${ampm}`;
}


// Expose the init function to the global window
window.initMasterScheduler = init;

})();
