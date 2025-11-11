// =================================================================
// fields.js
//
// UPDATED (CRITICAL SAVE FIX):
// - Removed the local `fields = []` variable.
// - Removed the internal `loadData()` and `saveData()` functions.
//   These were causing the data overwrite bug.
// - `initFieldsTab` now gets its data from `window.getGlobalFields()`.
// - All functions that need to save (like `addField`,
//   `renderDetailPane`, etc.) now call `window.saveGlobalFields(fields)`
//   to safely save the data via app1.js.
// =================================================================

(function() {
'use strict';

let fields = []; // This will be a *reference* to the global data
let selectedItemId = null; // e.g., "field-Court 1"

let fieldsListEl = null;
let detailPaneEl = null;
let addFieldInput = null;

/**
 * Main entry point, called by index.html
 */
function initFieldsTab() {
    const container = document.getElementById("fields");
    if (!container) return;
    
    // --- UPDATED: Load data from app1.js ---
    fields = window.getGlobalFields?.() || [];
    
    // Ensure all fields have the new structure (still good to do)
    fields.forEach(f => {
        f.available = f.available !== false;
        f.timeRules = f.timeRules || [];
        f.sharableWith = f.sharableWith || { type: 'not_sharable', divisions: [] };
        f.limitUsage = f.limitUsage || { enabled: false, divisions: {} };
    });
    // --- END UPDATE ---

    // Create the new UI structure
    container.innerHTML = `
        <div style="display: flex; flex-wrap: wrap; gap: 20px;">
            
            <div style="flex: 1; min-width: 300px;">
                
                <h3>Add New Field</h3>
                <div style="display: flex; gap: 10px; margin-bottom: 20px;">
                    <input id="new-field-input" placeholder="New Field (e.g., Court 1)" style="flex: 1;">
                    <button id="add-field-btn">Add Field</button>
                </div>

                <h3>All Fields</h3>
                <div id="fields-master-list" class="master-list"></div>
            </div>

            <div style="flex: 2; min-width: 400px; position: sticky; top: 20px;">
                <h3>Details</h3>
                <div id="fields-detail-pane" class="detail-pane">
                    <p class="muted">Select a field from the left to edit its details.</p>
                </div>
            </div>
        </div>
        
        <style>
            .master-list .list-item {
                padding: 12px 10px;
                border: 1px solid #ddd;
                border-radius: 5px;
                margin-bottom: 5px;
                cursor: pointer;
                display: flex;
                justify-content: space-between;
                align-items: center;
                background: #fff;
            }
            .master-list .list-item:hover {
                background: #f9f9f9;
            }
            .master-list .list-item.selected {
                background: #e7f3ff;
                border-color: #007bff;
                font-weight: 600;
            }
            .master-list .list-item-name {
                flex-grow: 1;
            }
            .master-list .list-item-toggle {
                margin-left: 10px;
            }
            .detail-pane {
                border: 1px solid #ccc;
                border-radius: 8px;
                padding: 20px;
                background: #fdfdfd;
                min-height: 400px;
            }
        </style>
    `;

    // Get element references
    fieldsListEl = document.getElementById("fields-master-list");
    detailPaneEl = document.getElementById("fields-detail-pane");
    addFieldInput = document.getElementById("new-field-input");

    // Hook up "Add" buttons
    document.getElementById("add-field-btn").onclick = addField;
    addFieldInput.onkeyup = (e) => { if (e.key === "Enter") addField(); };

    // Initial render
    renderMasterLists();
    renderDetailPane();
}

// --- REMOVED loadData() function ---
// --- REMOVED saveData() function ---

/**
 * Renders the left-hand list of fields
 */
function renderMasterLists() {
    fieldsListEl.innerHTML = "";

    if (fields.length === 0) {
        fieldsListEl.innerHTML = `<p class="muted">No fields created yet.</p>`;
    }
    fields.forEach(item => {
        fieldsListEl.appendChild(createMasterListItem('field', item));
    });
}

/**
 * Creates a single item for the left-hand list
 */
function createMasterListItem(type, item) {
    const el = document.createElement('div');
    el.className = 'list-item';
    const id = `${type}-${item.name}`;
    if (id === selectedItemId) {
        el.classList.add('selected');
    }
    
    el.onclick = () => {
        selectedItemId = id;
        renderMasterLists(); // Re-render lists to update selection
        renderDetailPane(); // Re-render detail pane
    };

    const nameEl = document.createElement('span');
    nameEl.className = 'list-item-name';
    nameEl.textContent = item.name;
    el.appendChild(nameEl);

    // Master available toggle
    const tog = document.createElement("label"); 
    tog.className = "switch list-item-toggle";
    tog.title = "Available (Master)";
    tog.onclick = (e) => e.stopPropagation(); // Prevent selection
    
    const cb = document.createElement("input"); 
    cb.type = "checkbox"; 
    cb.checked = item.available;
    cb.onchange = (e) => { 
        e.stopPropagation();
        item.available = cb.checked; 
        window.saveGlobalFields(fields); // --- UPDATED ---
        renderDetailPane(); // Re-render details if this item is selected
    };
    
    const sl = document.createElement("span"); 
    sl.className = "slider";
    
    tog.appendChild(cb); 
    tog.appendChild(sl);
    el.appendChild(tog);

    return el;
}

/**
 * Renders the right-hand detail pane for the selected item
 */
function renderDetailPane() {
    if (!selectedItemId) {
        detailPaneEl.innerHTML = `<p class="muted">Select a field from the left to edit its details.</p>`;
        return;
    }

    const [type, name] = selectedItemId.split(/-(.+)/); // Splits on first dash
    const item = fields.find(f => f.name === name);

    if (!item) {
        selectedItemId = null;
        detailPaneEl.innerHTML = `<p style="color: red;">Error: Could not find item. Please select another.</p>`;
        return;
    }
    
    const allSports = window.getAllGlobalSports?.() || [];

    // Build the inner HTML for the pane
    detailPaneEl.innerHTML = ""; // Clear
    
    // --- 1. Name & Delete ---
    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    header.style.borderBottom = '2px solid #eee';
    header.style.paddingBottom = '10px';
    header.style.marginBottom = '15px';
    
    const title = document.createElement('h3');
    title.style.margin = '0';
    title.textContent = item.name;
    // Allow renaming
    makeEditable(title, newName => {
        if (!newName.trim()) return;
        item.name = newName;
        selectedItemId = `${type}-${newName}`; // Update selected ID
        window.saveGlobalFields(fields); // --- UPDATED ---
        renderMasterLists(); // Re-render lists to show new name
    });
    
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.style.background = '#c0392b';
    deleteBtn.style.color = 'white';
    deleteBtn.onclick = () => {
        if (confirm(`Are you sure you want to delete "${item.name}"?`)) {
            fields = fields.filter(f => f.name !== item.name);
            selectedItemId = null;
            window.saveGlobalFields(fields); // --- UPDATED ---
            renderMasterLists();
            renderDetailPane();
        }
    };
    header.appendChild(title);
    header.appendChild(deleteBtn);
    detailPaneEl.appendChild(header);
    
    // --- 2. Master Toggle (read-only, controlled from list) ---
    const masterToggle = document.createElement('div');
    masterToggle.style.background = item.available ? '#e8f5e9' : '#fbe9e7';
    masterToggle.style.padding = '10px';
    masterToggle.style.borderRadius = '5px';
    masterToggle.style.marginBottom = '15px';
    masterToggle.textContent = `This item is globally ${item.available ? 'AVAILABLE' : 'UNAVAILABLE'}. (Toggle in list view)`;
    detailPaneEl.appendChild(masterToggle);

    // --- 3. Activities ---
    const actSection = document.createElement('div');
    actSection.innerHTML = `<strong>Activities on this field:</strong>`;
    
    const bw = document.createElement("div"); 
    bw.style.marginTop = "8px";
    bw.style.display = 'flex';
    bw.style.flexWrap = 'wrap';
    bw.style.gap = '5px';
    
    allSports.forEach(act => {
        const b = document.createElement("button"); 
        b.textContent = act; 
        b.className = "activity-button";
        if (item.activities.includes(act)) b.classList.add("active");
        b.onclick = () => {
            if (item.activities.includes(act)) item.activities = item.activities.filter(a => a !== act);
            else item.activities.push(act);
            window.saveGlobalFields(fields); // --- UPDATED ---
            renderDetailPane(); // Just re-render this pane
        };
        bw.appendChild(b);
    });
    
    const other = document.createElement("input");
    other.placeholder = "Add new sport type";
    other.style.marginTop = '5px';
    other.onkeyup = e => {
        if (e.key === "Enter" && other.value.trim()) {
            const newSport = other.value.trim();
            window.addGlobalSport?.(newSport); // Add to global list
            if (!item.activities.includes(newSport)) {
                item.activities.push(newSport);
            }
            window.saveGlobalFields(fields); // --- UPDATED ---
            other.value = "";
            renderDetailPane();
        }
    };
    
    actSection.appendChild(bw);
    actSection.appendChild(other);
    detailPaneEl.appendChild(actSection);

    // --- 4. Sharable, Limit, and Time Rules ---
    const onSave = () => window.saveGlobalFields(fields); // --- UPDATED ---
    const onRerender = renderDetailPane;
    
    const sharableControls = renderSharableControls(item, onSave, onRerender);
    sharableControls.style.borderTop = '1px solid #eee';
    sharableControls.style.paddingTop = '15px';
    sharableControls.style.marginTop = '15px';
    detailPaneEl.appendChild(sharableControls);
    
    const limitControls = renderAllowedBunksControls(item, onSave, onRerender);
    detailPaneEl.appendChild(limitControls);
    
    const timeRuleControls = renderTimeRulesUI(item, onSave, onRerender);
    timeRuleControls.style.marginTop = "10px";
    timeRuleControls.style.paddingTop = "10px";
    timeRuleControls.style.borderTop = "1px solid #eee";
    detailPaneEl.appendChild(timeRuleControls);
}

// --- Add Field Function ---
function addField() {
    const n = addFieldInput.value.trim();
    if (!n) return;
    if (fields.some(f => f.name.toLowerCase() === n.toLowerCase())) {
        alert("A field with this name already exists.");
        return;
    }
    fields.push({
        name: n,
        activities: [],
        available: true,
        sharableWith: { type: 'not_sharable', divisions: [] },
        limitUsage: { enabled: false, divisions: {} },
        timeRules: []
    });
    addFieldInput.value = "";
    window.saveGlobalFields(fields); // --- UPDATED ---
    selectedItemId = `field-${n}`; // Auto-select new item
    renderMasterLists();
    renderDetailPane();
}

// =================================================================
// ===== HELPERS (Copied from app1.js) =====
// =================================================================

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

function renderTimeRulesUI(item, onSave, onRerender) {
    const container = document.createElement("div");
    container.style.marginTop = "10px";
    container.style.paddingLeft = "15px";
    container.style.borderLeft = "3px solid #eee";
    container.innerHTML = `<strong>Global Time Rules:</strong>`;

    if (!item.timeRules) {
        item.timeRules = [];
    }

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
        removeBtn.onclick = () => {
            item.timeRules.splice(index, 1);
            onSave();
            onRerender();
        };
        
        ruleEl.appendChild(ruleType);
        ruleEl.appendChild(ruleText);
        ruleEl.appendChild(removeBtn);
        ruleList.appendChild(ruleEl);
    });
    container.appendChild(ruleList);

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
            alert("Please enter a start and end time."); return;
        }
        if (parseTimeToMinutes(start) == null || parseTimeToMinutes(end) == null) {
            alert("Invalid time format. Use '9:00am' or '2:30pm'."); return;
        }
        if (parseTimeToMinutes(start) >= parseTimeToMinutes(end)) {
            alert("End time must be after start time."); return;
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

function renderSharableControls(item, onSave, onRerender) {
    const container = document.createElement("div");
    container.innerHTML = `<strong>Sharing Rules:</strong>`;
    const rules = item.sharableWith || { type: 'not_sharable' };
    const isSharable = rules.type !== 'not_sharable';

    const tog = document.createElement("label");
    tog.className = "switch";
    tog.title = "Toggle Sharable";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = isSharable;
    cb.onchange = () => {
        if (cb.checked) { rules.type = 'all'; } 
        else { rules.type = 'not_sharable'; }
        rules.divisions = [];
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
    shareWrap.style.marginTop = '5px';
    shareWrap.appendChild(tog);
    shareWrap.appendChild(togLabel);
    container.appendChild(shareWrap);

    if (isSharable) {
        const customPanel = document.createElement("div");
        customPanel.style.paddingLeft = "20px";
        customPanel.style.marginTop = "10px";
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
            if (idx > -1) { selectedItems.splice(idx, 1); } 
            else { selectedItems.push(name); }
            onToggle();
        };
        chipBox.appendChild(chip);
    });
    return chipBox;
}

// =================================================================
// ===== NEW: Allowed Bunks Controls (replaces LimitUsage) =====
// =================================================================

function renderAllowedBunksControls(item, onSave, onRerender) {
    const container = document.createElement("div");
    container.style.marginTop = "10px";
    container.style.paddingTop = "10px";
    container.style.borderTop = "1px solid #eee";
    container.innerHTML = `<strong>Allowed Divisions & Bunks:</strong>`;

    if (!item.limitUsage) {
        item.limitUsage = { enabled: false, divisions: {} };
    }
    const rules = item.limitUsage;

    // --- 1. "All Divisions" vs "Specific" Toggle ---
    const modeLabel = document.createElement("label");
    modeLabel.style.display = "flex";
    modeLabel.style.alignItems = "center";
    modeLabel.style.gap = "10px";
    modeLabel.style.cursor = "pointer";
    modeLabel.style.marginTop = '5px';

    const textAll = document.createElement("span");
    textAll.textContent = "All Divisions";
    const toggleTrack = document.createElement("span");
    Object.assign(toggleTrack.style, {
        "width": "44px", "height": "24px", "borderRadius": "99px", "position": "relative",
        "display": "inline-block", "border": "1px solid #ccc",
        "backgroundColor": rules.enabled ? '#d1d5db' : '#22c55e',
        "transition": "background-color 0.2s"
    });
    const toggleKnob = document.createElement("span");
    Object.assign(toggleKnob.style, {
        "width": "20px", "height": "20px", "borderRadius": "50%", "backgroundColor": "white",
        "position": "absolute", "top": "1px", "left": rules.enabled ? '21px' : '1px',
        "transition": "left 0.2s"
    });
    toggleTrack.appendChild(toggleKnob);
    const textLimit = document.createElement("span");
    textLimit.textContent = "Specific Divisions/Bunks";
    
    textAll.style.fontWeight = rules.enabled ? 'normal' : 'bold';
    textLimit.style.fontWeight = rules.enabled ? 'bold' : 'normal';
    
    modeLabel.onclick = () => {
        rules.enabled = !rules.enabled;
        onSave();
        onRerender();
    };
    modeLabel.appendChild(textAll);
    modeLabel.appendChild(toggleTrack);
    modeLabel.appendChild(textLimit);
    container.appendChild(modeLabel);

    // --- 2. Panel for "Specific" rules ---
    if (rules.enabled) {
        const customPanel = document.createElement("div");
        customPanel.style.paddingLeft = "20px";
        customPanel.style.marginTop = "10px";
        customPanel.style.borderLeft = "3px solid #eee";
        
        const allDivisions = window.availableDivisions || [];
        if (allDivisions.length === 0) {
            customPanel.innerHTML += `<p class="muted">No divisions found. Add divisions in Setup.</p>`;
        }

        allDivisions.forEach(divName => {
            const divWrapper = document.createElement("div");
            divWrapper.style.marginTop = "8px";
            
            const isAllowed = divName in rules.divisions;
            const allowedBunks = rules.divisions[divName] || [];
            
            // Division-level chip
            const divChip = createLimitChip(divName, isAllowed, true);
            divChip.onclick = () => {
                if (isAllowed) {
                    const bunksInDiv = (window.divisions[divName]?.bunks || []);
                    if (bunksInDiv.length > 0 && allowedBunks.length === 0) { 
                        rules.divisions[divName] = []; 
                    } else {
                        delete rules.divisions[divName];
                    }
                } else {
                    rules.divisions[divName] = []; // Empty array = all bunks
                }
                onSave();
                onRerender();
            };
            divWrapper.appendChild(divChip);

            // Bunk-level chips (if in bunk-specific mode, i.e., array exists)
            if (isAllowed) {
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

                // "All" button (only show if in bunk-specific mode)
                if (allowedBunks.length > 0) {
                    const allBunksChip = createLimitChip(`All ${divName}`, false, false);
                    allBunksChip.style.backgroundColor = "#f0f0f0";
                    allBunksChip.style.color = "#007BFF";
                    allBunksChip.style.borderColor = "#007BFF";
                    allBunksChip.onclick = () => {
                        rules.divisions[divName] = []; // Set to empty array for "all"
                        onSave();
                        onRerender();
                    };
                    bunkList.appendChild(allBunksChip);
                }

                // Individual bunk chips
                bunksInDiv.forEach(bunkName => {
                    const bunkChip = createLimitChip(bunkName, allowedBunks.includes(bunkName), false);
                    bunkChip.onclick = () => {
                        const bunkIdx = allowedBunks.indexOf(bunkName);
                        if (bunkIdx > -1) {
                            allowedBunks.splice(bunkIdx, 1);
                        } else {
                            allowedBunks.push(bunkName);
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


function createLimitChip(name, isActive, isDivision = true) {
    const chip = document.createElement("span");
    chip.textContent = name;
    chip.style.padding = "4px 8px";
    chip.style.borderRadius = "12px";
    chip.style.cursor = "pointer";
    chip.style.border = "1px solid #ccc";
    chip.style.fontSize = isDivision ? "0.95em" : "0.9em";
    const activeBG = isDivision ? "#007BFF" : "#5bc0de"; // Blue for division, teal for bunk
    const activeColor = "white";
    const inactiveBG = isDivision ? "#f0f0f0" : "#f9f9f9";
    const inactiveColor = "black";
    chip.style.backgroundColor = isActive ? activeBG : inactiveBG;
    chip.style.color = isActive ? activeColor : inactiveColor;
    chip.style.borderColor = isActive ? activeBG : (isDivision ? "#ccc" : "#ddd");
    return chip;
}

// Expose the init function
window.initFieldsTab = initFieldsTab;

})();
