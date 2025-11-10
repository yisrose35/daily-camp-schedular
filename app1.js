// =================================================================
// app1.js
//
// UPDATED:
// - **CRITICAL FIX (Syntax Error)**: Fixed the `Unexpected token '}'`
//   error by adding the correct `})();` at the very end of the file.
// - **CRITICAL FIX (Init)**: Restored the button/input listeners
//   inside `initApp1` so that "Add Bunk" and "Add Division"
//   buttons work again.
// - **REMOVED** all functions and variables related to "Fields" and
//   "Special Activities". This logic now lives in the new
//   `fields.js` and `special_activities.js` files.
// - Updated `saveData` and `loadData` to no longer handle
//   fields or specialActivities.
// - **REMOVED** `renderDivisionTimelineEditor` function and all
//   logic related to `division.timeline` as requested.
// =================================================================

(function() {
'use strict';

// -------------------- State --------------------
let bunks = [];
let divisions = {}; // { divName:{ bunks:[], color } }

let availableDivisions = [];
let selectedDivision = null;

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
            // timeline object removed
        };
        
        window.divisions = divisions; // keep global in sync

        i.value = "";
        saveData();
        setupDivisionButtons();
        window.initLeaguesTab?.(); 
        window.updateTable?.();
        // renderDivisionTimelineEditor call removed
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
            // renderDivisionTimelineEditor call removed
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
            // renderDivisionTimelineEditor call removed
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
    
    // renderDivisionTimelineEditor call removed
}
// Hook up the color checkbox
const enableColorEl = document.getElementById("enableColor");
if (enableColorEl) {
    enableColorEl.addEventListener("change", setupDivisionButtons);
}

// -------------------- Division Timeline Editor (REMOVED) --------------------
// renderDivisionTimelineEditor function has been deleted.

// -------------------- Fields / Specials (ALL REMOVED) --------------------
// All logic moved to fields.js and special_activities.js
// -----------------------------------------------------------------------


// -------------------- Local Storage (UPDATED) --------------------
function saveData() {
    const data = { 
        bunks, 
        divisions, 
        availableDivisions, 
        selectedDivision, 
        // fields and specialActivities are GONE
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
        
        // Removed all timeline loading logic
        
        window.divisions = divisions;
        window.availableDivisions = availableDivisions;
        selectedDivision = data.selectedDivision || null;
        
    } catch (e) { console.error("Error loading data:", e); }
}

// -------------------- Init --------------------
function initApp1() {
    // --- RESTORED BUNK LISTENERS ---
    const addBunkBtn = document.getElementById("addBunkBtn");
    if (addBunkBtn) addBunkBtn.onclick = addBunk;
    const bunkInput = document.getElementById("bunkInput");
    if (bunkInput) bunkInput.addEventListener("keyup", e => { if (e.key === "Enter") addBunk(); });
    
    // --- RESTORED DIVISION LISTENERS ---
    const addDivisionBtn = document.getElementById("addDivisionBtn");
    if (addDivisionBtn) addDivisionBtn.onclick = addDivision;
    const divisionInput = document.getElementById("divisionInput");
    if (divisionInput) divisionInput.addEventListener("keyup", e => { if (e.key === "Enter") addDivision(); });

    // Load all data
    loadData();
    
    // Render all UI components
    updateUnassigned();
    setupDivisionButtons();
}
window.initApp1 = initApp1;


// Expose internal objects
window.getDivisions = () => divisions;

})();
