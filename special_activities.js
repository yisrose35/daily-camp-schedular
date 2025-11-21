
// =================================================================
// special_activities.js
//
// UPDATED (CRITICAL SAVE FIX):
// - Removed the local `specialActivities = []` variable.
// - Removed the internal `loadData()` and `saveData()` functions.
// - `initSpecialActivitiesTab` now gets data from
//   `window.getGlobalSpecialActivities()`.
// - All functions that need to save (like `addSpecial`,
//   `renderDetailPane`, etc.) now call
//   `window.saveGlobalSpecialActivities(specialActivities)`
//   to safely save the data via app1.js.
//
// UPDATED (BUG FIX):
// - `renderAllowedBunksControls`:
//   - **FIXED BUG:** Clicking an enabled division chip (in "All" or
//     "Specific" mode) will now correctly disable (unchoose) it.
// =================================================================

(function() {
'use strict';

let specialActivities = []; // This will be a *reference* to the global data
let selectedItemId = null; // e.g., "special-Canteen"

let specialsListEl = null;
let detailPaneEl = null;
let addSpecialInput = null;

/**
 * Main entry point, called by index.html
 */
function initSpecialActivitiesTab() {
    const container = document.getElementById("special_activities");
    if (!container) return;
    
    // --- UPDATED: Load data from app1.js ---
    specialActivities = window.getGlobalSpecialActivities?.() || [];
    
    // Ensure all fields have the new structure (still good to do)
    specialActivities.forEach(s => {
        s.available = s.available !== false;
        s.timeRules = s.timeRules || [];
        s.sharableWith = s.sharableWith || { type: 'not_sharable', divisions: [] };
        s.limitUsage = s.limitUsage || { enabled: false, divisions: {} };
    });
    // --- END UPDATE ---

    // Create the new UI structure
    container.innerHTML = `
        <div style="display: flex; flex-wrap: wrap; gap: 20px;">
            
            <div style="flex: 1; min-width: 300px;">
                
                <h3>Add New Special Activity</h3>
                <div style="display: flex; gap: 10px; margin-bottom: 20px;">
                    <input id="new-special-input" placeholder="New Special (e.g., Canteen)" style="flex: 1;">
                    <button id="add-special-btn">Add Special</button>
                </div>

                <h3>All Special Activities</h3>
                <div id="specials-master-list" class="master-list"></div>
            </div>

            <div style="flex: 2; min-width: 400px; position: sticky; top: 20px;">
                <h3>Details</h3>
                <div id="specials-detail-pane" class="detail-pane">
                    <p class="muted">Select a special activity from the left to edit its details.</p>
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
    specialsListEl = document.getElementById("specials-master-list");
    detailPaneEl = document.getElementById("specials-detail-pane");
    addSpecialInput = document.getElementById("new-special-input");

    // Hook up "Add" buttons
    document.getElementById("add-special-btn").onclick = addSpecial;
    addSpecialInput.onkeyup = (e) => { if (e.key === "Enter") addSpecial(); };

    // Initial render
    renderMasterLists();
    renderDetailPane();
}

// --- REMOVED loadData() function ---
// --- REMOVED saveData() function ---

/**
 * Renders the left-hand list of specials
 */
function renderMasterLists() {
    specialsListEl.innerHTML = "";

    if (specialActivities.length === 0) {
        specialsListEl.innerHTML = `<p class="muted">No special activities created yet.</p>`;
    }
    specialActivities.forEach(item => {
        specialsListEl.appendChild(createMasterListItem('special', item));
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
        window.saveGlobalSpecialActivities(specialActivities); // --- UPDATED ---
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
        detailPaneEl.innerHTML = `<p class="muted">Select a special activity from the left to edit its details.</p>`;
        return;
    }

    const [type, name] = selectedItemId.split(/-(.+)/);
    const item = specialActivities.find(f => f.name === name);

    if (!item) {
        selectedItemId = null;
        detailPaneEl.innerHTML = `<p style="color: red;">Error: Could not find item. Please select another.</p>`;
        return;
    }
    
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
        window.saveGlobalSpecialActivities(specialActivities); // --- UPDATED ---
        renderMasterLists(); // Re-render lists to show new name
    });
    
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.style.background = '#c0392b';
    deleteBtn.style.color = 'white';
    deleteBtn.onclick = () => {
        if (confirm(`Are you sure you want to delete "${item.name}"?`)) {
            specialActivities = specialActivities.filter(s => s.name !== item.name);
            selectedItemId = null;
            window.saveGlobalSpecialActivities(specialActivities); // --- UPDATED ---
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
    
    // --- 3. Sharable, Limit, and Time Rules ---
    const onSave = () => window.saveGlobalSpecialActivities(specialActivities); // --- UPDATED ---
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

// --- Add Special Function ---
function addSpecial() {
    const n = addSpecialInput.value.trim();
    if (!n) return;
    if (specialActivities.some(s => s.name.toLowerCase() === n.toLowerCase())) {
        alert("A special activity with this name already exists.");
        return;
    }
    specialActivities.push({
        name: n,
        available: true,
        sharableWith: { type: 'not_sharable', divisions: [] },
        limitUsage: { enabled: false, divisions: {} },
        timeRules: []
    });
    addSpecialInput.value = "";
    window.saveGlobalSpecialActivities(specialActivities); // --- UPDATED ---
    selectedItemId = `special-${n}`; // Auto-select new item
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
            
            // --- THIS IS THE FIX ---
            divChip.onclick = () => {
                if (isAllowed) {
                    // If it IS allowed (in "All" or "Specific" mode),
                    // clicking it again will disable (unchoose) it.
                    delete rules.divisions[divName];
                } else {
                    // If it's NOT allowed, clicking it
                    // enables it for ALL bunks in that division
                    rules.divisions[divName] = []; // Empty array = all bunks
                }
                onSave();
                onRerender();
            };
            // --- END FIX ---
            
            divWrapper.appendChild(divChip);

            // Bunk-level chips (if in bunk-specific mode, i.e., array exists)
            // --- THIS LOGIC IS NOW CORRECT, NO CHANGE NEEDED ---
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
window.initSpecialActivitiesTab = initSpecialActivitiesTab;

})();
