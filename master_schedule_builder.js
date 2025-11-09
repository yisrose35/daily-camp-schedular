// =================================================================
// master_schedule_builder.js
// This file creates the new "Master Scheduler" drag-and-drop UI
// to visually build the "Skeleton" for the day.
//
// UPDATED:
// - Swapped grid axis: Time is now Y-axis (rows), Divisions are X-axis (columns).
// - Removed the "Staggered View" toggle. This tab is now always in the "Fixed Grid" layout.
// =================================================================

(function() {
'use strict';

let container = null;
let palette = null;
let grid = null;

let dailySkeleton = []; // This will be the "skeleton" we build

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
        <div id="scheduler-grid" style="overflow-x: auto;">
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
 * NEW: Time on Y-axis, Divisions on X-axis
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
    
    // Create the HTML for the grid
    let table = '<table class="master-schedule-grid" style="border-collapse: collapse; width: 100%;">';
    
    // Header Row (Divisions)
    table += '<thead><tr><th style="border: 1px solid #999; padding: 8px;">Time</th>';
    availableDivisions.forEach(divName => {
        table += `<th style="min-width: 150px; border: 1px solid #999; padding: 8px;">${divName}</th>`;
    });
    table += '</tr></thead>';
    
    // Body Rows (One per 30-min slot)
    table += '<tbody>';
    for (let min = earliestMin; min < latestMin; min += 30) {
        table += `<tr><td style="font-weight: 600; vertical-align: top; border: 1px solid #999; padding: 8px;">${minutesToTime(min)}</td>`;
        
        availableDivisions.forEach(divName => {
            const divTimeline = divisions[divName]?.timeline;
            const divStart = parseTimeToMinutes(divTimeline.start);
            const divEnd = parseTimeToMinutes(divTimeline.end);

            // Check if this slot is outside the division's time
            if (min < divStart || min >= divEnd) {
                table += `<td class="grid-cell-disabled" style="background: #333; border: 1px solid #999;"></td>`;
            } else {
                table += `<td class="grid-cell" data-div="${divName}" data-time-min="${min}" style="height: 50px; border: 1px dashed #ccc; padding: 2px; vertical-align: top;">`;
                // Find events that START in this cell
                dailySkeleton.filter(ev => ev.division === divName && parseTimeToMinutes(ev.startTime) === min)
                             .forEach(ev => table += renderEventTile(ev));
                table += `</td>`;
            }
        });
        table += '</tr>';
    }
    table += '</tbody></table>';
    
    grid.innerHTML = table;
    
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
            const defaultStartTime = minutesToTime(parseInt(cell.dataset.timeMin, 10));
            
            // --- This is the PROMPT logic you requested ---
            let isSchedulable = tileData.type === 'slot';
            let eventName = tileData.name;
            
            if (tileData.type === 'custom') {
                eventName = prompt("Enter the name for this custom event (e.g., 'Snacks'):");
                if (!eventName) return; // User cancelled
                
                if (confirm("Does this event require scheduling (like 'General Activity')?\n\n- OK = Yes (it's a 'Slot' to be filled)\n- Cancel = No (it's a 'Pinned' event like 'Snacks')")) {
                    isSchedulable = true;
                } else {
                    isSchedulable = false;
                }
            } else if (tileData.type !== 'slot') {
                 isSchedulable = false; // Leagues, Swim, Lunch are Pinned
                 eventName = tileData.name; // Use the tile name
            } else {
                eventName = 'General Activity Slot'; // 'slot' becomes 'General Activity'
            }

            const startTime = prompt(`Add "${eventName}" for ${divName}?\n\nEnter Start Time:`, defaultStartTime);
            if (!startTime) return; // User cancelled
            
            const endTime = prompt(`Enter End Time:`);
            if (!endTime) return;
            
            const newEvent = {
                id: `evt_${Math.random().toString(36).slice(2, 9)}`,
                type: isSchedulable ? 'slot' : 'pinned',
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
 * Renders a single event tile (for staggered view)
 */
function renderEventTile(event) {
    const tile = TILES.find(t => t.name === event.event) || TILES.find(t => t.type === 'custom');
    const style = tile ? tile.style : 'background: #eee; border: 1px solid #616161;';
    
    return `
        <div class="grid-event" data-event-id="${event.id}" style="${style}; padding: 5px; border-radius: 4px; text-align: center; margin: 2px; font-size: 0.9em;">
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
