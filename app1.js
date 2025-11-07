// -------------------- State --------------------
let bunks = [];
let divisions = {}; // { divName:{ bunks:[], color, start, end } }
// availableDivisions will be exposed globally as window.availableDivisions
let availableDivisions = [];
let selectedDivision = null;

let fields = [], specialActivities = [];

let timeTemplates = []; // [{start,end,divisions:[]}]
let activityDuration = 30;
// NOTE: Scheduling state (scheduleAssignments, unifiedTimes, divisionActiveRows)
// is now primarily managed by app2.js, but these arrays are
// retained for utility functions.
let unifiedTimes = []; // [{start:Date,end:Date,label:string}]
let divisionActiveRows = {}; // { divName: Set(rowIndices) }

const defaultColors = ['#4CAF50','#2196F3','#E91E63','#FF9800','#9C27B0','#00BCD4','#FFC107','#F44336','#8BC34A','#3F51B5'];
let colorIndex = 0;
const commonActivities = ["Basketball","Baseball","Hockey","Football","Soccer","Volleyball","Lacrosse"];

// Expose internal variable to the window for use by other modules (league.js, daily_activities.js)
window.divisions = divisions;
window.availableDivisions = availableDivisions;
window.fields = fields;
window.specialActivities = specialActivities;
window.timeTemplates = timeTemplates;
// =============================================
// ===== THIS CODE BLOCK WAS MOVED (see line 429) =====
// =============================================
// document.getElementById("activityDuration").onchange = function() {
// activityDuration = parseInt(this.value, 10);
// };

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

function parseTime(str) {
if (!str) return null;
const m = str.match(/^(\d{1,2}):(\d{2})(\s*)?(AM|PM)$/i);
if (!m) return null;
let h = parseInt(m[1],10), min = parseInt(m[2],10), ap = m[4].toUpperCase();
if (ap === "PM" && h !== 12) h += 12; if (ap === "AM" && h === 12) h = 0;
return new Date(0,0,0,h,min);
}

function fmtTime(d) {
let h = d.getHours(), m = d.getMinutes().toString().padStart(2,"0"), ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
return `${h}:${m} ${ap}`;
}

// -------------------- NEW/UPDATED HELPER FUNCTIONS --------------------

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
* Renders the "Available / Unavailable" time-based controls
*/
function renderAvailabilityControls(item, onSave, onRerender) {
const container = document.createElement("div");
container.style.marginTop = "10px";
container.style.paddingLeft = "15px";
container.style.borderLeft = "3px solid #eee";

// --- 1. Mode Toggle (Available / Unavailable) ---
const modeLabel = document.createElement("label");
modeLabel.style.display = "flex";
modeLabel.style.alignItems = "center";
modeLabel.style.gap = "10px";
modeLabel.style.cursor = "pointer";

const textAvailable = document.createElement("span");
textAvailable.textContent = "Available";
const toggleTrack = document.createElement("span");
Object.assign(toggleTrack.style, {
"width": "44px",
"height": "24px",
"borderRadius": "99px",
"position": "relative",
"display": "inline-block",
"border": "1px solid #ccc",
"backgroundColor": item.availabilityMode === 'available' ? '#22c55e' : '#d1d5db',
"transition": "background-color 0.2s"
});
const toggleKnob = document.createElement("span");
Object.assign(toggleKnob.style, {
"width": "20px",
"height": "20px",
"borderRadius": "50%",
"backgroundColor": "white",
"position": "absolute",
"top": "1px",
"left": item.availabilityMode === 'available' ? '21px' : '1px',
"transition": "left 0.2s"
});
toggleTrack.appendChild(toggleKnob);

const textUnavailable = document.createElement("span");
textUnavailable.textContent = "Unavailable";

// Set initial text style
textAvailable.style.fontWeight = item.availabilityMode === 'available' ?
'bold' : 'normal';
textUnavailable.style.fontWeight = item.availabilityMode === 'unavailable' ? 'bold' : 'normal';
// Use onclick on the label to toggle state
modeLabel.onclick = () => {
item.availabilityMode = (item.availabilityMode === 'available') ?
'unavailable' : 'available';
toggleTrack.style.backgroundColor = item.availabilityMode === 'available' ? '#22c55e' : '#d1d5db';
toggleKnob.style.left = item.availabilityMode === 'available' ?
'21px' : '1px';
textAvailable.style.fontWeight = item.availabilityMode === 'available' ? 'bold' : 'normal';
textUnavailable.style.fontWeight = item.availabilityMode === 'unavailable' ?
'bold' : 'normal';
onSave();
};

modeLabel.appendChild(textAvailable);
modeLabel.appendChild(toggleTrack);
modeLabel.appendChild(textUnavailable);
container.appendChild(modeLabel);

// --- 2. "Except for..." Text ---
const exceptLabel = document.createElement("span");
exceptLabel.textContent = " except for:";
exceptLabel.style.fontWeight = "500";
container.appendChild(exceptLabel);

// --- 3. Exception Time List ---
const exceptionList = document.createElement("div");
exceptionList.style.display = "flex";
exceptionList.style.flexWrap = "wrap";
exceptionList.style.gap = "6px";
exceptionList.style.marginTop = "6px";

item.availabilityExceptions = item.availabilityExceptions || [];
item.availabilityExceptions.forEach((timeStr, index) => {
const pill = document.createElement("span");
pill.textContent = `${timeStr} ✖`;
pill.style.background = "#ddd";
pill.style.padding = "4px 8px";
pill.style.borderRadius = "12px";
pill.style.cursor = "pointer";
pill.onclick = () => {
item.availabilityExceptions.splice(index, 1);
onSave();
onRerender();
};
exceptionList.appendChild(pill);
});
container.appendChild(exceptionList);

// --- 4. Add New Exception Input ---
const addContainer = document.createElement("div");
addContainer.style.marginTop = "6px";
const timeInput = document.createElement("input");
timeInput.placeholder = "e.g., 9:00am-10:30am";
timeInput.style.marginRight = "5px";

const addBtn = document.createElement("button");
addBtn.textContent = "Add Time";
addBtn.onclick = () => {
const val = timeInput.value.trim();
const parts = val.split('-');
if (parts.length === 2) {
const startMin = parseTimeToMinutes(parts[0]);
const endMin = parseTimeToMinutes(parts[1]);
if (startMin != null && endMin != null && endMin > startMin) {
item.availabilityExceptions.push(val);
timeInput.value = "";
onSave();
onRerender();
} else {
alert("Invalid time range. Use format '9:00am-10:30am'. Ensure end time is after start time.");
}
} else {
alert("Invalid format. Must be a range separated by a hyphen (e.g., '9:00am-10:30am').");
}
};
timeInput.onkeypress = (e) => { if (e.key === "Enter") addBtn.click(); };

addContainer.appendChild(timeInput);
addContainer.appendChild(addBtn);
container.appendChild(addContainer);

return container;
}

/**
* NEW: Renders the advanced "Sharable With" controls (Divisions only)
*/
function renderSharableControls(item, onSave, onRerender) {
const container = document.createElement("div");
container.style.marginTop = "10px";
const rules = item.sharableWith || { type: 'not_sharable' };
const isSharable = rules.type !== 'not_sharable';
// --- 1. Master "Sharable" Toggle ---
const tog = document.createElement("label");
tog.className = "switch";
tog.title = "Toggle Sharable";
const cb = document.createElement("input");
cb.type = "checkbox";
cb.checked = isSharable;
cb.onchange = () => {
if (cb.checked) {
rules.type = 'all';
// Default to 'all' when turned on
} else {
rules.type = 'not_sharable';
}
rules.divisions = []; // Clear custom rules
onSave();
onRerender();
};
const sl = document.createElement("span"); sl.className = "slider";
tog.appendChild(cb); tog.appendChild(sl);
const togLabel = document.createElement("span");
togLabel.textContent = "Sharable";
const shareWrap = document.createElement("label");
shareWrap.style.display="flex";
shareWrap.style.alignItems="center";
shareWrap.style.gap="5px";
shareWrap.style.cursor="pointer";
shareWrap.appendChild(tog);
shareWrap.appendChild(togLabel);
container.appendChild(shareWrap);

// --- 2. Custom Panel (if "Sharable" is ON) ---
if (isSharable) {
const customPanel = document.createElement("div");
customPanel.style.paddingLeft = "20px";
customPanel.style.marginTop = "10px";

// --- Division Picker ---
const divLabel = document.createElement("div");
divLabel.textContent = "Limit to Divisions (if none selected, sharable with all):";
customPanel.appendChild(divLabel);
const onDivToggle = () => {
rules.type = (rules.divisions.length > 0) ? 'custom' : 'all';
onSave();
onRerender();
};
const divChipBox = createChipPicker(window.availableDivisions || [], rules.divisions, onDivToggle);
customPanel.appendChild(divChipBox);

container.appendChild(customPanel);
}

return container;
}

/**
* Helper for renderSharableControls to create chip pickers
*/
function createChipPicker(allItems, selectedItems, onToggle) {
const chipBox = document.createElement("div");
chipBox.style.display = "flex";
chipBox.style.flexWrap = "wrap";
chipBox.style.gap = "5px";
chipBox.style.marginTop = "5px";

allItems.forEach(name => {
const chip = document.createElement("span");
chip.textContent = name;
chip.style.padding = "4px 8px";
chip.style.borderRadius = "12px";
chip.style.cursor = "pointer";
chip.style.border = "1px solid #ccc";

const isActive = selectedItems.includes(name);
chip.style.backgroundColor = isActive ? "#007BFF" : "#f0f0f0";
chip.style.color = isActive ? "white" : "black";

chip.onclick = () => {
const idx = selectedItems.indexOf(name);
if (idx > -1) {
selectedItems.splice(idx, 1);
} else {
selectedItems.push(name);
}
onToggle();
};
chipBox.appendChild(chip);
});
return chipBox;
}

/**
* NEW: Renders the advanced "Limit Usage" controls (Divisions/Bunks)
*/
function renderLimitUsageControls(item, onSave, onRerender) {
    const container = document.createElement("div");
    container.style.marginTop = "10px";
    container.style.paddingTop = "10px";
    container.style.borderTop = "1px solid #eee";

    // Ensure the new data structure exists
    if (!item.limitUsage) {
        item.limitUsage = { enabled: false, divisions: {} };
    }
    const rules = item.limitUsage;

    // --- 1. Master "Limit Usage" Toggle ---
    const modeLabel = document.createElement("label");
    modeLabel.style.display = "flex";
    modeLabel.style.alignItems = "center";
    modeLabel.style.gap = "10px";
    modeLabel.style.cursor = "pointer";

    const textAll = document.createElement("span");
    textAll.textContent = "All";
    
    const toggleTrack = document.createElement("span");
    Object.assign(toggleTrack.style, {
        "width": "44px",
        "height": "24px",
        "borderRadius": "99px",
        "position": "relative",
        "display": "inline-block",
        "border": "1px solid #ccc",
        "backgroundColor": rules.enabled ? '#d1d5db' : '#22c55e', // Grey for "Limit", Green for "All"
        "transition": "background-color 0.2s"
    });

    const toggleKnob = document.createElement("span");
    Object.assign(toggleKnob.style, {
        "width": "20px",
        "height": "20px",
        "borderRadius": "50%",
        "backgroundColor": "white",
        "position": "absolute",
        "top": "1px",
        "left": rules.enabled ? '21px' : '1px', // Right for "Limit", Left for "All"
        "transition": "left 0.2s"
    });
    toggleTrack.appendChild(toggleKnob);

    const textLimit = document.createElement("span");
    textLimit.textContent = "Limit";

    // Set initial text style
    textAll.style.fontWeight = rules.enabled ? 'normal' : 'bold';
    textLimit.style.fontWeight = rules.enabled ? 'bold' : 'normal';

    modeLabel.onclick = () => {
        rules.enabled = !rules.enabled; // Toggle state
        
        // Update styles
        toggleTrack.style.backgroundColor = rules.enabled ? '#d1d5db' : '#22c55e';
        toggleKnob.style.left = rules.enabled ? '21px' : '1px';
        textAll.style.fontWeight = rules.enabled ? 'normal' : 'bold';
        textLimit.style.fontWeight = rules.enabled ? 'bold' : 'normal';

        onSave();
        onRerender(); // Re-render to show/hide the panel
    };

    modeLabel.appendChild(textAll);
    modeLabel.appendChild(toggleTrack);
    modeLabel.appendChild(textLimit);
    container.appendChild(modeLabel);

    // --- 2. Custom Panel (if "Limit" is ON) ---
    if (rules.enabled) {
        const customPanel = document.createElement("div");
        customPanel.style.paddingLeft = "20px";
        customPanel.style.marginTop = "10px";
        customPanel.style.borderLeft = "3px solid #eee";

        const divLabel = document.createElement("div");
        divLabel.textContent = "Limit to specific divisions and/or bunks:";
        divLabel.style.fontWeight = "500";
        customPanel.appendChild(divLabel);

        const allDivisions = window.availableDivisions || [];
        
        if (allDivisions.length === 0) {
             customPanel.innerHTML += `<p class="muted">No divisions found. Add divisions in Setup.</p>`;
        }

        allDivisions.forEach(divName => {
            const divWrapper = document.createElement("div");
            divWrapper.style.marginTop = "8px";

            // --- Division Chip ---
            const divChip = createLimitChip(divName, divName in rules.divisions);
            divChip.onclick = () => {
                if (divName in rules.divisions) {
                    delete rules.divisions[divName]; // Deselect
                } else {
                    rules.divisions[divName] = []; // Select (with "all bunks" default)
                }
                onSave();
                onRerender();
            };
            divWrapper.appendChild(divChip);

            // --- Bunk List (if division is selected) ---
            if (divName in rules.divisions) {
                const bunkList = document.createElement("div");
                bunkList.style.display = "flex";
                bunkList.style.flexWrap = "wrap";
                bunkList.style.gap = "5px";
                bunkList.style.marginTop = "5px";
                bunkList.style.paddingLeft = "25px";

                const bunksInDiv = (window.divisions[divName]?.bunks || []);
                
                if (bunksInDiv.length === 0) {
                     bunkList.innerHTML = `<span class="muted" style="font-size: 0.9em;">No bunks in this division.</span>`;
                }

                const selectedBunks = rules.divisions[divName] || [];
                
                bunksInDiv.forEach(bunkName => {
                    const bunkChip = createLimitChip(bunkName, selectedBunks.includes(bunkName), false);
                    bunkChip.onclick = () => {
                        const bunkIdx = selectedBunks.indexOf(bunkName);
                        if (bunkIdx > -1) {
                            selectedBunks.splice(bunkIdx, 1); // Deselect bunk
                        } else {
                            selectedBunks.push(bunkName); // Select bunk
                        }
                        onSave();
                        onRerender();
                    };
                    bunkList.appendChild(bunkChip);
                });
                divWrapper.appendChild(bunkList);
            }
            customPanel.appendChild(divWrapper);
        });
        container.appendChild(customPanel);
    }

    return container;
}

/**
* Helper for renderLimitUsageControls to create chips
*/
function createLimitChip(name, isActive, isDivision = true) {
    const chip = document.createElement("span");
    chip.textContent = name;
    chip.style.padding = "4px 8px";
    chip.style.borderRadius = "12px";
    chip.style.cursor = "pointer";
    chip.style.border = "1px solid #ccc";
    chip.style.fontSize = isDivision ? "0.95em" : "0.9em";
    
    const activeBG = isDivision ? "#007BFF" : "#5bc0de";
    const activeColor = "white";
    const inactiveBG = isDivision ? "#f0f0f0" : "#f9f9f9";
    const inactiveColor = "black";

    chip.style.backgroundColor = isActive ? activeBG : inactiveBG;
    chip.style.color = isActive ? activeColor : inactiveColor;
    chip.style.borderColor = isActive ? activeBG : (isDivision ? "#ccc" : "#ddd");

    return chip;
}

// --- END OF NEW/UPDATED HELPER FUNCTIONS ---


// -------------------- Tabs --------------------
// This function is now defined in index.html in the <script> tag
// window.showTab = showTab;
// -------------------- Bunks --------------------
function addBunk() {
const i = document.getElementById("bunkInput");
const name = i.value.trim();
if (!name) return;
// Prevent duplicates (case-insensitive)
const exists = bunks.some(b => b.toLowerCase() === name.toLowerCase());
if (exists) {
alert("That bunk already exists!");
i.value = "";
return;
}

bunks.push(name);
saveData();
i.value = "";
updateUnassigned();
window.updateTable?.();
}
document.getElementById("addBunkBtn").onclick = addBunk;
document.getElementById("bunkInput").addEventListener("keyup", e => { if (e.key === "Enter") addBunk(); });

function updateUnassigned() {
const c = document.getElementById("unassignedBunks");
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
alert("Select a division first!");
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

divisions[name] = { bunks: [], color, start: null, end: null };
window.divisions = divisions;
// keep global in sync

i.value = "";
saveData();
setupDivisionButtons();
window.initLeaguesTab?.(); // Notify league.js
window.DailyActivities?.onDivisionsChanged?.(); // Notify fixed activities
window.updateTable?.();
renderTimeTemplates();
}
}
document.getElementById("addDivisionBtn").onclick = addDivision;
document.getElementById("divisionInput").addEventListener("keyup", e => { if (e.key === "Enter") addDivision(); });
function setupDivisionButtons() {
const cont = document.getElementById("divisionButtons"); cont.innerHTML = "";
const colorEnabled = document.getElementById("enableColor").checked;
availableDivisions.forEach(name => {
const obj = divisions[name];

// --- FIX 1 ---
// Add a safety check here. If obj is undefined, skip this iteration.
if (!obj) {
    console.warn(`Data mismatch: Division "${name}" exists in availableDivisions but not in divisions object. Skipping.`);
    return; 
}
// --- END FIX 1 ---

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
window.divisions = divisions; // keep global in sync after rename

availableDivisions[availableDivisions.indexOf(name)] = newName;
window.availableDivisions = availableDivisions; // Update global

if (selectedDivision === name) selectedDivision = newName;
saveData();
setupDivisionButtons();
window.initLeaguesTab?.();
window.DailyActivities?.onDivisionsChanged?.();
renderTimeTemplates();
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
renderTimeTemplates();
window.DailyActivities?.onDivisionsChanged?.();
};
wrap.appendChild(col);
cont.appendChild(wrap);
});
}
document.getElementById("enableColor").addEventListener("change", setupDivisionButtons);
// -------------------- Time Templates --------------------
function addTimeTemplate() {
const start = document.getElementById("timeStartInput").value.trim();
const end = document.getElementById("timeEndInput").value.trim();
if (!start || !end) return;
timeTemplates.push({ start, end, divisions: [] });
document.getElementById("timeStartInput").value = "";
document.getElementById("timeEndInput").value = "";
saveData();
renderTimeTemplates();
}

function renderTimeTemplates() {
const cont = document.getElementById("timeTemplates"); cont.innerHTML = "";
timeTemplates.forEach((tpl) => {
const wrap = document.createElement("div"); wrap.className = "fieldWrapper";
const label = document.createElement("span"); label.textContent = `${tpl.start} - ${tpl.end}`;
wrap.appendChild(label);
availableDivisions.forEach(div => {
const btn = document.createElement("button");
btn.textContent = div; btn.className = "bunk-button";
if (tpl.divisions.includes(div)) { btn.style.backgroundColor = divisions[div].color; btn.style.color = "#fff"; }
else { btn.style.backgroundColor = "#fff"; btn.style.color = "#000"; }
btn.onclick = () => {
if (tpl.divisions.includes(div)) {
tpl.divisions = tpl.divisions.filter(d => d !== div);
} else {
tpl.divisions.push(div);
}
saveData();
applyTemplatesToDivisions();
renderTimeTemplates();
};
wrap.appendChild(btn);
});
cont.appendChild(wrap);
});
applyTemplatesToDivisions();
}

function applyTemplatesToDivisions() {
availableDivisions.forEach(div => {
let match = null;
for (let i = timeTemplates.length - 1; i >= 0; i--) {
if (timeTemplates[i].divisions.includes(div)) { match = timeTemplates[i]; break; }
}
if (match) { divisions[div].start = match.start; divisions[div].end = match.end; }
});
}

// -------------------- Fields / Specials --------------------

function addField() {
const i = document.getElementById("fieldInput");
const n = i.value.trim();
if (n) {
// Default sharableWith: divisions only
fields.push({
    name: n,
    activities: [],
    available: true,
    sharableWith: { type: 'not_sharable', divisions: [] },
    limitUsage: { enabled: false, divisions: {} }, // <-- ADDED
    availabilityMode: 'available',
    availabilityExceptions: []
});
i.value = "";
saveData();
renderFields();
}
}
document.getElementById("addFieldBtn").onclick = addField;
document.getElementById("fieldInput").addEventListener("keyup", e => { if (e.key === "Enter") addField(); });
function renderFields() {
const c = document.getElementById("fieldList"); c.innerHTML = "";
fields.forEach(f => {
const w = document.createElement("div"); w.className = "fieldWrapper"; if (!f.available) w.classList.add("unavailable");
const t = document.createElement("span"); t.className = "fieldTitle"; t.textContent = f.name;
makeEditable(t, newName => { f.name = newName; saveData(); renderFields(); });
w.appendChild(t);

const controls = document.createElement("div");
controls.style.display = "flex";
controls.style.gap = "20px";
controls.style.margin = "8px 0";

// 1. Available Toggle
const tog = document.createElement("label"); tog.className = "switch";
tog.title = "Available (Master)";
const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = f.available;
cb.onchange = () => { f.available = cb.checked; saveData(); renderFields(); };
const sl = document.createElement("span"); sl.className = "slider";
tog.appendChild(cb); tog.appendChild(sl);
const togLabel = document.createElement("span"); togLabel.textContent = "Available";
const availWrap = document.createElement("label");
availWrap.style.display="flex"; availWrap.style.alignItems="center"; availWrap.style.gap="5px"; availWrap.style.cursor="pointer";
availWrap.appendChild(tog); availWrap.appendChild(togLabel);
controls.appendChild(availWrap);

w.appendChild(controls);

const bw = document.createElement("div"); bw.style.marginTop = "8px";
commonActivities.forEach(act => {
const b = document.createElement("button"); b.textContent = act; b.className = "activity-button";
if (f.activities.includes(act)) b.classList.add("active");
b.onclick = () => {
if (f.activities.includes(act)) f.activities = f.activities.filter(a => a !== act);
else f.activities.push(act);
saveData(); renderFields();
};
bw.appendChild(b);
});
w.appendChild(bw);
const other = document.createElement("input");
other.placeholder = "Other activity";
other.onkeyup = e => {
if (e.key === "Enter" && other.value.trim()) {
const v = other.value.trim();
if (!f.activities.includes(v)) f.activities.push(v);
other.value = "";
saveData(); renderFields();
}
};
w.appendChild(other);
if (f.activities.length > 0) {
const p = document.createElement("p"); p.style.marginTop = "6px";
p.textContent = "Activities: " + f.activities.join(", ");
w.appendChild(p);
}

// --- Sharable Controls (Divisions only) ---
const sharableControls = renderSharableControls(f, saveData, renderFields);
w.appendChild(sharableControls);

// --- Limit Usage Controls (Divisions/Bunks) ---
const limitControls = renderLimitUsageControls(f, saveData, renderFields);
w.appendChild(limitControls);

// --- Availability Controls ---
const availabilityControls = renderAvailabilityControls(f, saveData, renderFields);
availabilityControls.style.marginTop = "10px"; // <-- ADDED for spacing
availabilityControls.style.paddingTop = "10px"; // <-- ADDED for spacing
availabilityControls.style.borderTop = "1px solid #eee"; // <-- ADDED for spacing
w.appendChild(availabilityControls);

c.appendChild(w);
});
}

function addSpecial() {
const i = document.getElementById("specialInput");
const n = i.value.trim();
if (n) {
// Default sharableWith: divisions only
specialActivities.push({
    name: n,
    available: true,
    sharableWith: { type: 'not_sharable', divisions: [] },
    limitUsage: { enabled: false, divisions: {} }, // <-- ADDED
    availabilityMode: 'available',
    availabilityExceptions: []
});
i.value = "";
saveData();
renderSpecials();
}
}
document.getElementById("addSpecialBtn").onclick = addSpecial;
document.getElementById("specialInput").addEventListener("keyup", e => { if (e.key === "Enter") addSpecial(); });


function renderSpecials() {
const c = document.getElementById("specialList");
c.innerHTML = "";
specialActivities.forEach(s => {
const w = document.createElement("div"); w.className = "fieldWrapper"; if (!s.available) w.classList.add("unavailable");
const t = document.createElement("span"); t.className = "fieldTitle"; t.textContent = s.name;
makeEditable(t, newName => { s.name = newName; saveData(); renderSpecials(); });
w.appendChild(t);

const controls = document.createElement("div");
controls.style.display = "flex";
controls.style.gap = "20px";
controls.style.margin = "8px 0";

// 1. Available Toggle
const tog = document.createElement("label"); tog.className = "switch";
tog.title = "Available (Master)";
const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = s.available;
cb.onchange = () => { s.available = cb.checked; saveData(); renderSpecials(); };
const sl = document.createElement("span"); sl.className = "slider";
tog.appendChild(cb); tog.appendChild(sl);
const togLabel = document.createElement("span");
togLabel.textContent = "Available";
const availWrap = document.createElement("label"); availWrap.style.display="flex"; availWrap.style.alignItems="center"; availWrap.style.gap="5px"; availWrap.style.cursor="pointer";
availWrap.appendChild(tog); availWrap.appendChild(togLabel);
controls.appendChild(availWrap);

w.appendChild(controls);

// --- Sharable Controls (Divisions only) ---
const sharableControls = renderSharableControls(s, saveData, renderSpecials);
w.appendChild(sharableControls);

// --- Limit Usage Controls (Divisions/Bunks) ---
const limitControls = renderLimitUsageControls(s, saveData, renderSpecials);
w.appendChild(limitControls);

// --- Availability Controls ---
const availabilityControls = renderAvailabilityControls(s, saveData, renderSpecials);
availabilityControls.style.marginTop = "10px"; // <-- ADDED for spacing
availabilityControls.style.paddingTop = "10px"; // <-- ADDED for spacing
availabilityControls.style.borderTop = "1px solid #eee"; // <-- ADDED for spacing
w.appendChild(availabilityControls);

c.appendChild(w);
});
}

// -------------------- Generate Times --------------------
function generateTimes() {
const inc = parseInt(document.getElementById("increment").value, 10);
applyTemplatesToDivisions();

// --- FIX 2 ---
// Add a safety check in the .map() to avoid crashing on undefined divisions
const starts = availableDivisions
    .map(d => divisions[d] ? parseTime(divisions[d].start) : null)
    .filter(Boolean);
const ends = availableDivisions
    .map(d => divisions[d] ? parseTime(divisions[d].end) : null)
    .filter(Boolean);
// --- END FIX 2 ---
    
if (starts.length === 0 || ends.length === 0) { alert("Please set time templates for divisions first.");
return; }

const earliest = new Date(Math.min(...starts.map(d => d.getTime())));
const latest = new Date(Math.max(...ends.map(d => d.getTime())));

unifiedTimes = [];
let cur = new Date(earliest);
while (cur < latest) {
let nxt = new Date(cur.getTime() + inc*60000);
if (nxt > latest) nxt = latest;
unifiedTimes.push({ start:new Date(cur), end:new Date(nxt), label:`${fmtTime(cur)} - ${fmtTime(nxt)}` });
cur = nxt;
}

divisionActiveRows = {};
availableDivisions.forEach(div => {
// Add safety check here too
if (!divisions[div]) return; 
const s = parseTime(divisions[div].start), e = parseTime(divisions[div].end);
const rows = new Set();
unifiedTimes.forEach((t, idx) => {
if (s && e && t.start >= s && t.start < e) rows.add(idx);
});
divisionActiveRows[div] = rows;
});

// Expose the schedule times globally for app2.js
window.unifiedTimes = unifiedTimes;
window.divisionActiveRows = divisionActiveRows;

// handoff to scheduling
window.assignFieldsToBunks?.();
}

// -------------------- Local Storage (UPDATED) --------------------
function saveData() {
const data = 
{ bunks, divisions, availableDivisions, selectedDivision, fields, specialActivities, timeTemplates };
window.saveGlobalSettings?.("app1", data);
}

//
// ===== loadData FUNCTION (globals synced after finalization) =====
//
function loadData() {
const data = window.loadGlobalSettings?.().app1 ||
{};
try {
bunks = data.bunks || [];
divisions = data.divisions || {};

availableDivisions = (data.availableDivisions && Array.isArray(data.availableDivisions))
? data.availableDivisions.slice()
: Object.keys(divisions);
// Rebind globals AFTER values are finalized
window.divisions = divisions;
window.availableDivisions = availableDivisions;

selectedDivision = data.selectedDivision || null;
fields = data.fields || [];
specialActivities = data.specialActivities || [];
timeTemplates = data.timeTemplates || [];
// Normalize fields
fields.forEach(f => {
f.available = f.available !== false;
if (typeof f.sharable === 'boolean') {
f.sharableWith = { type: f.sharable ? 'all' : 'not_sharable' };
delete f.sharable;
}
f.sharableWith = f.sharableWith || { type: 'not_sharable' };
// divisions only
f.sharableWith.divisions = f.sharableWith.divisions || [];
f.availabilityMode = f.availabilityMode || 'available';
f.availabilityExceptions = f.availabilityExceptions || [];
f.limitUsage = f.limitUsage || { enabled: false, divisions: {} }; // <-- ADDED
});
// Normalize specials
specialActivities.forEach(s => {
s.available = s.available !== false;
if (typeof s.sharable === 'boolean') {
s.sharableWith = { type: s.sharable ? 'all' : 'not_sharable' };
delete s.sharable;
} else {
s.sharableWith = s.sharableWith || { type: 'not_sharable' };
}
// divisions only
s.sharableWith.divisions = s.sharableWith.divisions || [];
s.availabilityMode = s.availabilityMode || 'available';
s.availabilityExceptions = s.availabilityExceptions || [];
s.limitUsage = s.limitUsage || { enabled: false, divisions: {} }; // <-- ADDED
});
} catch (e) { console.error("Error loading data:", e); }
}

// "eraseAllBtn" is now handled by calendar.js

// -------------------- Init --------------------

// =============================================
// ===== START OF FIX =====
// =============================================
function initApp1() {
const activityDurationSelect = document.getElementById("activityDuration");
if (activityDurationSelect) {
activityDurationSelect.onchange = function() {
activityDuration = parseInt(this.value, 10);
};
activityDuration = parseInt(activityDurationSelect.value, 10);
} else {
console.error("Could not find #activityDuration element");
}

loadData();
updateUnassigned();
setupDivisionButtons();
renderFields();
renderSpecials();
renderTimeTemplates();
}
window.initApp1 = initApp1;
// =============================================
// ===== END OF FIX =====
// =============================================

// Expose internal objects for other modules to use (Data Source for the whole app)
window.getDivisions = () => divisions;
window.getFields = () => fields;
window.getSpecials = () => specialActivities;
