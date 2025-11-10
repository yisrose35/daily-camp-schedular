// =================================================================
// master_schedule_builder.js
// This file creates the new "Master Scheduler" drag-and-drop UI
//
// UPDATED:
// - **REMOVED** all logic related to `division.timeline` from
//   `renderGrid`. The grid will no longer render grayed-out areas
//   for individual divisions.
// - `renderGrid` now reads `globalStartTime` and `globalEndTime`
//   to determine the grid's time range.
// - **CRITICAL FIX:** Ensured the file ends with `})();`.
// =================================================================

(function() {
'use strict';

let container = null;
let palette = null;
let grid = null;

let dailySkeleton = []; // This will be the "skeleton" we build
const PIXELS_PER_MINUTE = 2; // Each minute is 2px high
const INCREMENT_MINS = 30; // The "sightseeer" grid resolution

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
 * Main entry point. Called by index.html tab click.
 */
function init() {
    container = document.getElementById("master-scheduler-content");
    if (!container) return;

    loadDailySkeleton();
    
    container.innerHTML = `
        <div id="scheduler-palette" style="padding: 10px; background: #f4f4f4; border-radius: 8px; margin-bottom: 15px; display: flex; flex-wrap: wrap; gap: 10px;">
            </div>
        <div id="scheduler-controls" style="margin-bottom: 15px; display: flex; justify-content: flex-end; align-items: center;">
            <button id="save-default-skeleton-btn" style="background: #007bff; color: white; padding: 12px 20px; font-size: 1.2em; border: none; border-radius: 5px; cursor: pointer; margin-right: 10px;">
                Save as Default Schedule
            </button>
            <button id="run-optimizer-btn" style="background: #28a745; color: white; padding: 12px 20px; font-size: 1.2em; border: none; border-radius: 5px; cursor: pointer;">
                Run Optimizer & Create Schedule
            </button>
        </div>
        <div id="scheduler-grid" style="overflow-x: auto; border: 1px solid #999;">
            </div>
    `;
    
    palette = document.getElementById("scheduler-palette");
    grid = document.getElementById("scheduler-grid");

    renderPalette();
    renderGrid();
    
    document.getElementById("save-default-skeleton-btn").onclick = () => {
        if (confirm("Save this layout as the default for all new days?\n\nThis will overwrite any existing default.")) {
            try {
                const globalSettings = window.loadGlobalSettings?.() || {};
                const app1Data = globalSettings.app1 || {};
                
                // Save the current IN-MEMORY skeleton as the new default
                app1Data.defaultSkeleton = dailySkeleton; 
                
                window.saveGlobalSettings?.("app1", app1Data);
                alert("Default schedule saved!");
            } catch (e) {
                console.error("Failed to save default skeleton:", e);
                alert("Error saving default schedule. See console for details.");
            }
        }
    };
    
    document.getElementById("run-optimizer-btn").onclick = () => {
        runOptimizer();
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
        
        // --- NEW CLICK LISTENER ---
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
    
    // --- NEW: Load global times from app1 settings ---
    const globalSettings = window.loadGlobalSettings?.() || {};
    const app1Data = globalSettings.app1 || {};
    // Use fallback defaults if values are empty strings
    const globalStart = app1Data.globalStartTime || "9:00 AM";
    const globalEnd = app1Data.globalEndTime || "4:00 PM";
    
    let earliestMin = parseTimeToMinutes(globalStart);
    let latestMin = parseTimeToMinutes(globalEnd);

    // Failsafe if times are invalid
    if (earliestMin == null) earliestMin = 540; // 9:00 AM
    if (latestMin == null) latestMin = 960; // 4:00 PM
    if (latestMin <= earliestMin) latestMin = earliestMin + 60; // Ensure at least 1 hour
    
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
        // --- REMOVED timeline, divStart, divEnd logic ---
        
        gridHtml += `<div class="grid-cell" data-div="${divName}" data-start-min="${earliestMin}" style="grid-row: 2; grid-column: ${i + 2}; position: relative; height: ${totalHeight}px; border-right: 1px solid #ccc;">`;

        // --- REMOVED grayed-out area 'if' blocks ---

        dailySkeleton.filter(ev => ev.division === divName).forEach(event => {
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
    grid.innerHTML = gridHtml;
    
    // --- Add Listeners ---
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

            if (tileData.type === 'activity') {
                eventName = 'General Activity Slot';
                eventType = 'slot';
            
            } else if (tileData.type === 'sports') {
                eventName = 'Sports Slot';
                eventType = 'slot';
                
            } else if (tileData.type === 'special') {
                eventName = 'Special Activity';
                eventType = 'slot';

            } else if (tileData.type === 'league' || tileData.type === 'specialty_league' || tileData.type === 'swim') {
                eventType = 'slot';
                eventName = tileData.name; 
            
            } else if (tileData.type === 'split') {
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
            // DO NOT SAVE - RENDER ONLY
            renderGrid(); 
        };
    });
}

/**
 * NEW: Helper to add click-to-remove listeners
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
                // DO NOT SAVE - RENDER ONLY
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
        if (event.type === 'split') {
            tile = TILES.find(t => t.type === 'split');
        } else if (event.event === 'General Activity Slot') {
            tile = TILES.find(t => t.type === 'activity');
        } else if (event.event === 'Sports Slot') {
            tile = TILES.find(t => t.type === 'sports');
        } else if (event.event === 'Special Activity') {
            tile = TILES.find(t => t.type === 'special');
        } else {
            tile = TILES.find(t => t.type === 'custom'); // Default fallback
        }
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

function runOptimizer() {
    if (!window.runSkeletonOptimizer) {
        alert("Error: 'runSkeletonOptimizer' function not found. Is scheduler_logic_core.js loaded?");
        return;
    }
    
    // We must load the *current day's* skeleton to run the optimizer
    const dailyData = window.loadCurrentDailyData?.() || {};
    let skeletonToRun = dailyData.manualSkeleton;
    let skeletonSource = "this day's override";
    
    // If no daily skeleton, load the default
    if (!skeletonToRun || skeletonToRun.length === 0) {
         const globalSettings = window.loadGlobalSettings?.() || {};
         const app1Data = globalSettings.app1 || {};
         // Deep copy the default skeleton
         skeletonToRun = JSON.parse(JSON.stringify(app1Data.defaultSkeleton || []));
         skeletonSource = "the default template";
    }
    
    if (skeletonToRun.length === 0) {
        alert("Skeleton is empty. Please add blocks to the schedule before running the optimizer.");
        return;
    }

    // --- THIS IS THE FIX ---
    // Save the chosen skeleton (either default or override)
    // to this day's data so the Staggered View can find it.
    console.log(`Running optimizer with skeleton from: ${skeletonSource}`);
    window.saveCurrentDailyData?.("manualSkeleton", skeletonToRun);
    // --- END OF FIX ---
    
    const success = window.runSkeletonOptimizer(skeletonToRun);
    
    if (success) {
        alert("Schedule Generated Successfully!");
        // Use window.showTab, not just showTab, for safety
        window.showTab?.('schedule');
    } else {
        alert("Error during schedule generation. Check console for details (or skeleton may be empty).");
    }
}

// --- Save/Load Skeleton ---

/**
 * --- UPDATED: loadDailySkeleton ---
 * This function now *only* loads the global "defaultSkeleton".
 */
function loadDailySkeleton() {
    const globalSettings = window.loadGlobalSettings?.() || {};
    const app1Data = globalSettings.app1 || {};
    // Must deep-copy so that in-memory edits don't affect the saved default
    dailySkeleton = JSON.parse(JSON.stringify(app1Data.defaultSkeleton || []));
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
