// =================================================================
// master_schedule_builder.js
// This file creates the new "Master Scheduler" drag-and-drop UI
//
// UPDATED:
// - **NEW (User Request): Click to Remove**
//   - `renderEventTile`: Now adds a `cursor: pointer` and `title`
//     to indicate tiles are clickable.
//   - `renderGrid`: Now calls a new function `addRemoveListeners`
//     after the grid is rendered.
//   - `addRemoveListeners` (New): This function attaches an `onclick`
//     handler to all `.grid-event` tiles. Clicking a tile
//     confirms, removes the event from `dailySkeleton`, saves,
//     and re-renders the grid.
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
    { type: 'activity', name: 'Activity', style: 'background: #e0f7fa; border: 1px solid #007bff;' }, // Hybrid
    { type: 'sports', name: 'Sports', style: 'background: #dcedc8; border: 1px solid #689f38;' }, // Sports-only
    { type: 'special', name: 'Special Activity', style: 'background: #e8f5e9; border: 1px solid #43a047;' }, // Special-only
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
    
    let earliestMin = 540; // 9:00 AM
    let latestMin = 960; // 4:00 PM
    
    try {
        availableDivisions.forEach(divName => {
            const timeline = divisions[divName]?.timeline;
            if (timeline) {
                earliestMin = Math.min(earliestMin, parseTimeToMinutes(timeline.start) || 540);
                latestMin = Math.max(latestMin, parseTimeToMinutes(timeline.end) || 960);
            }
        });
    } catch (e) { /* ignore */ }
    
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
        const divStart = parseTimeToMinutes(divTimeline.start);
        const divEnd = parseTimeToMinutes(divTimeline.end);
        
        gridHtml += `<div class="grid-cell" data-div="${divName}" data-start-min="${earliestMin}" style="grid-row: 2; grid-column: ${i + 2}; position: relative; height: ${totalHeight}px; border-right: 1px solid #ccc;">`;

        if (divStart > earliestMin) {
            gridHtml += `<div style="position: absolute; top: 0; height: ${(divStart - earliestMin) * PIXELS_PER_MINUTE}px; width: 100%; background: #333; opacity: 0.5;"></div>`;
        }
        if (divEnd < latestMin) {
            gridHtml += `<div style="position: absolute; top: ${(divEnd - earliestMin) * PIXELS_PER_MINUTE}px; height: ${(latestMin - divEnd) * PIXELS_PER_MINUTE}px; width: 100%; background: #333; opacity: 0.5;"></div>`;
        }

        dailySkeleton.filter(ev => ev.division === divName).forEach(event => {
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
    grid.innerHTML = gridHtml;
    
    // --- Add Listeners ---
    addDropListeners('.grid-cell');
    addRemoveListeners('.grid-event'); // NEW
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
            saveDailySkeleton();
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
            e.stopPropagation(); // Prevent triggering drop listener if it overlaps
            
            const eventId = tile.dataset.eventId;
            if (!eventId) return;

            // Find the event name for the confirmation
            const event = dailySkeleton.find(ev => ev.id === eventId);
            const eventName = event ? event.event : 'this event';

            if (confirm(`Are you sure you want to remove "${eventName}"?`)) {
                // Filter the skeleton array to remove the item
                dailySkeleton = dailySkeleton.filter(ev => ev.id !== eventId);
                
                // Save the updated skeleton
                saveDailySkeleton();
                
                // Re-render the grid to show the change
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
    
    // UPDATED: Added cursor: pointer and title
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
    
    saveDailySkeleton();
    
    const success = window.runSkeletonOptimizer(dailySkeleton);
    
    if (success) {
        alert("Schedule Generated Successfully!");
        showTab('schedule');
    } else {
        alert("Error during schedule generation. Check console for details.");
    }
}

// --- Save/Load Skeleton ---
function loadDailySkeleton() {
    const dailyData = window.loadCurrentDailyData?.() || {};
    dailySkeleton = dailyData.manualSkeleton || [];
}
function saveDailySkeleton() {
    window.saveCurrentDailyData?.("manualSkeleton", dailySkeleton);
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
