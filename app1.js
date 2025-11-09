// -------------------- State --------------------
let bunks = [];
let divisions = {}; // { divName:{ bunks:[], color } }

// NEW SKELETON STATE
// This replaces schedulePeriods and periodRules
let divisionSkeletons = {}; // { divName: { timeline: {start, end}, skeleton: [], shoppingList: {} } }

let availableDivisions = [];
let selectedDivision = null;

let fields = [], specialActivities = [];

const defaultColors = ['#4CAF50','#2196F3','#E91E63','#FF9800','#9C27B0','#00BCD4','#FFC107','#F44336','#8BC34A','#3F51B5'];
let colorIndex = 0;
const commonActivities = ["Basketball","Baseball","Hockey","Football","Soccer","Volleyball","Lacrosse"];

// Expose internal variable to the window for use by other modules
window.divisions = divisions;
window.availableDivisions = availableDivisions;
window.fields = fields;
window.specialActivities = specialActivities;
window.divisionSkeletons = divisionSkeletons; // Expose new skeleton state

// -------------------- Helpers --------------------
// (makeEditable, uid, parseTimeToMinutes... unchanged)
// ... (All helpers from the original file are kept, e.g., makeEditable, uid, etc.) ...
// ... (All Field/Special helper functions are also kept) ...

// -------------------- Bunks --------------------
// (addBunk, updateUnassigned functions are unchanged)
// ...

// -------------------- Divisions --------------------
// (Modified to call renderDivisionSkeletonEditor)
function addDivision() {
    const i = document.getElementById("divisionInput");
    if (i.value.trim() === "") return;
    const name = i.value.trim();
    if (!availableDivisions.includes(name)) {
        const color = defaultColors[colorIndex % defaultColors.length]; colorIndex++;

        availableDivisions.push(name);
        window.availableDivisions = availableDivisions; // Update global

        divisions[name] = { bunks: [], color };
        divisionSkeletons[name] = { 
            timeline: { start: "9:00 AM", end: "4:00 PM" },
            skeleton: [], // { id, type: 'slot' | 'pinned', event: 'Lunch', startTime, duration }
            shoppingList: { leagues: 1, specials: 1 }
        };
        window.divisions = divisions; // keep global in sync
        window.divisionSkeletons = divisionSkeletons;

        i.value = "";
        saveData();
        setupDivisionButtons();
        window.initLeaguesTab?.(); 
        window.DailyActivities?.onDivisionsChanged?.();
        window.updateTable?.();
        renderDivisionSkeletonEditor(); // NEW
    }
}
document.getElementById("addDivisionBtn").onclick = addDivision;
document.getElementById("divisionInput").addEventListener("keyup", e => { if (e.key === "Enter") addDivision(); });

function setupDivisionButtons() {
    const cont = document.getElementById("divisionButtons"); cont.innerHTML = "";
    const colorEnabled = document.getElementById("enableColor").checked;
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
            
            // NEW: Render skeleton editor for the selected division
            renderDivisionSkeletonEditor();
        };
        if (selectedDivision === name) span.classList.add("selected");

        makeEditable(span, newName => {
            divisions[newName] = divisions[name];
            delete divisions[name];
            window.divisions = divisions; 
            
            divisionSkeletons[newName] = divisionSkeletons[name];
            delete divisionSkeletons[name];
            window.divisionSkeletons = divisionSkeletons;

            availableDivisions[availableDivisions.indexOf(name)] = newName;
            window.availableDivisions = availableDivisions;

            if (selectedDivision === name) selectedDivision = newName;
            saveData();
            setupDivisionButtons();
            window.initLeaguesTab?.();
            window.DailyActivities?.onDivisionsChanged?.();
            renderDivisionSkeletonEditor(); // NEW
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
            window.DailyActivities?.onDivisionsChanged?.();
        };
        wrap.appendChild(col);
        cont.appendChild(wrap);
    });
    
    // Render rules for the initially selected division (if any)
    renderDivisionSkeletonEditor();
}
document.getElementById("enableColor").addEventListener("change", setupDivisionButtons);

// -------------------- (DELETED) Schedule Periods (Names Only) --------------------
// (The addSchedulePeriod and renderSchedulePeriods functions are completely removed)

// -------------------- (REPLACED) NEW: Division Skeleton Editor --------------------
// This function replaces renderDivisionRules and renderSchedulePeriods
function renderDivisionSkeletonEditor() {
    const container = document.getElementById("divisionSkeletonEditor");
    if (!container) return;

    if (!selectedDivision) {
        container.innerHTML = `<p style="color: #666;">Select a division to set its "Skeleton" and "Shopping List."</p>`;
        return;
    }

    const data = divisionSkeletons[selectedDivision];
    if (!data) {
        container.innerHTML = `<p style="color: #c00;">Error: Could not find skeleton data for ${selectedDivision}.</p>`;
        return;
    }
    
    // Ensure data structure is initialized
    data.timeline = data.timeline || { start: "9:00 AM", end: "4:00 PM" };
    data.skeleton = data.skeleton || [];
    data.shoppingList = data.shoppingList || { leagues: 1, specials: 1 };

    container.innerHTML = `
        <div style="border: 1px solid #ddd; border-radius: 8px; padding: 15px;">
            <h4 style="margin-top: 0; margin-bottom: 15px;">Settings for ${selectedDivision}</h4>
            
            <div style="margin-bottom: 15px;">
                <label>Start Time:</label>
                <input type="text" value="${data.timeline.start}" data-key="timeline.start" class="skel-input">
                <label style="margin-left: 10px;">End Time:</label>
                <input type="text" value="${data.timeline.end}" data-key="timeline.end" class="skel-input">
            </div>

            <div style="margin-bottom: 20px; padding-bottom: 15px; border-bottom: 1px solid #eee;">
                <h5 style="margin-top: 0; margin-bottom: 10px;">Daily "Shopping List" (What to fit in)</h5>
                <label>Leagues:</label>
                <input type="number" value="${data.shoppingList.leagues}" data-key="shoppingList.leagues" class="skel-input" style="width: 50px;">
                <label style="margin-left: 10px;">Specials:</label>
                <input type="number" value="${data.shoppingList.specials}" data-key="shoppingList.specials" class="skel-input" style="width: 50px;">
                <p style="font-size: 0.85em; color: #666; margin-top: 5px;">
                    'General Activities' will automatically fill the rest.
                </p>
            </div>

            <h5 style="margin-top: 0; margin-bottom: 10px;">Day "Skeleton" (The order of events)</h5>
            <div id="skeleton-list-container"></div>
            <div id="skeleton-add-buttons" style="margin-top: 10px; display: flex; gap: 10px;">
                <button id="add-slot-btn" style="background: #007BFF; color: white;">+ Add Activity Slot</button>
                <button id="add-pinned-btn">+ Add Pinned Event (e.g., Lunch)</button>
            </div>
        </div>
    `;

    // --- Render the Skeleton List ---
    const listContainer = container.querySelector("#skeleton-list-container");
    
    data.skeleton.forEach((item, index) => {
        const el = document.createElement("div");
        el.className = "fieldWrapper";
        el.style.display = "flex";
        el.style.alignItems = "center";
        el.style.gap = "10px";
        el.innerHTML = `
            <span style="font-weight: bold; min-width: 20px;">${index + 1}.</span>
            ${getSkeletonItemHTML(item)}
        `;
        listContainer.appendChild(el);
    });

    // --- Add Event Listeners ---
    
    // For simple text/number inputs
    container.querySelectorAll('.skel-input').forEach(input => {
        input.onchange = (e) => {
            const keys = e.target.getAttribute('data-key').split('.');
            if (keys.length === 2) {
                data[keys[0]][keys[1]] = e.target.value;
            } else {
                data[keys[0]] = e.target.value;
            }
            saveData();
        };
    });

    // For skeleton list inputs
    listContainer.querySelectorAll('.skel-item-input').forEach(input => {
        input.onchange = (e) => {
            const index = parseInt(e.target.getAttribute('data-index'), 10);
            const key = e.target.getAttribute('data-key');
            data.skeleton[index][key] = e.target.value;
            saveData();
        };
    });

    // For skeleton item deletion
    listContainer.querySelectorAll('.skel-delete-btn').forEach(btn => {
        btn.onclick = (e) => {
            const index = parseInt(e.target.getAttribute('data-index'), 10);
            data.skeleton.splice(index, 1);
            saveData();
            renderDivisionSkeletonEditor(); // Re-render the whole editor
        };
    });
    
    // For Add buttons
    container.querySelector("#add-slot-btn").onclick = () => {
        data.skeleton.push({ id: uid(), type: 'slot' });
        saveData();
        renderDivisionSkeletonEditor();
    };
    container.querySelector("#add-pinned-btn").onclick = () => {
        data.skeleton.push({ id: uid(), type: 'pinned', event: 'Lunch', startTime: '', duration: '30' });
        saveData();
        renderDivisionSkeletonEditor();
    };
}

function getSkeletonItemHTML(item, index) {
    if (item.type === 'slot') {
        return `
            <div style="flex-grow: 1; padding: 10px; background: #e8f4ff; border-radius: 4px;">
                <strong>Schedulable Activity Slot</strong>
                <em style="font-size: 0.9em; margin-left: 10px;">(Program will fill this)</em>
            </div>
            <button class="skel-delete-btn" data-index="${index}" style="background: #c0392b; color: white;">✖</button>
        `;
    }
    
    if (item.type === 'pinned') {
        return `
            <div style="flex-grow: 1; padding: 10px; background: #f8f8f8; border: 1px solid #ddd; border-radius: 4px;">
                <select class="skel-item-input" data-index="${index}" data-key="event">
                    <option value="Lunch" ${item.event === 'Lunch' ? 'selected' : ''}>Lunch</option>
                    <option value="Swim" ${item.event === 'Swim' ? 'selected' : ''}>Swim</option>
                    <option value="Other" ${item.event === 'Other' ? 'selected' : ''}>Other</option>
                </select>
                <label style="margin-left: 10px;">Duration (mins):</label>
                <input type="number" class="skel-item-input" data-index="${index}" data-key="duration" value="${item.duration}" style="width: 50px;">
                <label style="margin-left: 10px;">Start Time (Optional):</label>
                <input type="text" class="skel-item-input" data-index="${index}" data-key="startTime" value="${item.startTime}" placeholder="e.g., 12:00 PM">
            </div>
            <button class="skel-delete-btn" data-index="${index}" style="background: #c0392b; color: white;">✖</button>
        `;
    }
    return '';
}

// -------------------- Fields / Specials --------------------
// (addField, renderFields, addSpecial, renderSpecials functions are unchanged)
// ...

// -------------------- Local Storage (UPDATED) --------------------
function saveData() {
    const data = { 
        bunks, 
        divisions, 
        divisionSkeletons, // NEW: Save skeleton data
        availableDivisions, 
        selectedDivision, 
        fields, 
        specialActivities, 
        // (schedulePeriods is removed)
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
        
        // NEW: Load skeleton data
        divisionSkeletons = data.divisionSkeletons || {};
        
        // One-time migration from OLD system
        if (Object.keys(divisionSkeletons).length === 0 && data.schedulePeriods) {
            console.warn("Migrating old block system to new Skeleton system...");
            availableDivisions.forEach(divName => {
                const oldRules = divisions[divName]?.periodRules || {};
                divisionSkeletons[divName] = {
                    timeline: { start: "9:00 AM", end: "4:00 PM" },
                    skeleton: [],
                    shoppingList: { leagues: 1, specials: 1 }
                };
                
                (data.schedulePeriods || []).forEach(period => {
                    const rule = oldRules[period.id];
                    if (rule) {
                        if (rule.rule === 'fixed') {
                            divisionSkeletons[divName].skeleton.push({
                                id: uid(), type: 'pinned', event: period.name,
                                startTime: rule.start, duration: '30' // Placeholder
                            });
                        } else {
                            const numSlots = parseInt(rule.rule, 10) || 1;
                            for (let i = 0; i < numSlots; i++) {
                                divisionSkeletons[divName].skeleton.push({ id: uid(), type: 'slot' });
                            }
                        }
                    }
                });
            });
            // We don't auto-save here, but it will save on the next user action
        }
        
        window.divisions = divisions;
        window.availableDivisions = availableDivisions;
        window.divisionSkeletons = divisionSkeletons;
        selectedDivision = data.selectedDivision || null;
        fields = data.fields || [];
        specialActivities = data.specialActivities || [];
        
        // ... (Field and Special normalization is unchanged) ...
        
    } catch (e) { console.error("Error loading data:", e); }
}

// -------------------- Init --------------------
function initApp1() {
    // ... (Hookup field/special buttons is unchanged) ...

    // Load all data
    loadData();
    
    // Render all UI components
    updateUnassigned();
    setupDivisionButtons();
    
    // ----- THIS IS THE FIX -----
    // Call renderers for fields and specials
    renderFields();
    renderSpecials();
    // ---------------------------
    
    // (renderSchedulePeriods is removed)
    // renderDivisionSkeletonEditor() is called by setupDivisionButtons
}
window.initApp1 = initApp1;


// Expose internal objects
window.getDivisions = () => divisions;
window.getFields = () => fields;
window.getSpecials = () => specialActivities;
