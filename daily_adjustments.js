
// =================================================================
// daily_adjustments.js  (UPDATED for CAPACITY FIX)
// - Disabled "applySmartTileOverridesForToday" pre-processing.
// - Smart Tiles are now passed to the Core Optimizer (scheduler_logic_core.js).
// - This ensures Global Capacity (Max 2 per field) is respected across divisions.
// =================================================================

(function() {
'use strict';

let container = null;
let masterSettings = {};
let currentOverrides = {
  dailyFieldAvailability: {},
  leagues: [],
  disabledSpecialtyLeagues: [],
  dailyDisabledSportsByField: {},
  disabledFields: [],
  disabledSpecials: [],
  bunkActivityOverrides: []
};

// --- Smart Tile history (cross-day fairness) ---
let smartTileHistory = null;
const SMART_TILE_HISTORY_KEY = "smartTileHistory_v1";

function loadSmartTileHistory() {
  try {
    if (!window.localStorage) return { byBunk: {} };
    const raw = localStorage.getItem(SMART_TILE_HISTORY_KEY);
    if (!raw) return { byBunk: {} };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { byBunk: {} };
    if (!parsed.byBunk) parsed.byBunk = {};
    return parsed;
  } catch (e) {
    console.warn("Daily Adjustments: Failed to load smartTileHistory", e);
    return { byBunk: {} };
  }
}

function saveSmartTileHistory(history) {
  try {
    if (!window.localStorage) return;
    const toSave = history && typeof history === "object" ? history : { byBunk: {} };
    localStorage.setItem(SMART_TILE_HISTORY_KEY, JSON.stringify(toSave));
  } catch (e) {
    console.warn("Daily Adjustments: Failed to save smartTileHistory", e);
  }
}

// --- Helper containers ---
let skeletonContainer = null;
let tripsFormContainer = null;
let bunkOverridesContainer = null;
let resourceOverridesContainer = null;

// Keep track of which sub-tab is active
let activeSubTab = 'skeleton';

// =================================================================
// ===== START: SKELETON EDITOR LOGIC =====
// =================================================================

let dailyOverrideSkeleton = [];
const PIXELS_PER_MINUTE = 2;
const INCREMENT_MINS = 30;

// --- Tile Definitions (MATCH master_schedule_builder.js) ---
const TILES = [
  { type: 'activity', name: 'Activity', style: 'background:#e0f7fa;border:1px solid #007bff;', description: 'Flexible slot (Sport or Special).' },
  { type: 'sports', name: 'Sports', style: 'background:#dcedc8;border:1px solid #689f38;', description: 'Sports slot only.' },
  { type: 'special', name: 'Special Activity', style: 'background:#e8f5e9;border:1px solid #43a047;', description: 'Special Activity slot only.' },

  // NEW SMART TILE (same as master schedule)
  { type:'smart', name:'Smart Tile', style:'background:#e3f2fd;border:2px dashed #0288d1;color:#01579b;', description:'Balances 2 activities with a fallback (e.g. Special full? -> Sports).' },

  { type: 'split', name: 'Split Activity', style: 'background:#fff3e0;border:1px solid #f57c00;', description: 'Two activities share the block.' },
  { type: 'league', name: 'League Game', style: 'background:#d1c4e9;border:1px solid #5e35b1;', description: 'Regular League slot.' },
  { type: 'specialty_league', name: 'Specialty League', style: 'background:#fff8e1;border:1px solid #f9a825;', description: 'Specialty League slot.' },
  { type: 'swim', name: 'Swim', style: 'background:#bbdefb;border:1px solid #1976d2;', description: 'Pinned.' },
  { type: 'lunch', name: 'Lunch', style: 'background:#fbe9e7;border:1px solid #d84315;', description: 'Pinned.' },
  { type: 'snacks', name: 'Snacks', style: 'background:#fff9c4;border:1px solid #fbc02d;', description: 'Pinned.' },
  { type: 'dismissal', name: 'Dismissal', style: 'background:#f44336;color:white;border:1px solid #b71c1c;', description: 'Pinned.' },
  { type: 'custom', name: 'Custom Pinned Event', style: 'background:#eee;border:1px solid #616161;', description: 'Pinned custom (e.g., Regroup).' }
];

function mapEventNameForOptimizer(name) {
  if (!name) name = "Free";
  const lowerName = name.toLowerCase().trim();
  if (lowerName === 'activity')          return { type: 'slot',   event: 'General Activity Slot' };
  if (lowerName === 'sports')           return { type: 'slot',   event: 'Sports Slot' };
  if (lowerName === 'special activity' ||
      lowerName === 'special')          return { type: 'slot',   event: 'Special Activity' };
  if (['swim','lunch','snacks','dismissal'].includes(lowerName))
                                        return { type: 'pinned', event: name };
  return { type: 'pinned', event: name };
}

function renderPalette(paletteContainer) {
  paletteContainer.innerHTML = '<span style="font-weight:600;align-self:center;">Drag tiles onto the grid:</span>';
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

  let earliestMin = null;
  let latestMin = null;
  Object.values(divisions).forEach(div => {
    const s = parseTimeToMinutes(div.startTime);
    const e = parseTimeToMinutes(div.endTime);
    if (s !== null && (earliestMin === null || s < earliestMin)) earliestMin = s;
    if (e !== null && (latestMin === null || e > latestMin)) latestMin = e;
  });
  if (earliestMin === null) earliestMin = 540; // 9:00
  if (latestMin === null) latestMin = 960;     // 4:00

  const latestPinnedEnd = Math.max(
    -Infinity,
    ...dailyOverrideSkeleton
      .filter(ev => ev && ev.type === 'pinned')
      .map(ev => parseTimeToMinutes(ev.endTime) ?? -Infinity)
  );
  if (Number.isFinite(latestPinnedEnd)) latestMin = Math.max(latestMin, latestPinnedEnd);
  if (latestMin <= earliestMin) latestMin = earliestMin + 60;

  const totalMinutes = latestMin - earliestMin;
  const totalHeight = totalMinutes * PIXELS_PER_MINUTE;

  let gridHtml = `<div style="display:grid;grid-template-columns:60px repeat(${availableDivisions.length},1fr);position:relative;">`;
  gridHtml += `<div style="grid-row:1;position:sticky;top:0;background:#fff;z-index:10;border-bottom:1px solid #999;padding:8px;">Time</div>`;

  availableDivisions.forEach((divName, i) => {
    gridHtml += `
      <div style="
        grid-row:1;
        grid-column:${i + 2};
        position:sticky;
        top:0;
        background:${divisions[divName]?.color || '#333'};
        color:#fff;
        z-index:10;
        border-bottom:1px solid #999;
        padding:8px;
        text-align:center;
      ">${divName}</div>`;
  });

  // Time column
  gridHtml += `<div style="grid-row:2;grid-column:1;height:${totalHeight}px;position:relative;background:#f9f9f9;border-right:1px solid #ccc;">`;
  for (let min = earliestMin; min < latestMin; min += INCREMENT_MINS) {
    const top = (min - earliestMin) * PIXELS_PER_MINUTE;
    gridHtml += `
      <div style="
        position:absolute;
        top:${top}px;
        left:0;
        width:100%;
        height:${INCREMENT_MINS * PIXELS_PER_MINUTE}px;
        border-bottom:1px dashed #ddd;
        box-sizing:border-box;
        font-size:10px;
        padding:2px;
        color:#777;
      ">${minutesToTime(min)}</div>`;
  }
  gridHtml += `</div>`;

  // Division columns
  availableDivisions.forEach((divName, i) => {
    const div = divisions[divName];
    const divStartMin = parseTimeToMinutes(div?.startTime);
    const divEndMin = parseTimeToMinutes(div?.endTime);

    gridHtml += `
      <div class="grid-cell"
           data-div="${divName}"
           data-start-min="${earliestMin}"
           style="grid-row:2;grid-column:${i + 2};position:relative;height:${totalHeight}px;border-right:1px solid #ccc;">`;

    if (divStartMin !== null && divStartMin > earliestMin) {
      const greyHeight = (divStartMin - earliestMin) * PIXELS_PER_MINUTE;
      gridHtml += `<div class="grid-disabled" style="top:0;height:${greyHeight}px;"></div>`;
    }
    if (divEndMin !== null && divEndMin < latestMin) {
      const greyTop = (divEndMin - earliestMin) * PIXELS_PER_MINUTE;
      const greyHeight = (latestMin - divEndMin) * PIXELS_PER_MINUTE;
      gridHtml += `<div class="grid-disabled" style="top:${greyTop}px;height:${greyHeight}px;"></div>`;
    }

    dailyOverrideSkeleton
      .filter(ev => ev.division === divName)
      .forEach(event => {
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
    cell.ondragover = (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      cell.style.backgroundColor = '#e0ffe0';
    };
    cell.ondragleave = () => { cell.style.backgroundColor = ''; };
    cell.ondrop = (e) => {
      e.preventDefault();
      cell.style.backgroundColor = '';

      const tileData = JSON.parse(e.dataTransfer.getData('application/json'));
      const divName = cell.dataset.div;
      const div = window.divisions[divName] || {};
      const divStartMin = parseTimeToMinutes(div.startTime);
      const divEndMin = parseTimeToMinutes(div.endTime);

      const rect = cell.getBoundingClientRect();
      const scrollTop = cell.closest('#daily-skeleton-grid')?.scrollTop || 0;
      const y = e.clientY - rect.top + scrollTop;
      const droppedMin = Math.round(y / PIXELS_PER_MINUTE / 15) * 15;
      const earliestMin = parseInt(cell.dataset.startMin, 10);
      const defaultStartTime = minutesToTime(earliestMin + droppedMin);

      let eventType = 'slot';
      let eventName = tileData.name;
      let newEvent = null;

      const validateTime = (timeStr, isStartTime) => {
        const timeMin = parseTimeToMinutes(timeStr);
        if (timeMin === null) {
          alert("Invalid time format. Please use '9:00am' or '2:30pm'.");
          return null;
        }
        if (divStartMin !== null && timeMin < divStartMin) {
          alert(`Error: ${timeStr} is before this division's start time of ${div.startTime}.`);
          return null;
        }
        if (divEndMin !== null && (isStartTime ? timeMin >= divEndMin : timeMin > divEndMin)) {
          alert(`Error: ${timeStr} is after this division's end time of ${div.endTime}.`);
          return null;
        }
        return timeMin;
      };

      // --- Split Tile ---
      if (tileData.type === 'split') {
        let startTime, endTime, startMin, endMin;
        while (true) {
          startTime = prompt(`Enter Start Time for the *full* block:`, defaultStartTime);
          if (!startTime) return;
          startMin = validateTime(startTime, true);
          if (startMin !== null) break;
        }
        while (true) {
          endTime = prompt(`Enter End Time for the *full* block:`);
          if (!endTime) return;
          endMin = validateTime(endTime, false);
          if (endMin !== null) {
            if (endMin <= startMin) alert("End time must be after start time.");
            else break;
          }
        }
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
          subEvents: [event1, event2]
        };

      // --- SMART TILE (matches master schedule Smart Tile logic) ---
      } else if (tileData.type === 'smart') {
        let startTime, endTime, startMin, endMin;

        while (true) {
          startTime = prompt(
            `Smart Tile for ${divName}.\n\nEnter Start Time:`,
            defaultStartTime
          );
          if (!startTime) return;
          startMin = validateTime(startTime, true);
          if (startMin !== null) break;
        }

        while (true) {
          endTime = prompt(`Enter End Time:`);
          if (!endTime) return;
          endMin = validateTime(endTime, false);
          if (endMin !== null) {
            if (endMin <= startMin) alert("End time must be after start time.");
            else break;
          }
        }

        // --- Ask for Main 1 + Main 2 ---
        const rawMains = prompt(
          "Enter the TWO MAIN activities (e.g., Swim / Special):"
        );
        if (!rawMains) return;

        const mains = rawMains
          .split(/,|\//)
          .map(s => s.trim())
          .filter(Boolean);

        if (mains.length < 2) {
          alert("Please enter TWO distinct activities.");
          return;
        }

        const [main1, main2] = mains;

        // --- Ask which activity has fallback ---
        const pick = prompt(
          `Which activity requires a fallback?\n\n1: ${main1}\n2: ${main2}`
        );
        if (!pick) return;

        let fallbackFor;
        if (pick.trim() === "1" || pick.trim().toLowerCase() === main1.toLowerCase()) {
          fallbackFor = main1;
        } else if (pick.trim() === "2" || pick.trim().toLowerCase() === main2.toLowerCase()) {
          fallbackFor = main2;
        } else {
          alert("Invalid choice.");
          return;
        }

        // --- Fallback Activity ---
        const fallbackActivity = prompt(
          `If "${fallbackFor}" is unavailable, what should be played?\nExample: Sports`
        );
        if (!fallbackActivity) return;

        // --- Create Event EXACTLY Like Master Builder ---
        newEvent = {
          id: `evt_${Math.random().toString(36).slice(2, 9)}`,
          type: "smart",
          event: `${main1} / ${main2}`,
          division: divName,
          startTime,
          endTime,
          smartData: {
            main1,
            main2,
            fallbackFor,
            fallbackActivity
          }
        };

      // --- Pinned tiles ---
      } else if (['lunch','snacks','custom','dismissal','swim'].includes(tileData.type)) {
        eventType = 'pinned';
        if (tileData.type === 'custom') {
          eventName = prompt("Enter the name for this custom pinned event (e.g., 'Regroup' or 'Assembly'):");
          if (!eventName) return;
        } else {
          eventName = tileData.name;
        }
      }

      // Standard single-event fallback (Activity / Sports / Special / generic slot)
      if (!newEvent) {
        let startTime, endTime, startMin, endMin;

        if (tileData.type === 'activity') eventName = 'General Activity Slot';
        else if (tileData.type === 'sports') eventName = 'Sports Slot';
        else if (tileData.type === 'special') eventName = 'Special Activity';

        while (true) {
          startTime = prompt(`Add "${eventName}" for ${divName}?\nEnter Start Time:`, defaultStartTime);
          if (!startTime) return;
          startMin = validateTime(startTime, true);
          if (startMin !== null) break;
        }
        while (true) {
          endTime = prompt(`Enter End Time:`);
          if (!endTime) return;
          endMin = validateTime(endTime, false);
          if (endMin !== null) {
            if (endMin <= startMin) alert("End time must be after start time.");
            else break;
          }
        }

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
      saveDailySkeleton();
      renderGrid(gridContainer);
    };
  });
}

function addRemoveListeners(gridContainer) {
  gridContainer.querySelectorAll('.grid-event').forEach(tile => {
    tile.onclick = (e) => {
      e.stopPropagation();
      const eventId = tile.dataset.eventId;
      if (!eventId) return;
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
    if (event.type === 'split')        tile = TILES.find(t => t.type === 'split');
    else if (event.type === 'smart')   tile = TILES.find(t => t.type === 'smart');
    else if (event.event === 'General Activity Slot') tile = TILES.find(t => t.type === 'activity');
    else if (event.event === 'Sports Slot')           tile = TILES.find(t => t.type === 'sports');
    else if (event.event === 'Special Activity')      tile = TILES.find(t => t.type === 'special');
    else if (event.event === 'Dismissal')             tile = TILES.find(t => t.type === 'dismissal');
    else                                              tile = TILES.find(t => t.type === 'custom');
  }
  const style = tile ? tile.style : 'background:#eee;border:1px solid #616161;';
  let tripStyle = '';

  if (event.type === 'pinned' && tile && tile.type === 'custom') {
    tripStyle = 'background:#455a64;color:white;border:1px solid #000;';
  }

  let innerHtml = `<strong>${event.event}</strong><br><div style="font-size:.85em;">${event.startTime} - ${event.endTime}</div>`;
  if (event.type === 'smart' && event.smartData) {
    innerHtml += `<div style="font-size:0.75em;border-top:1px dotted #01579b;margin-top:2px;padding-top:1px;">F: ${event.smartData.fallbackActivity} (if ${event.smartData.fallbackFor.substring(0,4)}. busy)</div>`;
  }
  if (event.type === "smart" && event.smartData) {
  innerHtml += `
    <div style="font-size:0.75em;border-top:1px dotted #01579b;margin-top:2px;padding-top:1px;">
      Fallback: ${event.smartData.fallbackActivity}
      <br>

      For: ${event.smartData.fallbackFor}
    </div>
  `;
}


  return `
    <div class="grid-event"
         data-event-id="${event.id}"
         title="Click to remove this event"
         style="${tripStyle || style};padding:2px 5px;border-radius:4px;text-align:center;
                margin:0 1px;font-size:.9em;position:absolute;
                top:${top}px;height:${height}px;width:calc(100% - 4px);
                box-sizing:border-box;overflow:hidden;cursor:pointer;">
      ${innerHtml}
    </div>`;
}

function loadDailySkeleton() {
  const dailyData = window.loadCurrentDailyData?.() || {};
  if (dailyData.manualSkeleton && dailyData.manualSkeleton.length > 0) {
    dailyOverrideSkeleton = JSON.parse(JSON.stringify(dailyData.manualSkeleton));
    return;
  }

  const assignments = masterSettings.app1.skeletonAssignments || {};
  const skeletons   = masterSettings.app1.savedSkeletons || {};
  const dateStr = window.currentScheduleDate || "";
  const [year, month, day] = dateStr.split('-').map(Number);
  let dayOfWeek = 0;
  if (year && month && day) dayOfWeek = new Date(year, month - 1, day).getDay();
  const dayNames = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const todayName = dayNames[dayOfWeek];

  let templateName = assignments[todayName];
  if (!templateName || !skeletons[templateName]) templateName = assignments["Default"];
  const skeletonToLoad = skeletons[templateName];
  dailyOverrideSkeleton = skeletonToLoad ? JSON.parse(JSON.stringify(skeletonToLoad)) : [];
}

function saveDailySkeleton() {
  window.saveCurrentDailyData?.("manualSkeleton", dailyOverrideSkeleton);
}

function minutesToTime(min) {
  const hh = Math.floor(min / 60);
  const mm = min % 60;
  const h = hh % 12 === 0 ? 12 : hh % 12;
  const m = String(mm).padStart(2, '0');
  const ampm = hh < 12 ? 'am' : 'pm';
  return `${h}:${m}${ampm}`;
}

// =================================================================
// SMART TILE PRE-PROCESSOR HOOK (DISABLED for Capacity Fix)
// =================================================================

function applySmartTileOverridesForToday() {
  console.log("Smart Tile pre-processor DISABLED. Using Core Scheduler for capacity-aware Smart Tiles.");
  return; // Pass-through to core optimizer
}

// =================================================================
// RUN OPTIMIZER (now with Smart Tile pre-processing DISABLED)
// =================================================================

function runOptimizer() {
  if (!window.runSkeletonOptimizer) {
    alert("Error: 'runSkeletonOptimizer' function not found. Is scheduler_logic_core.js loaded?");
    return;
  }
  if (dailyOverrideSkeleton.length === 0) {
    alert("Skeleton is empty. Please add blocks before running the optimizer.");
    return;
  }

  // Save manual skeleton first
  saveDailySkeleton();

  // NEW: Run Smart Tile pre-processor to inject bunkActivityOverrides
  try {
    applySmartTileOverridesForToday();
  } catch (e) {
    console.error("Error while applying Smart Tile overrides:", e);
  }

  // PASS LOCAL OVERRIDES (currentOverrides) to Core logic
  const success = window.runSkeletonOptimizer(dailyOverrideSkeleton, currentOverrides);
  if (success) {
    alert("Schedule Generated Successfully!");
    window.showTab?.('schedule');
  } else {
    alert("Error during schedule generation. Check console.");
  }
}

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
  } else {
    return null;
  }
  return hh * 60 + mm;
}

function uid() {
  return `id_${Math.random().toString(36).slice(2, 9)}`;
}

// =================================================================
// ===== END: SKELETON EDITOR LOGIC =====
// =================================================================


/**
 * Main entry point for the Daily Adjustments tab
 */
function init() {
  container = document.getElementById("daily-adjustments-content");
  if (!container) {
    console.error("Daily Adjustments: container not found");
    return;
  }
  console.log("Daily Adjustments: Initializing for", window.currentScheduleDate);

  // --- 1. Load all data ---
  masterSettings.global = window.loadGlobalSettings?.() || {};
  masterSettings.app1 = masterSettings.global.app1 || {};
  masterSettings.leaguesByName = masterSettings.global.leaguesByName || {};
  masterSettings.specialtyLeagues = masterSettings.global.specialtyLeagues || {};

  // Load Smart Tile history once per init
  smartTileHistory = loadSmartTileHistory();

  const dailyData = window.loadCurrentDailyData?.() || {};
  const dailyOverrides = dailyData.overrides || {};

  // Populate the 'currentOverrides' object from loaded data
  currentOverrides.dailyFieldAvailability = dailyData.dailyFieldAvailability || {};
  currentOverrides.leagues = dailyOverrides.leagues || [];
  currentOverrides.disabledSpecialtyLeagues = dailyData.disabledSpecialtyLeagues || [];
  currentOverrides.dailyDisabledSportsByField = dailyData.dailyDisabledSportsByField || {};
  currentOverrides.disabledFields = dailyOverrides.disabledFields || [];
  currentOverrides.disabledSpecials = dailyOverrides.disabledSpecials || [];
  currentOverrides.bunkActivityOverrides = dailyData.bunkActivityOverrides || [];

  // --- 2. Build the main UI (Tabs + Panes) ---
  container.innerHTML = `
    <div style="padding:10px 15px;background:#fff;border:1px solid #ddd;border-radius:8px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:center;">
      <div>
        <h2 style="margin:0 0 5px 0;">Daily Adjustments for ${window.currentScheduleDate}</h2>
        <p style="margin:0;font-size:0.9em;color:#555;">Make final changes to the day's template, adjust activities, and run the optimizer.</p>
      </div>
      <button id="run-optimizer-btn"
              style="background:#28a745;color:white;padding:12px 20px;font-size:1.2em;border:none;border-radius:5px;cursor:pointer;white-space:nowrap;">
        Run Optimizer & Create Schedule
      </button>
    </div>

    <div class="da-tabs-nav league-nav">
      <button class="tab-button active" data-tab="skeleton">Skeleton</button>
      <button class="tab-button" data-tab="trips">Trips</button>
      <button class="tab-button" data-tab="bunk-specific">Bunk Specific</button>
      <button class="tab-button" data-tab="resources">Resource Availability</button>
    </div>

    <div id="da-pane-skeleton" class="da-tab-pane league-content-pane active">
      <div class="override-section" id="daily-skeleton-editor-section">
        <h3>Daily Skeleton Override</h3>
        <p style="font-size:0.9em;color:#555;">Modify the schedule layout for <strong>this day only</strong>.</p>
        <div id="override-scheduler-content"></div>
      </div>
    </div>

    <div id="da-pane-trips" class="da-tab-pane league-content-pane">
      <div class="override-section" id="daily-trips-section">
        <h3>Daily Trips (Adds to Skeleton)</h3>
        <div id="trips-form-container"></div>
      </div>
    </div>

    <div id="da-pane-bunk-specific" class="da-tab-pane league-content-pane">
      <div class="override-section" id="daily-bunk-overrides-section">
        <h3>Bunk-Specific Pinned Activities</h3>
        <p style="font-size:0.9em;color:#555;">Assign a specific activity to one or more bunks at a specific time. This will override the skeleton.</p>
        <div id="bunk-overrides-container"></div>
      </div>
    </div>

    <div id="da-pane-resources" class="da-tab-pane league-content-pane">
      <div class="override-section" id="other-overrides-section">
        <h3>Daily Resource Availability</h3>
        <p style="font-size:0.9em;color:#555;">Disable fields, leagues, or activities for <strong>this day only</strong>.</p>
        <div id="resource-overrides-container"></div>
      </div>
    </div>

    <style>
      .grid-disabled{
        position:absolute;
        width:100%;
        background-color:#80808040;
        background-image:linear-gradient(-45deg,#0000001a 25%,transparent 25%,transparent 50%,#0000001a 50%,#0000001a 75%,transparent 75%,transparent);
        background-size:20px 20px;
        z-index:1;
        pointer-events:none;
      }
      .grid-event{z-index:2;position:relative;}
      .master-list .list-item{
        padding:10px 8px;
        border:1px solid #ddd;
        border-radius:5px;
        margin-bottom:3px;
        cursor:pointer;
        background:#fff;
        font-size:.95em;
        display:flex;
        justify-content:space-between;
        align-items:center;
      }
      .master-list .list-item:hover{background:#f9f9f9;}
      .master-list .list-item.selected{
        background:#e7f3ff;
        border-color:#007bff;
      }
      .master-list .list-item-name{
        font-weight:600;
        flex-grow:1;
      }
      .master-list .list-item.selected .list-item-name{
        font-weight:700;
      }
      .detail-pane{
        border:1px solid #ccc;
        border-radius:8px;
        padding:20px;
        background:#fdfdfd;
        min-height:300px;
      }
      .sport-override-list{
        margin-top:15px;
        padding-top:15px;
        border-top:1px solid #eee;
      }
      .sport-override-list label{
        display:block;
        margin:5px 0 5px 10px;
        font-size:1.0em;
      }
      .sport-override-list label input{
        margin-right:8px;
        vertical-align:middle;
      }
    </style>
  `;

  // --- 3. Hook up event listeners ---
  document.getElementById("run-optimizer-btn").onclick = runOptimizer;

  // Tab switching logic
  container.querySelectorAll('.da-tabs-nav .tab-button').forEach(btn => {
    btn.onclick = () => {
      activeSubTab = btn.dataset.tab;
      container.querySelectorAll('.da-tabs-nav .tab-button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      container.querySelectorAll('.da-tab-pane').forEach(p => p.classList.remove('active'));
      container.querySelector(`#da-pane-${activeSubTab}`).classList.add('active');
    };
  });

  // --- 4. Get pane containers and render content ---
  skeletonContainer = document.getElementById("override-scheduler-content");
  tripsFormContainer = document.getElementById("trips-form-container");
  bunkOverridesContainer = document.getElementById("bunk-overrides-container");
  resourceOverridesContainer = document.getElementById("resource-overrides-container");

  initDailySkeletonUI();
  renderTripsForm();
  renderBunkOverridesUI();
  renderResourceOverridesUI();
}

/**
 * Renders the UI for the "Skeleton" tab
 */
function initDailySkeletonUI() {
  if (!skeletonContainer) return;
  loadDailySkeleton();
  skeletonContainer.innerHTML = `
    <div id="daily-skeleton-palette"
         style="padding:10px;background:#f4f4f4;border-radius:8px;margin-bottom:15px;display:flex;flex-wrap:wrap;gap:10px;"></div>
    <div id="daily-skeleton-grid"
         style="overflow-x:auto;border:1px solid #999;max-height:600px;overflow-y:auto;"></div>
  `;
  const palette = document.getElementById("daily-skeleton-palette");
  const grid = document.getElementById("daily-skeleton-grid");
  renderPalette(palette);
  renderGrid(grid);
}

/**
 * Renders the UI for the "Trips" tab
 */
function renderTripsForm() {
  tripsFormContainer.innerHTML = "";

  const form = document.createElement('div');
  form.style.border = '1px solid #ccc';
  form.style.padding = '15px';
  form.style.borderRadius = '8px';

  form.innerHTML = `
    <label for="tripName" style="display:block;margin-bottom:5px;font-weight:600;">Trip Name:</label>
    <input type="text" id="tripName" placeholder="e.g., Museum Trip" style="width:250px;">

    <label for="tripStart" style="display:block;margin-top:10px;font-weight:600;">Start Time:</label>
    <input id="tripStart" placeholder="e.g., 9:00am" style="margin-right:8px;">

    <label for="tripEnd" style="display:block;margin-top:10px;font-weight:600;">End Time:</label>
    <input id="tripEnd" placeholder="e.g., 2:00pm" style="margin-right:8px;">

    <p style="margin-top:15px;font-weight:600;">Select Divisions (Trip will apply to all bunks in the division):</p>
  `;

  const divisions = masterSettings.app1.divisions || {};
  const availableDivisions = masterSettings.app1.availableDivisions || [];

  const divisionChipBox = document.createElement('div');
  divisionChipBox.className = 'chips';
  divisionChipBox.style.marginBottom = '5px';

  availableDivisions.forEach(divName => {
    const divColor = divisions[divName]?.color || '#333';
    const chip = createChip(divName, divColor, true);
    divisionChipBox.appendChild(chip);
  });
  form.appendChild(divisionChipBox);

  const addBtn = document.createElement('button');
  addBtn.textContent = 'Add Trip to Skeleton';
  addBtn.className = 'bunk-button';
  addBtn.style.background = '#007BFF';
  addBtn.style.color = 'white';
  addBtn.style.marginTop = '15px';

  addBtn.onclick = () => {
    const nameEl = form.querySelector('#tripName');
    const startEl = form.querySelector('#tripStart');
    const endEl = form.querySelector('#tripEnd');
    if (!nameEl || !startEl || !endEl) return;

    const name = nameEl.value.trim();
    const start = startEl.value;
    const end = endEl.value;
    const selectedDivisions = Array.from(
      divisionChipBox.querySelectorAll('.bunk-button.selected')
    ).map(el => el.dataset.value);

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

    loadDailySkeleton();

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
        event: name,
        division: divName,
        startTime: start,
        endTime: end
      });
    });

    saveDailySkeleton();

    const gridContainer = skeletonContainer.querySelector('#daily-skeleton-grid');
    if (gridContainer) renderGrid(gridContainer);

    nameEl.value = "";
    startEl.value = "";
    endEl.value = "";
    form.querySelectorAll('.bunk-button.selected').forEach(chip => chip.click());
  };

  form.appendChild(addBtn);
  tripsFormContainer.appendChild(form);
}

/**
 * NEW: Renders the UI for the "Bunk Specific" tab
 */
function renderBunkOverridesUI() {
  bunkOverridesContainer.innerHTML = "";

  const divisions = masterSettings.app1.divisions || {};
  const availableDivisions = masterSettings.app1.availableDivisions || [];
  const allBunksByDiv = {};
  availableDivisions.forEach(divName => {
    allBunksByDiv[divName] = (divisions[divName]?.bunks || []).sort();
  });

  const allSports = (masterSettings.app1.fields || []).flatMap(f => f.activities || []);
  const allSpecials = (masterSettings.app1.specialActivities || []).map(s => s.name);
  const allActivities = [...new Set([...allSports, ...allSpecials])].sort();

  const form = document.createElement('div');
  form.style.border = '1px solid #ccc';
  form.style.padding = '15px';
  form.style.borderRadius = '8px';
  form.style.marginBottom = '20px';

  let activityOptions = `<option value="">-- Select an Activity --</option>`;
  allActivities.forEach(act => {
    activityOptions += `<option value="${act}">${act}</option>`;
  });

  form.innerHTML = `
    <label for="bunk-override-activity" style="display:block;margin-bottom:5px;font-weight:600;">Activity:</label>
    <select id="bunk-override-activity" style="width:250px;padding:5px;font-size:1em;">${activityOptions}</select>

    <label for="bunk-override-start" style="display:block;margin-top:10px;font-weight:600;">Start Time:</label>
    <input id="bunk-override-start" placeholder="e.g., 9:00am" style="margin-right:8px;">

    <label for="bunk-override-end" style="display:block;margin-top:10px;font-weight:600;">End Time:</label>
    <input id="bunk-override-end" placeholder="e.g., 10:00am" style="margin-right:8px;">

    <p style="margin-top:15px;font-weight:600;">Select Bunks:</p>
  `;

  availableDivisions.forEach(divName => {
    const bunks = allBunksByDiv[divName];
    if (bunks.length === 0) return;

    const divLabel = document.createElement('div');
    divLabel.textContent = divName;
    divLabel.style.fontWeight = 'bold';
    divLabel.style.marginTop = '8px';
    form.appendChild(divLabel);

    const bunkChipBox = document.createElement('div');
    bunkChipBox.className = 'chips';
    bunkChipBox.style.marginBottom = '5px';
    bunks.forEach(bunkName => {
      const chip = createChip(bunkName, divisions[divName]?.color || '#ccc');
      bunkChipBox.appendChild(chip);
    });
    form.appendChild(bunkChipBox);
  });

  const addBtn = document.createElement('button');
  addBtn.textContent = 'Add Pinned Activity';
  addBtn.className = 'bunk-button';
  addBtn.style.background = '#007BFF';
  addBtn.style.color = 'white';
  addBtn.style.marginTop = '15px';

  addBtn.onclick = () => {
    const activityEl = form.querySelector('#bunk-override-activity');
    const startEl = form.querySelector('#bunk-override-start');
    const endEl = form.querySelector('#bunk-override-end');
    const selectedBunks = Array.from(
      form.querySelectorAll('.bunk-button.selected')
    ).map(el => el.dataset.value);

    const activity = activityEl.value;
    const start = startEl.value.trim();
    const end = endEl.value.trim();

    if (!activity) { alert('Please select an activity.'); return; }
    if (!start || !end) { alert('Please enter a start and end time.'); return; }
    if (selectedBunks.length === 0) { alert('Please select at least one bunk.'); return; }

    const startMin = parseTimeToMinutes(start);
    const endMin = parseTimeToMinutes(end);
    if (startMin == null || endMin == null || endMin <= startMin) {
      alert('Invalid time range. Please use formats like "9:00am" and ensure end is after start.');
      return;
    }

    const overrides = window.loadCurrentDailyData?.().bunkActivityOverrides || [];
    selectedBunks.forEach(bunk => {
      overrides.push({
        id: uid(),
        bunk: bunk,
        activity: activity,
        startTime: start,
        endTime: end
      });
    });
    window.saveCurrentDailyData("bunkActivityOverrides", overrides);
    currentOverrides.bunkActivityOverrides = overrides;

    activityEl.value = "";
    startEl.value = "";
    endEl.value = "";
    form.querySelectorAll('.bunk-button.selected').forEach(chip => chip.click());
    renderBunkOverridesUI();
  };

  form.appendChild(addBtn);
  bunkOverridesContainer.appendChild(form);

  const listContainer = document.createElement('div');
  listContainer.id = "bunk-overrides-list-container";

  const overrides = currentOverrides.bunkActivityOverrides;
  if (overrides.length === 0) {
    listContainer.innerHTML = `<p class="muted">No bunk-specific activities added yet.</p>`;
  } else {
    overrides.forEach(item => {
      const el = document.createElement('div');
      el.className = 'item';
      el.innerHTML = `
        <div style="flex-grow:1;">
          <div><strong>${item.bunk}</strong> &raquo; ${item.activity}</div>
          <div class="muted" style="font-size:0.9em;">${item.startTime} - ${item.endTime}</div>
        </div>
        <button data-id="${item.id}"
                style="padding:6px 10px;border-radius:4px;cursor:pointer;background:#c0392b;color:white;border:none;">
          Remove
        </button>
      `;
      el.querySelector('button').onclick = () => {
        let currentList = window.loadCurrentDailyData?.().bunkActivityOverrides || [];
        currentList = currentList.filter(o => o.id !== item.id);
        window.saveCurrentDailyData("bunkActivityOverrides", currentList);
        currentOverrides.bunkActivityOverrides = currentList;
        renderBunkOverridesUI();
      };
      listContainer.appendChild(el);
    });
  }
  bunkOverridesContainer.appendChild(listContainer);
}

/**
 * NEW: Renders the UI for the "Resource Availability" tab
 */
function renderResourceOverridesUI() {
  resourceOverridesContainer.innerHTML = "";

  resourceOverridesContainer.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:20px;">
      <div style="flex:1;min-width:300px;">
        <h4>Fields</h4><div id="override-fields-list" class="master-list"></div>
        <h4 style="margin-top:15px;">Special Activities</h4><div id="override-specials-list" class="master-list"></div>
        <h4 style="margin-top:15px;">Leagues</h4><div id="override-leagues-list" class="master-list"></div>
        <h4 style="margin-top:15px;">Specialty Leagues</h4><div id="override-specialty-leagues-list" class="master-list"></div>
      </div>
      <div style="flex:2;min-width:400px;position:sticky;top:20px;">
        <h4>Details</h4>
        <div id="override-detail-pane" class="detail-pane">
          <p class="muted">Select an item from the left to edit its details.</p>
        </div>
      </div>
    </div>
  `;

  const overrideFieldsListEl = document.getElementById("override-fields-list");
  const overrideSpecialsListEl = document.getElementById("override-specials-list");
  const overrideLeaguesListEl = document.getElementById("override-leagues-list");
  const overrideSpecialtyLeaguesListEl = document.getElementById("override-specialty-leagues-list");

  const saveOverrides = () => {
    const dailyData = window.loadCurrentDailyData?.() || {};
    const fullOverrides = dailyData.overrides || {};
    fullOverrides.leagues = currentOverrides.leagues;
    fullOverrides.disabledFields = currentOverrides.disabledFields;
    fullOverrides.disabledSpecials = currentOverrides.disabledSpecials;
    window.saveCurrentDailyData("overrides", fullOverrides);
  };

  const fields = masterSettings.app1.fields || [];
  if (fields.length === 0) {
    overrideFieldsListEl.innerHTML = `<p class="muted" style="font-size:0.9em;">No fields found in Setup.</p>`;
  }
  fields.forEach(item => {
    const isDisabled = currentOverrides.disabledFields.includes(item.name);
    const onToggle = (isEnabled) => {
      if (isEnabled) currentOverrides.disabledFields = currentOverrides.disabledFields.filter(name => name !== item.name);
      else if (!currentOverrides.disabledFields.includes(item.name)) currentOverrides.disabledFields.push(item.name);
      saveOverrides();
    };
    overrideFieldsListEl.appendChild(createOverrideMasterListItem('field', item.name, !isDisabled, onToggle));
  });

  const specials = masterSettings.app1.specialActivities || [];
  if (specials.length === 0) {
    overrideSpecialsListEl.innerHTML = `<p class="muted" style="font-size:0.9em;">No special activities found in Setup.</p>`;
  }
  specials.forEach(item => {
    const isDisabled = currentOverrides.disabledSpecials.includes(item.name);
    const onToggle = (isEnabled) => {
      if (isEnabled) currentOverrides.disabledSpecials = currentOverrides.disabledSpecials.filter(name => name !== item.name);
      else if (!currentOverrides.disabledSpecials.includes(item.name)) currentOverrides.disabledSpecials.push(item.name);
      saveOverrides();
    };
    overrideSpecialsListEl.appendChild(createOverrideMasterListItem('special', item.name, !isDisabled, onToggle));
  });

  const leagues = masterSettings.leaguesByName || {};
  const leagueNames = Object.keys(leagues);
  if (leagueNames.length === 0) {
    overrideLeaguesListEl.innerHTML = `<p class="muted" style="font-size:0.9em;">No leagues found in Setup.</p>`;
  }
  leagueNames.forEach(name => {
    const isDisabled = currentOverrides.leagues.includes(name);
    const onToggle = (isEnabled) => {
      if (isEnabled) currentOverrides.leagues = currentOverrides.leagues.filter(l => l !== name);
      else if (!currentOverrides.leagues.includes(name)) currentOverrides.leagues.push(name);
      saveOverrides();
    };
    overrideLeaguesListEl.appendChild(createOverrideMasterListItem('league', name, !isDisabled, onToggle));
  });

  const specialtyLeagues = masterSettings.specialtyLeagues || {};
  const specialtyLeagueNames = Object.values(specialtyLeagues).map(l => l.name).sort();
  if (specialtyLeagueNames.length === 0) {
    overrideSpecialtyLeaguesListEl.innerHTML = `<p class="muted" style="font-size:0.9em;">No specialty leagues found in Setup.</p>`;
  }
  specialtyLeagueNames.forEach(name => {
    const isDisabled = currentOverrides.disabledSpecialtyLeagues.includes(name);
    const onToggle = (isEnabled) => {
      if (isEnabled) currentOverrides.disabledSpecialtyLeagues =
        currentOverrides.disabledSpecialtyLeagues.filter(l => l !== name);
      else if (!currentOverrides.disabledSpecialtyLeagues.includes(name))
        currentOverrides.disabledSpecialtyLeagues.push(name);
      window.saveCurrentDailyData("disabledSpecialtyLeagues", currentOverrides.disabledSpecialtyLeagues);
    };
    overrideSpecialtyLeaguesListEl.appendChild(
      createOverrideMasterListItem('specialty_league', name, !isDisabled, onToggle)
    );
  });

  renderOverrideDetailPane();
}

// (Helper functions for Resource Availability)
let selectedOverrideId = null;

function createOverrideMasterListItem(type, name, isEnabled, onToggle) {
  const el = document.createElement('div');
  el.className = 'list-item';
  const id = `${type}-${name}`;
  if (id === selectedOverrideId) el.classList.add('selected');

  const nameEl = document.createElement('span');
  nameEl.className = 'list-item-name';
  nameEl.textContent = name;
  el.appendChild(nameEl);

  nameEl.onclick = () => {
    selectedOverrideId = id;
    renderResourceOverridesUI();
    renderOverrideDetailPane();
  };

  const tog = document.createElement("label");
  tog.className = "switch";
  tog.title = isEnabled ? "Click to disable for today" : "Click to enable for today";
  tog.onclick = (e) => e.stopPropagation();

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

function renderOverrideDetailPane() {
  const overrideDetailPaneEl = document.getElementById("override-detail-pane");
  if (!overrideDetailPaneEl) return;

  if (!selectedOverrideId) {
    overrideDetailPaneEl.innerHTML = `<p class="muted">Select an item from the left to edit its details.</p>`;
    return;
  }

  overrideDetailPaneEl.innerHTML = "";
  const [type, name] = selectedOverrideId.split(/-(.+)/);

  if (type === 'field' || type === 'special') {
    const item = (type === 'field')
      ? (masterSettings.app1.fields || []).find(f => f.name === name)
      : (masterSettings.app1.specialActivities || []).find(s => s.name === name);

    if (!item) {
      overrideDetailPaneEl.innerHTML = `<p style="color:red;">Error: Could not find item.</p>`;
      return;
    }

    const globalRules = item.timeRules || [];
    if (!currentOverrides.dailyFieldAvailability[name]) {
      currentOverrides.dailyFieldAvailability[name] = [];
    }
    const dailyRules = currentOverrides.dailyFieldAvailability[name];

    const onSave = () => {
      currentOverrides.dailyFieldAvailability[name] = dailyRules;
      window.saveCurrentDailyData("dailyFieldAvailability", currentOverrides.dailyFieldAvailability);
      renderOverrideDetailPane();
    };

    overrideDetailPaneEl.appendChild(
      renderTimeRulesUI(name, globalRules, dailyRules, onSave)
    );

    if (type === 'field') {
      const sportListContainer = document.createElement('div');
      sportListContainer.className = 'sport-override-list';
      sportListContainer.innerHTML = `<strong>Daily Sport Availability for ${name}</strong>`;

      const sports = item.activities || [];
      if (sports.length === 0) {
        sportListContainer.innerHTML += `<p class="muted" style="margin:5px 0 0 10px;font-size:0.9em;">No sports are assigned to this field in the "Fields" tab.</p>`;
      }

      const disabledToday = currentOverrides.dailyDisabledSportsByField[name] || [];

      sports.forEach(sport => {
        const isEnabled = !disabledToday.includes(sport);
        const el = createCheckbox(sport, isEnabled);

        el.checkbox.onchange = () => {
          let list = currentOverrides.dailyDisabledSportsByField[name] || [];
          if (el.checkbox.checked) {
            list = list.filter(s => s !== sport);
          } else {
            if (!list.includes(sport)) list.push(sport);
          }
          currentOverrides.dailyDisabledSportsByField[name] = list;
          window.saveCurrentDailyData("dailyDisabledSportsByField", currentOverrides.dailyDisabledSportsByField);
        };
        sportListContainer.appendChild(el.wrapper);
      });
      overrideDetailPaneEl.appendChild(sportListContainer);
    }

  } else if (type === 'league') {
    overrideDetailPaneEl.innerHTML = `<p class="muted">Enable or disable this league for today using the toggle in the list on the left.</p>`;
  } else if (type === 'specialty_league') {
    overrideDetailPaneEl.innerHTML = `<p class="muted">Enable or disable this league for today using the toggle in the list on the left.</p>`;
  }
}

// --- Common Helpers ---
function renderTimeRulesUI(itemName, globalRules, dailyRules, onSave) {
  const container = document.createElement("div");

  const globalContainer = document.createElement("div");
  globalContainer.innerHTML = `<strong style="font-size:0.9em;">Global Rules (from Setup):</strong>`;
  if (globalRules.length === 0) {
    globalContainer.innerHTML += `<p class="muted" style="margin:0;font-size:0.9em;">Available all day</p>`;
  }
  globalRules.forEach(rule => {
    const ruleEl = document.createElement("div");
    ruleEl.style.margin = "2px 0";
    ruleEl.style.fontSize = "0.9em";
    ruleEl.innerHTML =
      `&bull; <span style="color:${rule.type === 'Available' ? 'green' : 'red'};text-transform:capitalize;">${rule.type}</span> from ${rule.start} to ${rule.end}`;
    globalContainer.appendChild(ruleEl);
  });
  container.appendChild(globalContainer);

  const dailyContainer = document.createElement("div");
  dailyContainer.style.marginTop = "10px";
  dailyContainer.innerHTML = `<strong style="font-size:0.9em;">Daily Override Rules (replaces global rules):</strong>`;

  const ruleList = document.createElement("div");
  if (dailyRules.length === 0) {
    ruleList.innerHTML = `<p class="muted" style="margin:0;font-size:0.9em;">No daily rules. Using global rules.</p>`;
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
      alert("Invalid time format. Use '9:00am' or '2:30pm'.");
      return; }
    if (parseTimeToMinutes(start) >= parseTimeToMinutes(end)) {
      alert("End time must be after start time.");
      return;
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

function createCheckbox(name, isChecked) {
  const w = document.createElement('label');
  w.className = 'override-checkbox';
  const c = document.createElement('input');
  c.type = 'checkbox';
  c.checked = isChecked;
  const t = document.createElement('span');
  t.textContent = name;
  w.appendChild(c);
  w.appendChild(t);
  return { wrapper: w, checkbox: c };
}

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
    const sel = el.classList.toggle('selected');
    el.style.backgroundColor = sel ? color : 'white';
    el.style.color = sel ? 'white' : 'black';
    el.style.borderColor = sel ? color : defaultBorder;
  });
  return el;
}

// Expose init
window.initDailyAdjustments = init;

})();
