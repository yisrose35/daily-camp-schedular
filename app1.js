// =================================================================
// app1.js
//
// UPDATED:
// - **CRITICAL FIX (Syntax Error)**: Added the correct IIFE opener
//   at the top to match the existing `})();` at the end.
// - Guarded the `enableColor` event listener to avoid null crashes.
// - Keeps previous fixes for "Add Bunk/Division" and Time Rules UI.
// =================================================================

;(function () {
'use strict';

// -------------------- State --------------------
let bunks = [];
let divisions = {}; // { divName:{ bunks:[], color, timeline: {start, end} } }

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
    const name = (i?.value || "").trim();
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
    if (!c) return;
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
    const name = (i?.value || "").trim();
    if (name === "") return;

    if (!availableDivisions.includes(name)) {
        const color = defaultColors[colorIndex % defaultColors.length]; colorIndex++;

        availableDivisions.push(name);
        window.availableDivisions = availableDivisions; // Update global

        // NEW: Simplified division object
        divisions[name] = { 
            bunks: [], 
            color,
            timeline: { start: "9:00 AM", end: "4:00 PM" } // Add timeline
        };
        
        window.divisions = divisions; // keep global in sync

        if (i) i.value = "";
        saveData();
        setupDivisionButtons();
        window.initLeaguesTab?.(); 
        window.updateTable?.();
        renderDivisionTimelineEditor(); // NEW
    }
}

function setupDivisionButtons() {
    const cont = document.getElementById("divisionButtons");
    if (!cont) return;
    cont.innerHTML = "";

    const colorEnabled = !!document.getElementById("enableColor")?.checked;

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
            
            // NEW: Render timeline editor for the selected division
            renderDivisionTimelineEditor();
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
            renderDivisionTimelineEditor(); // NEW
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
    renderDivisionTimelineEditor();
}

// Guard the enableColor listener (prevents crash if element doesn't exist yet)
const enableColorEl = document.getElementById("enableColor");
if (enableColorEl) enableColorEl.addEventListener("change", setupDivisionButtons);

// -------------------- (REPLACED) NEW: Division Timeline Editor --------------------
// This function replaces renderDivisionSkeletonEditor
function renderDivisionTimelineEditor() {
    const container = document.getElementById("divisionTimelineEditor");
    if (!container) return;

    if (!selectedDivision) {
        container.innerHTML = `<p style="color: #666;">Select a division to set its timeline.</p>`;
        return;
    }

    const data = divisions[selectedDivision];
    if (!data) {
        container.innerHTML = `<p style="color: #c00;">Error: Could not find data for ${selectedDivision}.</p>`;
        return;
    }
    
    // Ensure data structure is initialized
    data.timeline = data.timeline || { start: "9:00 AM", end: "4:00 PM" };

    container.innerHTML = `
        <div style="border: 1px solid #ddd; border-radius: 8px; padding: 15px;">
            <h4 style="margin-top: 0; margin-bottom: 15px;">Timeline for ${selectedDivision}</h4>
            
            <label>Start Time:</label>
            <input type="text" value="${data.timeline.start}" data-key="timeline.start" class="timeline-input">
            <label style="margin-left: 10px;">End Time:</label>
            <input type="text" value="${data.timeline.end}" data-key="timeline.end" class="timeline-input">
        </div>
    `;

    // --- Add Event Listeners ---
    container.querySelectorAll('.timeline-input').forEach(input => {
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
}

// -------------------- Fields / Specials (Restored) --------------------

// --- START OF NEW TIME RULE UI ---
/**
 * Renders the new, simplified "Time Rules" UI.
 * This replaces the old `renderAvailabilityControls`.
 */
function renderTimeRulesUI(item, onSave, onRerender) {
    const container = document.createElement("div");
    container.style.marginTop = "10px";
    container.style.paddingLeft = "15px";
    container.style.borderLeft = "3px solid #eee";

    if (!item.timeRules) {
        item.timeRules = [];
    }

    // --- 1. Rule List ---
    const ruleList = document.createElement("div");
    if (item.timeRules.length === 0) {
        ruleList.innerHTML = `<p class="muted" style="margin: 0;">No specific time rules. (Available all day)</p>`;
    }

    item.timeRules.forEach((rule, index) => {
        const ruleEl = document.createElement("div");
        ruleEl.style.margin = "2px 0";
        ruleEl.style.padding = "4px";
        ruleEl.style.background = "#f4f4f4";
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
        
        // --- THIS IS THE FIX ---
        removeBtn.onclick = () => {
            item.timeRules.splice(index, 1);
            onSave();
            onRerender();
        };
        // --- END OF FIX ---
        
        ruleEl.appendChild(ruleType);
        ruleEl.appendChild(ruleText);
        ruleEl.appendChild(removeBtn);
        ruleList.appendChild(ruleEl);
    });
    container.appendChild(ruleList);

    // --- 2. Add New Rule Form ---
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
    addBtn.textContent = "Add Rule";
    addBtn.style.marginLeft = "8px";
    
    addBtn.onclick = () => {
        const type = typeSelect.value;
        const start = startInput.value;
        const end = endInput.value;
        
        if (!start || !end) {
            alert("Please enter a start and end time.");
            return;
        }
        if (parseTimeToMinutes(start) == null || parseTimeToMinutes(end) == null) {
            alert("Invalid time format. Use '9:00am' or '2:30pm'.");
            return;
        }
        if (parseTimeToMinutes(start) >= parseTimeToMinutes(end)) {
            alert("End time must be after start time.");
            return;
        }

        item.timeRules.push({ type, start, end });
        onSave();
        onRerender();
    };

    addContainer.appendChild(typeSelect);
    addContainer.appendChild(startInput);
    addContainer.appendChild(toLabel);
    addContainer.appendChild(endInput);
    addContainer.appendChild(addBtn);
    container.appendChild(addContainer);

    return container;
}
// --- END OF NEW TIME RULE UI ---

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
        width: "44px",
        height: "24px",
        borderRadius: "99px",
        position: "relative",
        display: "inline-block",
        border: "1px solid #ccc",
        backgroundColor: rules.enabled ? '#d1d5db' : '#22c55e', // Grey for "Limit", Green for "All"
        transition: "background-color 0.2s"
    });

    const toggleKnob = document.createElement("span");
    Object.assign(toggleKnob.style, {
        width: "20px",
        height: "20px",
        borderRadius: "50%",
        backgroundColor: "white",
        position: "absolute",
        top: "1px",
        left: rules.enabled ? '21px' : '1px', // Right for "Limit", Left for "All"
        transition: "left 0.2s"
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
            timeRules: [] // <-- NEW
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
        
        // --- NEW: Use new Time Rule UI ---
        const timeRuleControls = renderTimeRulesUI(f, saveData, renderFields);
        timeRuleControls.style.marginTop = "10px";
        timeRuleControls.style.paddingTop = "10px";
        timeRuleControls.style.borderTop = "1px solid #eee";
        w.appendChild(timeRuleControls);
        
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
            timeRules: [] // <-- NEW
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

        // --- NEW: Use new Time Rule UI ---
        const timeRuleControls = renderTimeRulesUI(s, saveData, renderSpecials);
        timeRuleControls.style.marginTop = "10px";
        timeRuleControls.style.paddingTop = "10px";
        timeRuleControls.style.borderTop = "1px solid #eee";
        w.appendChild(timeRuleControls);
        
        c.appendChild(w);
    });
}
// --- END OF RESTORED FIELD/SPECIAL FUNCTIONS ---


// -------------------- Local Storage (UPDATED) --------------------
function saveData() {
    const data = { 
        bunks, 
        divisions, 
        availableDivisions, 
        selectedDivision, 
        fields, 
        specialActivities, 
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
        
        // NEW: Ensure timeline exists on all divisions
        availableDivisions.forEach(divName => {
            if (divisions[divName]) {
                divisions[divName].timeline = divisions[divName].timeline || { start: "9:00 AM", end: "4:00 PM" };
                
                // One-time migration from old "divisionSkeletons"
                if (data.divisionSkeletons && data.divisionSkeletons[divName]) {
                    divisions[divName].timeline = data.divisionSkeletons[divName].timeline;
                }
            }
        });
        
        window.divisions = divisions;
        window.availableDivisions = availableDivisions;
        selectedDivision = data.selectedDivision || null;
        fields = data.fields || [];
        specialActivities = data.specialActivities || [];
        
        // --- NEW: Normalize fields/specials to use `timeRules` ---
        fields.forEach(f => {
            f.available = f.available !== false;
            f.sharableWith = f.sharableWith || { type: 'not_sharable' };
            f.sharableWith.divisions = f.sharableWith.divisions || [];
            f.limitUsage = f.limitUsage || { enabled: false, divisions: {} };
            f.timeRules = f.timeRules || []; // Add new property
            // One-time migration from old system
            if (f.availabilityMode) {
                if (f.availabilityMode === 'unavailable' && (!f.availabilityExceptions || f.availabilityExceptions.length === 0)) {
                    f.available = false; // Master toggle is off
                }
                if (f.availabilityExceptions && f.availabilityExceptions.length > 0) {
                    const type = f.availabilityMode === 'available' ? 'Unavailable' : 'Available';
                    f.availabilityExceptions.forEach(rangeStr => {
                        const parts = rangeStr.split('-');
                        if(parts.length === 2) {
                            f.timeRules.push({ type: type, start: parts[0], end: parts[1] });
                        }
                    });
                }
                delete f.availabilityMode;
                delete f.availabilityExceptions;
            }
        });
        specialActivities.forEach(s => {
            s.available = s.available !== false;
            s.sharableWith = s.sharableWith || { type: 'not_sharable' };
            s.sharableWith.divisions = s.sharableWith.divisions || [];
            s.limitUsage = s.limitUsage || { enabled: false, divisions: {} };
            s.timeRules = s.timeRules || []; // Add new property
            // One-time migration
            if (s.availabilityMode) {
                if (s.availabilityMode === 'unavailable' && (!s.availabilityExceptions || s.availabilityExceptions.length === 0)) {
                    s.available = false;
                }
                if (s.availabilityExceptions && s.availabilityExceptions.length > 0) {
                    const type = s.availabilityMode === 'available' ? 'Unavailable' : 'Available';
                    s.availabilityExceptions.forEach(rangeStr => {
                        const parts = rangeStr.split('-');
                        if(parts.length === 2) {
                            s.timeRules.push({ type: type, start: parts[0], end: parts[1] });
                        }
                    });
                }
                delete s.availabilityMode;
                delete s.availabilityExceptions;
            }
        });
        
    } catch (e) { console.error("Error loading data:", e); }
}

// -------------------- Init --------------------
/**
 * --- UPDATED: initApp1 ---
 * Restored the missing event listeners.
 */
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
    
    // renderDivisionTimelineEditor() is called by setupDivisionButtons
}
window.initApp1 = initApp1;

// Expose internal objects
window.getDivisions = () => divisions;
window.getFields = () => fields;
window.getSpecials = () => specialActivities;

})();
