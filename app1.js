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

// -------------------- Bunks (Restored) --------------------
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
        };
        wrap.appendChild(col);
        cont.appendChild(wrap);
    });
    
    // Render rules for the initially selected division (if any)
    renderDivisionSkeletonEditor();
}
document.getElementById("enableColor").addEventListener("change", setupDivisionButtons);

// -------------------- NEW: Division Skeleton Editor --------------------
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
            ${getSkeletonItemHTML(item, index)}
            <div style="display: flex; flex-direction: column;">
                <button class="skel-move-btn" data-index="${index}" data-dir="-1" ${index === 0 ? 'disabled' : ''}>↑</button>
                <button class="skel-move-btn" data-index="${index}" data-dir="1" ${index === data.skeleton.length - 1 ? 'disabled' : ''}>↓</button>
            </div>
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
    
    // For skeleton item move
    listContainer.querySelectorAll('.skel-move-btn').forEach(btn => {
        btn.onclick = (e) => {
            const index = parseInt(e.target.getAttribute('data-index'), 10);
            const dir = parseInt(e.target.getAttribute('data-dir'), 10);
            const newIndex = index + dir;
            if (newIndex >= 0 && newIndex < data.skeleton.length) {
                // Swap
                [data.skeleton[index], data.skeleton[newIndex]] = [data.skeleton[newIndex], data.skeleton[index]];
                saveData();
                renderDivisionSkeletonEditor();
            }
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
                <em style="font-size: 0.9em; margin-left: 10px;">(Optimizer will fill this)</em>
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
            <button class="skel-delete-btn" data-index="${index}" data-key="delete" style="background: #c0392b; color: white;">✖</button>
        `;
    }
    return '';
}

// -------------------- Fields / Specials (Restored) --------------------

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

    textAvailable.style.fontWeight = item.availabilityMode === 'available' ? 'bold' : 'normal';
    textUnavailable.style.fontWeight = item.availabilityMode === 'unavailable' ? 'bold' : 'normal';
    
    modeLabel.onclick = () => {
        item.availabilityMode = (item.availabilityMode === 'available') ? 'unavailable' : 'available';
        onSave();
        onRerender(); // Re-render to update styles
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
                console.error("Invalid time range. Use format '9:00am-10:30am'. Ensure end time is after start time.");
            }
        } else {
            console.error("Invalid format. Must be a range separated by a hyphen (e.g., '9:00am-10:30am').");
        }
    };
    timeInput.onkeypress = (e) => { if (e.key === "Enter") addBtn.click(); };

    addContainer.appendChild(timeInput);
    addContainer.appendChild(addBtn);
    container.appendChild(addContainer);

    return container;
}

/**
* Renders the advanced "Sharable With" controls (Divisions only)
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
* Renders the advanced "Limit Usage" controls (Divisions/Bunks)
*/
function renderLimitUsageControls(item, onSave, onRerender) {
    const container = document.createElement("div");
    container.style.marginTop = "10px";
    container.style.paddingTop = "10px";
    container.style.borderTop = "1px solid #eee";

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

    textAll.style.fontWeight = rules.enabled ? 'normal' : 'bold';
    textLimit.style.fontWeight = rules.enabled ? 'bold' : 'normal';

    modeLabel.onclick = () => {
        rules.enabled = !rules.enabled;
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

function addField() {
    const i = document.getElementById("fieldInput");
    if (!i) return;
    const n = i.value.trim();
    if (n) {
        fields.push({
            name: n,
            activities: [],
            available: true,
            sharableWith: { type: 'not_sharable', divisions: [] },
            limitUsage: { enabled: false, divisions: {} },
            availabilityMode: 'available',
            availabilityExceptions: []
        });
        i.value = "";
        saveData();
        renderFields();
    }
}

function renderFields() {
    const c = document.getElementById("fieldList"); 
    if (!c) return;
    c.innerHTML = "";
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
        const availWrap = document.createElement("label"); availWrap.style.display="flex"; availWrap.style.alignItems="center"; availWrap.style.gap="5px"; availWrap.style.cursor="pointer";
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

        const sharableControls = renderSharableControls(f, saveData, renderFields);
        w.appendChild(sharableControls);
        const limitControls = renderLimitUsageControls(f, saveData, renderFields);
        w.appendChild(limitControls);
        const availabilityControls = renderAvailabilityControls(f, saveData, renderFields);
        availabilityControls.style.marginTop = "10px";
        availabilityControls.style.paddingTop = "10px";
        availabilityControls.style.borderTop = "1px solid #eee";
        w.appendChild(availabilityControls);
        c.appendChild(w);
    });
}

function addSpecial() {
    const i = document.getElementById("specialInput");
    if (!i) return;
    const n = i.value.trim();
    if (n) {
        specialActivities.push({
            name: n,
            available: true,
            sharableWith: { type: 'not_sharable', divisions: [] },
            limitUsage: { enabled: false, divisions: {} },
            availabilityMode: 'available',
            availabilityExceptions: []
        });
        i.value = "";
        saveData();
        renderSpecials();
    }
}

function renderSpecials() {
    const c = document.getElementById("specialList");
    if (!c) return;
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

        const sharableControls = renderSharableControls(s, saveData, renderSpecials);
        w.appendChild(sharableControls);
        const limitControls = renderLimitUsageControls(s, saveData, renderSpecials);
        w.appendChild(limitControls);
        const availabilityControls = renderAvailabilityControls(s, saveData, renderSpecials);
        availabilityControls.style.marginTop = "10px";
        availabilityControls.style.paddingTop = "10px";
        availabilityControls.style.borderTop = "1px solid #eee";
        w.appendChild(availabilityControls);
        c.appendChild(w);
    });
}
// --- END OF RESTORED FIELD/SPECIAL FUNCTIONS ---


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
        if (Object.keys(divisionSkeletons).length === 0 && (availableDivisions.length > 0 && data.divisions[availableDivisions[0]] && 'periodRules' in data.divisions[availableDivisions[0]])) {
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
        
        // Normalize fields
        fields.forEach(f => {
            f.available = f.available !== false;
            f.sharableWith = f.sharableWith || { type: 'not_sharable' };
            f.sharableWith.divisions = f.sharableWith.divisions || [];
            f.availabilityMode = f.availabilityMode || 'available';
            f.availabilityExceptions = f.availabilityExceptions || [];
            f.limitUsage = f.limitUsage || { enabled: false, divisions: {} };
        });
        // Normalize specials
        specialActivities.forEach(s => {
            s.available = s.available !== false;
            s.sharableWith = s.sharableWith || { type: 'not_sharable' };
            s.sharableWith.divisions = s.sharableWith.divisions || [];
            s.availabilityMode = s.availabilityMode || 'available';
            s.availabilityExceptions = s.availabilityExceptions || [];
            s.limitUsage = s.limitUsage || { enabled: false, divisions: {} };
        });
        
    } catch (e) { console.error("Error loading data:", e); }
}

// -------------------- Init --------------------
function initApp1() {
    // Hookup field/special buttons
    const addFieldBtn = document.getElementById("addFieldBtn");
    if (addFieldBtn) addFieldBtn.onclick = addField;
    const fieldInput = document.getElementById("fieldInput");
    if (fieldInput) fieldInput.addEventListener("keyup", e => { if (e.key === "Enter") addField(); });

    const addSpecialBtn = document.getElementById("addSpecialBtn");
    if (addSpecialBtn) addSpecialBtn.onclick = addSpecial;
    const specialInput = document.getElementById("specialInput");
    if (specialInput) specialInput.addEventListener("keyup", e => { if (e.key === "Enter") addSpecial(); });

    // Load all data
    loadData();
    
    // Render all UI components
    updateUnassigned();
    setupDivisionButtons();
    renderFields();
    renderSpecials();
    
    // renderDivisionSkeletonEditor() is called by setupDivisionButtons
}
window.initApp1 = initApp1;


// Expose internal objects
window.getDivisions = () => divisions;
window.getFields = () => fields;
window.getSpecials = () => specialActivities;
