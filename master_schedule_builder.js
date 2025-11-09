// =================================================================
// master_schedule_builder.js
// This file creates the new "Master Scheduler" drag-and-drop UI
//
// UPDATED:
// - The grid is now a "sightseeer" as requested.
// - Replaced <table> with a CSS <div> grid.
// - Event tiles are rendered with 'position: absolute'.
// - 'top' and 'height' are calculated based on exact minute-by-minute times,
//   allowing events to "flow" (e.g., 11:00-11:20 and 11:20-12:00).
// =================================================================

(function() {
'use strict';

let container = null;
let palette = null;
let grid = null;

let dailySkeleton = []; // This will be the "skeleton" we build
const PIXELS_PER_MINUTE = 2; // Each minute is 2px high
const INCREMENT_MINS = 30; // The "sightseeer" grid resolution

// The types of activities you can drag
const TILES = [
    { type: 'slot', name: 'General Activity Slot', style: 'background: #e0f7fa; border: 1px solid #007bff;' },
    { type: 'league', name: 'League Game', style: 'background: #d1c4e9; border: 1px solid #5e35b1;' },
    { type: 'specialty_league', name: 'Specialty League', style: 'background: #fff8e1; border: 1px solid #f9a825;' },
    { type: 'special', name: 'Special Activity', style: 'background: #e8f5e9; border: 1px solid #43a047;' },
    { type: 'swim', name: 'Swim', style: 'background: #bbdefb; border: 1px solid #1976d2;' },
    { type: 'lunch', name: 'Lunch', style: 'background: #fbe9e7; border: 1px solid #d84315;' },
    { type: 'custom', name: 'Custom Pinned Event', style: 'background: #eee; border: 1px solid #616161;' }
];

/**
 * Main entry point. Called by index.html tab click.
 */
function init() {
    container = document.getElementById("master-scheduler-content");
    if (!container) {
        console.error("Master Scheduler: Could not find container #master-scheduler-content");
        return;
    }

    // Load the skeleton for the current day
    loadDailySkeleton();
    
    // Build the UI
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

    // 1. Render the draggable tiles
    renderPalette();
    
    // 2. Render the schedule grid
    renderGrid();
    
    // 3. Hook up controls
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
 * NEW: Uses CSS Grid for layout
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
    } catch (e) { console.error("Error calculating times", e); }
    
    const totalMinutes = latestMin - earliestMin;
    const totalHeight = totalMinutes * PIXELS_PER_MINUTE;

    // Create the HTML for the grid
    let gridHtml = `<div style="display: grid; grid-template-columns: 60px repeat(${availableDivisions.length}, 1fr); position: relative;">`;
    
    // --- Header Row (Divisions) ---
    gridHtml += `<div style="grid-row: 1; position: sticky; top: 0; background: #fff; z-index: 10; border-bottom: 1px solid #999; padding: 8px;">Time</div>`;
    availableDivisions.forEach((divName, i) => {
        gridHtml += `<div style="grid-row: 1; grid-column: ${i + 2}; position: sticky; top: 0; background: ${divisions[divName]?.color || '#333'}; color: #fff; z-index: 10; border-bottom: 1px solid #999; padding: 8px; text-align: center;">${divName}</div>`;
    });

    // --- Time Column (Sightseeer) ---
    gridHtml += `<div style="grid-row: 2; grid-column: 1; height: ${totalHeight}px; position: relative; background: #f9f9f9; border-right: 1px solid #ccc;">`;
    for (let min = earliestMin; min < latestMin; min += INCREMENT_MINS) {
        const top = (min - earliestMin) * PIXELS_PER_MINUTE;
        gridHtml += `<div style="position: absolute; top: ${top}px; left: 0; width: 100%; height: ${INCREMENT_MINS * PIXELS_PER_MINUTE}px; border-bottom: 1px dashed #ddd; box-sizing: border-box; font-size: 10px; padding: 2px; color: #777;">
            ${minutesToTime(min)}
        </div>`;
    }
    gridHtml += `</div>`;
    
    // --- Division Columns (Dropzones) ---
    availableDivisions.forEach((divName, i) => {
        const divTimeline = divisions[divName]?.timeline;
        const divStart = parseTimeToMinutes(divTimeline.start);
        const divEnd = parseTimeToMinutes(divTimeline.end);
        
        gridHtml += `<div class="grid-cell" data-div="${divName}" data-start-min="${earliestMin}" style="grid-row: 2; grid-column: ${i + 2}; position: relative; height: ${totalHeight}px; border-right: 1px solid #ccc;">`;

        // Render "Out of Bounds" (disabled) areas
        if (divStart > earliestMin) {
            gridHtml += `<div style="position: absolute; top: 0; height: ${(divStart - earliestMin) * PIXELS_PER_MINUTE}px; width: 100%; background: #333; opacity: 0.5;"></div>`;
        }
        if (divEnd < latestMin) {
            gridHtml += `<div style="position: absolute; top: ${(divEnd - earliestMin) * PIXELS_PER_MINUTE}px; height: ${(latestMin - divEnd) * PIXELS_PER_MINUTE}px; width: 100%; background: #333; opacity: 0.5;"></div>`;
        }

        // Render *events* for this division
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
    
    // --- Add Drop Zone Listeners ---
    addDropListeners('.grid-cell');
}

/**
 * Helper to add all the drag/drop event listeners
 */
function addDropListeners(selector) {
    grid.querySelectorAll(selector).forEach(cell => {
        cell.ondragover = (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            cell.style.backgroundColor = '#e0ffe0'; // Highlight
        };
        
        cell.ondragleave = () => {
            cell.style.backgroundColor = ''; // Remove highlight
        };
        
        cell.ondrop = (e) => {
            e.preventDefault();
            cell.style.backgroundColor = '';
            
            const tileData = JSON.parse(e.dataTransfer.getData('application/json'));
            const divName = cell.dataset.div;
            
            // NEW: Calculate drop time based on mouse Y position
            const rect = cell.getBoundingClientRect();
            const scrollTop = grid.scrollTop; // Get scroll position
            const y = e.clientY - rect.top + scrollTop;
            const droppedMin = Math.round(y / PIXELS_PER_MINUTE / 15) * 15; // Snap to 15 mins
            const earliestMin = parseInt(cell.dataset.startMin, 10);
            const defaultStartTime = minutesToTime(earliestMin + droppedMin);
            
            // --- This is the PROMPT logic you requested ---
            let eventType = 'slot';
            let eventName = tileData.name;
            
            if (tileData.type === 'slot') {
                eventName = 'General Activity Slot';
                eventType = 'slot';
            } else if (tileData.type === 'league' || tileData.type === 'specialty_league' || tileData.type === 'special' || tileData.type === 'swim') {
                eventType = 'slot';
                eventName = tileData.name; 
            } else if (tileData.type === 'lunch' || tileData.type === 'custom') {
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
                    eventName = tileData.name; // "Lunch"
                }
            }


            const startTime = prompt(`Add "${eventName}" for ${divName}?\n\nEnter Start Time:`, defaultStartTime);
            if (!startTime) return;
            
            const endTime = prompt(`Enter End Time:`);
            if (!endTime) return;
            
            const newEvent = {
                id: `evt_${Math.random().toString(36).slice(2, 9)}`,
                type: eventType,
                event: eventName,
                division: divName,
                startTime: startTime,
                endTime: endTime
            };
            
            dailySkeleton.push(newEvent);
            saveDailySkeleton();
            renderGrid(); // Re-render to show the new tile
        };
    });
}

/**
 * Renders a single event tile
 */
function renderEventTile(event, top, height) {
    const tile = TILES.find(t => t.name === event.event) || TILES.find(t => t.type === 'custom');
    const style = tile ? tile.style : 'background: #eee; border: 1px solid #616161;';
    
    // THIS IS THE FIX: The div is now absolutely positioned
    return `
        <div class="grid-event" 
             data-event-id="${event.id}" 
             style="${style}; 
                    padding: 2px 5px; 
                    border-radius: 4px; 
                    text-align: center; 
                    margin: 0 1px;
                    font-size: 0.9em;
                    position: absolute;
                    top: ${top}px;
                    height: ${height}px;
                    width: calc(100% - 4px); /* Full width minus margins */
                    box-sizing: border-box;
                    overflow: hidden;">
            <strong>${event.event}</strong>
            <div style="font-size: 0.85em;">${event.startTime} - ${event.endTime}</div>
        </div>
    `;
}

/**
 * Runs the optimizer in the core logic file
 */
function runOptimizer() {
    if (!window.runSkeletonOptimizer) {
        alert("Error: 'runSkeletonOptimizer' function not found. Is scheduler_logic_core.js loaded?");
        return;
    }
    
    console.log("Running optimizer with this skeleton:", dailySkeleton);
    
    // Save the skeleton first
    saveDailySkeleton();
    
    // Call the "brain"
    const success = window.runSkeletonOptimizer(dailySkeleton);
    
    if (success) {
        alert("Schedule Generated Successfully!");
        // Switch to the "View" tab
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
    if (hh === 12) hh = mer === "am" ? 0 : 12; // 12am -> 0, 12pm -> 12
    else if (mer === "pm") hh += 12; // 1pm -> 13
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
