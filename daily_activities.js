
// =================================================================
// special_activities.js
//
// UPDATED (CRITICAL SAVE FIX):
// - Uses window.getGlobalSpecialActivities() / window.saveGlobalSpecialActivities()
//   so data is owned by app1.js.
//
// UPDATED (BUG FIX):
// - renderAllowedBunksControls:
//   - Clicking an enabled division chip correctly disables it.
//
// UPDATED (THEME):
// - Matches Modern Pro Camp theme used in Divisions + Fields:
//   • setup-grid + setup-card shell
//   • Emerald accent in list selection
//   • Soft white cards, light gradients, pill buttons
// =================================================================

(function() {
'use strict';

let specialActivities = []; // reference to global data
let selectedItemId = null;  // e.g., "special-Canteen"

let specialsListEl = null;
let detailPaneEl = null;
let addSpecialInput = null;

/**
 * Main entry point, called by index.html
 */
function initSpecialActivitiesTab() {
    const container = document.getElementById("special_activities");
    if (!container) return;
    
    // --- Load data from app1.js ---
    specialActivities = window.getGlobalSpecialActivities?.() || [];
    
    // Ensure all fields have the structure we expect
    specialActivities.forEach(s => {
        s.available = s.available !== false;
        s.timeRules = s.timeRules || [];
        s.sharableWith = s.sharableWith || { type: 'not_sharable', divisions: [] };
        s.limitUsage = s.limitUsage || { enabled: false, divisions: {} };
    });

    // --- Modern Pro Camp UI shell ---
    container.innerHTML = `
        <div class="setup-grid">
            <section class="setup-card setup-card-wide">
                <div class="setup-card-header">
                    <span class="setup-step-pill">Specials</span>
                    <div class="setup-card-text">
                        <h3>Special Activities &amp; Rotations</h3>
                        <p>
                            Define canteen, trips, electives, and other <strong>special activities</strong>.
                            Control which <strong>divisions/bunks</strong> can use them, and when they
                            are <strong>available</strong> in your daily grid.
                        </p>
                    </div>
                </div>

                <div style="display:flex; flex-wrap:wrap; gap:20px; margin-top:8px;">
                    <!-- LEFT: Specials list + add -->
                    <div style="flex:1; min-width:260px;">
                        <div class="setup-subtitle">All Special Activities</div>
                        <p style="font-size:0.8rem; color:#6b7280; margin-top:4px;">
                            Add each special once (e.g., <strong>Canteen</strong>, <strong>Lake</strong>, 
                            <strong>Trip Bus</strong>). The generator will use these rules when placing
                            specials into your schedule.
                        </p>

                        <div class="setup-field-row" style="margin-top:10px;">
                            <input id="new-special-input"
                                   placeholder="New Special (e.g., Canteen)">
                            <button id="add-special-btn">Add Special</button>
                        </div>

                        <div id="specials-master-list" class="master-list"
                             style="margin-top:10px; max-height:440px; overflow:auto;"></div>
                    </div>

                    <!-- RIGHT: Detail pane -->
                    <div style="flex:1.3; min-width:320px;">
                        <div class="setup-subtitle">Special Details</div>
                        <div id="specials-detail-pane" class="detail-pane"
                             style="margin-top:8px; min-height:360px;">
                            <p class="muted">
                                Select a special from the left to edit:
                                <br>• Whether it’s <strong>available</strong> to the scheduler
                                <br>• Which <strong>divisions/bunks</strong> can use it
                                <br>• If it can be <strong>shared</strong> across divisions
                                <br>• Any <strong>time rules</strong> (e.g., afternoons only)
                            </p>
                        </div>
                    </div>
                </div>
            </section>
        </div>
        
        <style>
            /* Master list container – Modern Pro Camp card shell */
            .master-list {
                border-radius: 18px;
                border: 1px solid #E5E7EB;
                background: #F7F9FA;
                padding: 8px 6px;
                box-shadow: 0 10px 24px rgba(15, 23, 42, 0.04);
            }

            .master-list .list-item {
                padding: 10px 10px;
                border-radius: 14px;
                margin-bottom: 6px;
                cursor: pointer;
                display: flex;
                justify-content: space-between;
                align-items: center;
                background: #FFFFFF;
                border: 1px solid #E5E7EB;
                box-shadow: 0 4px 10px rgba(15, 23, 42, 0.05);
                transition:
                    background 0.15s ease,
                    box-shadow 0.15s ease,
                    transform 0.08s ease,
                    border-color 0.15s ease;
            }
            .master-list .list-item:hover {
                background: #F3F4F6;
                box-shadow: 0 8px 18px rgba(15, 23, 42, 0.10);
                transform: translateY(-1px);
            }
            .master-list .list-item.selected {
                background: radial-gradient(circle at top left, #ECFDF5 0, #FFFFFF 70%);
                border-color: #00C896;
                box-shadow: 0 0 0 1px rgba(0, 200, 150, 0.55);
                font-weight: 600;
            }
            .master-list .list-item-name {
                flex-grow: 1;
                font-size: 0.88rem;
                font-weight: 500;
                color: #111827;
            }
            .master-list .list-item-toggle {
                margin-left: 10px;
            }

            /* Detail pane – aligned with other setup detail panes */
            .detail-pane {
                border-radius: 18px;
                border: 1px solid #E5E7EB;
                padding: 18px 20px;
                background: linear-gradient(135deg, #F7F9FA 0%, #FFFFFF 55%, #F7F9FA 100%);
                box-shadow: 0 18px 40px rgba(15, 23, 42, 0.06);
            }

            .muted {
                color: #6B7280;
                font-size: 0.86rem;
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
        renderDetailPane();  // Re-render detail pane
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
        window.saveGlobalSpecialActivities(specialActivities);
        renderDetailPane(); 
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
    
    detailPaneEl.innerHTML = ""; // Clear
    
    // --- 1. Name & Delete ---
    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    header.style.borderBottom = '2px solid #E5E7EB';
    header.style.paddingBottom = '10px';
    header.style.marginBottom = '15px';
    header.style.columnGap = '12px';
    
    const title = document.createElement('h3');
    title.style.margin = '0';
    title.style.fontSize = '1rem';
    title.style.fontWeight = '600';
    title.style.color = '#111827';
    title.textContent = item.name;
    // Allow renaming
    makeEditable(title, newName => {
        if (!newName.trim()) return;
        item.name = newName;
        selectedItemId = `${type}-${newName}`;
        window.saveGlobalSpecialActivities(specialActivities);
        renderMasterLists();
    });
    
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.style.background = '#FFFFFF';
    deleteBtn.style.color = '#DC2626';
    deleteBtn.style.border = '1px solid #FECACA';
    deleteBtn.style.padding = '6px 14px';
    deleteBtn.style.borderRadius = '999px';
    deleteBtn.style.cursor = 'pointer';
    deleteBtn.style.fontWeight = '600';
    deleteBtn.style.fontSize = '0.85rem';
    deleteBtn.style.boxShadow = '0 4px 10px rgba(220,38,38,0.18)';
    deleteBtn.onmouseenter = () => {
        deleteBtn.style.background = '#FEE2E2';
    };
    deleteBtn.onmouseleave = () => {
        deleteBtn.style.background = '#FFFFFF';
    };
    deleteBtn.onclick = () => {
        if (confirm(`Are you sure you want to delete "${item.name}"?`)) {
            specialActivities = specialActivities.filter(s => s.name !== item.name);
            selectedItemId = null;
            window.saveGlobalSpecialActivities(specialActivities);
            renderMasterLists();
            renderDetailPane();
        }
    };
    header.appendChild(title);
    header.appendChild(deleteBtn);
    detailPaneEl.appendChild(header);
    
    // --- 2. Master Toggle (read-only strip) ---
    const masterToggle = document.createElement('div');
    masterToggle.style.background = item.available ? '#ECFDF5' : '#FEF2F2';
    masterToggle.style.padding = '8px 12px';
    masterToggle.style.borderRadius = '12px';
    masterToggle.style.marginBottom = '15px';
    masterToggle.style.fontSize = '0.8rem';
    masterToggle.style.border = '1px solid ' + (item.available ? '#BBF7D0' : '#FECACA');
    masterToggle.innerHTML = `
        <span>
            This special is currently 
            <strong>${item.available ? 'AVAILABLE' : 'UNAVAILABLE'}</strong>
            to the scheduler.
        </span>
        <span style="opacity:0.75; margin-left:8px;">(Toggle in the list on the left)</span>
    `;
    detailPaneEl.appendChild(masterToggle);
    
    // --- 3. Sharable, Limit, and Time Rules ---
    const onSave = () => window.saveGlobalSpecialActivities(specialActivities);
    const onRerender = renderDetailPane;
    
    const sharableControls = renderSharableControls(item, onSave, onRerender);
    sharableControls.style.borderTop = '1px solid #E5E7EB';
    sharableControls.style.paddingTop = '15px';
    sharableControls.style.marginTop = '15px';
    detailPaneEl.appendChild(sharableControls);
    
    const limitControls = renderAllowedBunksControls(item, onSave, onRerender);
    detailPaneEl.appendChild(limitControls);
    
    const timeRuleControls = renderTimeRulesUI(item, onSave, onRerender);
    timeRuleControls.style.marginTop = "10px";
    timeRuleControls.style.paddingTop = "10px";
    timeRuleControls.style.borderTop = "1px solid #E5E7EB";
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
    window.saveGlobalSpecialActivities(specialActivities);
    selectedItemId = `special-${n}`;
    renderMasterLists();
    renderDetailPane();
}

// =================================================================
// ===== HELPERS (Copied / aligned with other modules) =====
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
        if (hh === 12) hh = mer === "am" ? 0 : 12;
        else if (mer === "pm") hh += 12;
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
        input.onblur = done; 
        input.onkeyup = e => { if (e.key === "Enter") done(); };
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
        divLabel.textContent = "Limit to divisions (if none selected, sharable with all):";
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
// ===== Allowed Bunks Controls =====
// =================================================================

function renderAllowedBunksControls(item, onSave, onRerender) {
    const container = document.createElement("div");
    container.style.marginTop = "10px";
    container.style.paddingTop = "10px";
    container.style.borderTop = "1px solid #eee";
    container.innerHTML = `<strong>Allowed Divisions &amp; Bunks:</strong>`;

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
            
            const divChip = createLimitChip(divName, isAllowed, true);
            
            // Clicking an enabled division disables it; clicking a disabled enables it.
            divChip.onclick = () => {
                if (isAllowed) {
                    delete rules.divisions[divName];
                } else {
                    rules.divisions[divName] = []; // empty array = all bunks
                }
                onSave();
                onRerender();
            };
            
            divWrapper.appendChild(divChip);

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

                if (allowedBunks.length > 0) {
                    const allBunksChip = createLimitChip(`All ${divName}`, false, false);
                    allBunksChip.style.backgroundColor = "#f0f0f0";
                    allBunksChip.style.color = "#007BFF";
                    allBunksChip.style.borderColor = "#007BFF";
                    allBunksChip.onclick = () => {
                        rules.divisions[divName] = [];
                        onSave();
                        onRerender();
                    };
                    bunkList.appendChild(allBunksChip);
                }

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
    const activeBG = isDivision ? "#007BFF" : "#5bc0de";
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
