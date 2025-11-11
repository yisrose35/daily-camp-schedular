// =================================================================
// app1.js
//
// FINAL VERIFIED VERSION
// - **CRITICAL FIX:** Corrected all syntax errors (missing/extra braces).
// - **INIT FUNCTION:** `window.initApp1` is correctly defined and exported.
// - **Global Times:** Includes logic for "Global Camp Times" with
//   "Update" button and validation. Defaults to "" for placeholders.
// - **Global Sports:** Includes `getAllGlobalSports` and `addGlobalSport`.
// - **Skeleton Management:** Includes `getSavedSkeletons`, `saveSkeleton`,
//   `deleteSkeleton`, `getSkeletonAssignments`, `saveSkeletonAssignments`.
// - **Cleaned:** Removed all traces of the old `division.timeline`.
// =================================================================

(function() {
'use strict';

// -------------------- State --------------------
let bunks = [];
let divisions = {}; // { divName:{ bunks:[], color } }

let availableDivisions = [];
let selectedDivision = null;

// NEW: Global time settings default to empty
let globalStartTime = "";
let globalEndTime = "";

// NEW: Master list of all sports
let allSports = [];
// NEW: User-defined default sports list
const defaultSports = [
    "Baseball", "Basketball", "Football", "Hockey", "Kickball", 
    "Lacrosse", "Newcomb", "Punchball", "Soccer", "Volleyball"
];

// NEW: Skeleton template management
let savedSkeletons = {};
let skeletonAssignments = {}; // { "Monday": "templateName", "Default": "templateName" }


const defaultColors = ['#4CAF50','#2196F3','#E91E63','#FF9800','#9C27B0','#00BCD4','#FFC107','#F44336','#8BC34A','#3F51B5'];
let colorIndex = 0;

// Expose internal variable to the window for use by other modules
window.divisions = divisions;
window.availableDivisions = availableDivisions;

// -------------------- Helpers --------------------
function makeEditable(el, save) {
    el.ondblclick = e => {
        e.stopPropagation();
        const old = el.textContent;
        const input = document.createElement("input");
        input.type = "text"; input.value = old;
        el.replaceWith(input); input.focus();
        function done() {
            const val = input.value.trim();
            if (val && val !== old) save(val);
            el.textContent = val || old; input.replaceWith(el);
        }
        input.onblur = done; input.onkeyup = e => { if (e.key === "Enter") done(); };
    };
}

function uid() {
    return `id_${Math.random().toString(36).slice(2, 9)}`;
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
        if (hh === 12) hh = mer === "am" ? 0 : 12; // 12am -> 0, 12pm -> 12
        else if (mer === "pm") hh += 12; // 1pm -> 13
    }
    return hh * 60 + mm;
}

// -------------------- Bunks --------------------
function addBunk() {
    const i = document.getElementById("bunkInput");
    const name = i.value.trim();
    if (!name) return;
    const exists = bunks.some(b => b.toLowerCase() === name.toLowerCase());
    if (exists) {
        console.error("That bunk already exists!");
        i.value = "";
        return;
    }
    bunks.push(name);
    saveData();
    i.value = "";
    updateUnassigned();
    window.updateTable?.();
}

function updateUnassigned() {
    const c = document.getElementById("unassignedBunks");
    if (!c) return; // Failsafe
    c.innerHTML = "";
    bunks.forEach(b => {
        const span = document.createElement("span");
        span.textContent = b;
        span.className = "bunk-button";
        let assigned = null;
        for (const d in divisions) { if (divisions[d].bunks.includes(b)) assigned = d; }
        if (assigned) { span.style.backgroundColor = divisions[assigned].color; span.style.color = "#fff"; }
        span.onclick = () => {
            if (selectedDivision && (!assigned || assigned !== selectedDivision)) {
                for (const d in divisions) {
                    const i = divisions[d].bunks.indexOf(b);
                    if (i !== -1) divisions[d].bunks.splice(i, 1);
                }
                divisions[selectedDivision].bunks.push(b);
                saveData();
                updateUnassigned();
                window.updateTable?.();
            } else if (!selectedDivision) {
                console.error("Select a division first!");
            }
        };
        makeEditable(span, newName => {
            if (!newName.trim()) return;
            const idx = bunks.indexOf(b);
            if (idx !== -1) bunks[idx] = newName;
            for (const d of Object.values(divisions)) {
                const i = d.bunks.indexOf(b);
                if (i !== -1) d.bunks[i] = newName;
            }

            if (window.scheduleAssignments && window.scheduleAssignments[b]) {
                window.scheduleAssignments[newName] = window.scheduleAssignments[b];
                delete window.scheduleAssignments[b];
                window.saveCurrentDailyData?.("scheduleAssignments", window.scheduleAssignments);
            }
            saveData();
            updateUnassigned();
            window.updateTable?.();
        });
        c.appendChild(span);
    });
}

// -------------------- Divisions --------------------
function addDivision() {
    const i = document.getElementById("divisionInput");
    if (i.value.trim() === "") return;
    const name = i.value.trim();
    if (!availableDivisions.includes(name)) {
        const color = defaultColors[colorIndex % defaultColors.length]; colorIndex++;

        availableDivisions.push(name);
        window.availableDivisions = availableDivisions; // Update global

        divisions[name] = { 
            bunks: [], 
            color
        };
        
        window.divisions = divisions; // keep global in sync

        i.value = "";
        saveData();
        setupDivisionButtons();
        window.initLeaguesTab?.(); 
        window.updateTable?.();
    }
}

function setupDivisionButtons() {
    const cont = document.getElementById("divisionButtons"); 
    if (!cont) return; // Failsafe
    cont.innerHTML = "";
    
    const colorEnabledEl = document.getElementById("enableColor");
    const colorEnabled = colorEnabledEl ? colorEnabledEl.checked : true;
    
    availableDivisions.forEach(name => {
        const obj = divisions[name];

        if (!obj) {
            console.warn(`Data mismatch: Division "${name}" exists in availableDivisions but not in divisions object. Skipping.`);
            return;
        }

        const wrap = document.createElement("div"); wrap.className = "divisionWrapper";
        const span = document.createElement("span"); span.textContent = name; span.className = "bunk-button";
        span.style.backgroundColor = colorEnabled ? obj.color : "transparent";
        span.style.color = colorEnabled ? "#fff" : "inherit";
        span.onclick = () => {
            selectedDivision = name;
            cont.querySelectorAll('span.bunk-button').forEach(el => el.classList.remove("selected"));
            span.classList.add("selected");
            saveData(); // Save selectedDivision
        };
        if (selectedDivision === name) span.classList.add("selected");

        makeEditable(span, newName => {
            divisions[newName] = divisions[name];
            delete divisions[name];
            window.divisions = divisions; 
            
            availableDivisions[availableDivisions.indexOf(name)] = newName;
            window.availableDivisions = availableDivisions;

            if (selectedDivision === name) selectedDivision = newName;
            saveData();
            setupDivisionButtons();
            window.initLeaguesTab?.();
            window.updateTable?.();
        });
        wrap.appendChild(span);
        const col = document.createElement("input"); col.type = "color";
        col.value = obj.color; col.className = "colorPicker";
        col.oninput = e => {
            obj.color = e.target.value;
            if (colorEnabled) { span.style.backgroundColor = e.target.value; span.style.color = "#fff"; }
            saveData();
            window.updateTable?.();
        };
        wrap.appendChild(col);
        cont.appendChild(wrap);
    });
    
}
// Hook up the color checkbox
const enableColorEl = document.getElementById("enableColor");
if (enableColorEl) {
    enableColorEl.addEventListener("change", setupDivisionButtons);
}


// -------------------- Local Storage (UPDATED) --------------------
function saveData() {
    const data = { 
        bunks, 
        divisions, 
        availableDivisions, 
        selectedDivision,
        globalStartTime, // NEW
        globalEndTime,   // NEW
        allSports, // NEW
        savedSkeletons, // NEW
        skeletonAssignments // NEW
    };
    window.saveGlobalSettings?.("app1", data);
}

function loadData() {
    const data = window.loadGlobalSettings?.().app1 || {};
    try {
        bunks = data.bunks || [];
        divisions = data.divisions || {};

        availableDivisions = (data.availableDivisions && Array.isArray(data.availableDivisions))
            ? data.availableDivisions.slice()
            : Object.keys(divisions);
        
        window.divisions = divisions;
        window.availableDivisions = availableDivisions;
        selectedDivision = data.selectedDivision || null;
        
        // NEW: Load global times, defaulting to empty strings
        globalStartTime = data.globalStartTime || "";
        globalEndTime = data.globalEndTime || "";
        
        // NEW: Load master sports list
        if (data.allSports && Array.isArray(data.allSports)) {
            allSports = data.allSports;
        } else {
            // Not saved yet, initialize with defaults
            allSports = [...defaultSports];
        }
        
        // NEW: Load skeleton data
        savedSkeletons = data.savedSkeletons || {};
        skeletonAssignments = data.skeletonAssignments || {};
        
    } catch (e) { console.error("Error loading data:", e); }
}

// -------------------- Init --------------------
function initApp1() {
    // --- BUNK LISTENERS ---
    const addBunkBtn = document.getElementById("addBunkBtn");
    if (addBunkBtn) addBunkBtn.onclick = addBunk;
    const bunkInput = document.getElementById("bunkInput");
    if (bunkInput) bunkInput.addEventListener("keyup", e => { if (e.key === "Enter") addBunk(); });
    
    // --- DIVISION LISTENERS ---
    const addDivisionBtn = document.getElementById("addDivisionBtn");
    if (addDivisionBtn) addDivisionBtn.onclick = addDivision;
    const divisionInput = document.getElementById("divisionInput");
    if (divisionInput) divisionInput.addEventListener("keyup", e => { if (e.key === "Enter") addDivision(); });

    // Load all data
    loadData();
    
    // --- UPDATED: GLOBAL TIME LISTENERS ---
    const globalStartInput = document.getElementById("globalStartTime");
    const globalEndInput = document.getElementById("globalEndTime");
    const updateTimeBtn = document.getElementById("updateGlobalTimeBtn");
    
    // Set the .value to the loaded data. If it's "", the placeholder will show.
    if (globalStartInput) globalStartInput.value = globalStartTime;
    if (globalEndInput) globalEndInput.value = globalEndTime;

    if (updateTimeBtn) {
        updateTimeBtn.onclick = () => {
            const newStart = globalStartInput.value;
            const newEnd = globalEndInput.value;
            
            // Validation
            const startMin = parseTimeToMinutes(newStart);
            const endMin = parseTimeToMinutes(newEnd);
            
            if (startMin == null || endMin == null) {
                alert("Error: Invalid time format. Please use a format like '9:00 AM' or '2:30 PM'.");
                return;
            }
            
            if (endMin <= startMin) {
                alert("Error: End time must be after start time.");
                return;
            }

            // Save the valid times
            globalStartTime = newStart;
            globalEndTime = newEnd;
            saveData();
            
            alert("Global times updated!");

            // Force re-render of the active scheduler grid
            if (document.getElementById('master-scheduler')?.classList.contains('active')) {
                window.initMasterScheduler?.();
            } else if (document.getElementById('daily-adjustments')?.classList.contains('active')) { // <-- UPDATED
                window.initDailyAdjustments?.(); // <-- UPDATED
            }
        };
    }
    
    // Render all UI components
    updateUnassigned();
    setupDivisionButtons();
}
window.initApp1 = initApp1;


// Expose internal objects
window.getDivisions = () => divisions;

// --- NEW GLOBAL SPORT FUNCTIONS ---
/**
 * Returns a sorted list of all known sports.
 * @returns {string[]}
 */
window.getAllGlobalSports = function() {
    return (allSports || []).slice().sort();
}

/**
 * Adds a new sport to the master list if it doesn't exist.
 * @param {string} sportName
 */
window.addGlobalSport = function(sportName) {
    if (!sportName) return;
    const s = sportName.trim();
    if (s && !allSports.find(sport => sport.toLowerCase() === s.toLowerCase())) {
        allSports.push(s);
        saveData(); // Save the updated app1 data
    }
}

// --- NEW SKELETON MANAGEMENT FUNCTIONS ---
window.getSavedSkeletons = function() {
    return savedSkeletons || {};
}
window.saveSkeleton = function(name, skeletonData) {
    if (!name || !skeletonData) return;
    savedSkeletons[name] = skeletonData;
    saveData();
}
window.deleteSkeleton = function(name) {
    if (!name) return;
    delete savedSkeletons[name];
    // Also remove from assignments
    Object.keys(skeletonAssignments).forEach(day => {
        if (skeletonAssignments[day] === name) {
            delete skeletonAssignments[day];
        }
    });
    saveData();
}
window.getSkeletonAssignments = function() {
    return skeletonAssignments || {};
}
window.saveSkeletonAssignments = function(assignments) {
    if (!assignments) return;
    skeletonAssignments = assignments;
    saveData();
}

})();
