// =================================================================
// fields.js
//
// UPDATED:
// - Added "Priority & Preferences" UI.
// - Allows defining an ordered list of divisions.
// - Allows toggling "Exclusive" mode.
// =================================================================

(function() {
'use strict';

let fields = [];
let selectedItemId = null; 

let fieldsListEl = null;
let detailPaneEl = null;
let addFieldInput = null;

function initFieldsTab() {
    const container = document.getElementById("fields");
    if (!container) return;
    
    loadData();

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
    `;

    fieldsListEl = document.getElementById("fields-master-list");
    detailPaneEl = document.getElementById("fields-detail-pane");
    addFieldInput = document.getElementById("new-field-input");

    document.getElementById("add-field-btn").onclick = addField;
    addFieldInput.onkeyup = (e) => { if (e.key === "Enter") addField(); };

    renderMasterLists();
    renderDetailPane();
}

function loadData() {
    const app1Data = window.loadGlobalSettings?.().app1 || {};
    fields = app1Data.fields || [];
    
    // Ensure structure
    fields.forEach(f => {
        f.available = f.available !== false;
        f.timeRules = f.timeRules || [];
        f.sharableWith = f.sharableWith || { type: 'not_sharable', divisions: [] };
        f.limitUsage = f.limitUsage || { enabled: false, divisions: {} };
        // NEW: Preferences structure
        f.preferences = f.preferences || { enabled: false, exclusive: false, list: [] };
    });
}

function saveData() {
    const app1Data = window.loadGlobalSettings?.().app1 || {};
    app1Data.fields = fields;
    window.saveGlobalSettings?.("app1", app1Data);
}

function renderMasterLists() {
    fieldsListEl.innerHTML = "";
    if (fields.length === 0) fieldsListEl.innerHTML = `<p class="muted">No fields created yet.</p>`;
    fields.forEach(item => {
        fieldsListEl.appendChild(createMasterListItem('field', item));
    });
}

function createMasterListItem(type, item) {
    const el = document.createElement('div');
    el.className = 'list-item';
    const id = `${type}-${item.name}`;
    if (id === selectedItemId) el.classList.add('selected');
    
    el.onclick = () => {
        selectedItemId = id;
        renderMasterLists();
        renderDetailPane();
    };

    const nameEl = document.createElement('span');
    nameEl.className = 'list-item-name';
    nameEl.textContent = item.name;
    el.appendChild(nameEl);

    const tog = document.createElement("label"); 
    tog.className = "switch list-item-toggle";
    tog.title = "Available (Master)";
    tog.onclick = (e) => e.stopPropagation();
    
    const cb = document.createElement("input"); 
    cb.type = "checkbox"; 
    cb.checked = item.available;
    cb.onchange = (e) => { 
        e.stopPropagation();
        item.available = cb.checked; 
        saveData(); 
        renderDetailPane(); 
    };
    
    const sl = document.createElement("span"); 
    sl.className = "slider";
    tog.appendChild(cb); tog.appendChild(sl);
    el.appendChild(tog);

    return el;
}

function renderDetailPane() {
    if (!selectedItemId) {
        detailPaneEl.innerHTML = `<p class="muted">Select a field from the left to edit its details.</p>`;
        return;
    }

    const [type, name] = selectedItemId.split(/-(.+)/);
    const item = fields.find(f => f.name === name);

    if (!item) {
        selectedItemId = null;
        detailPaneEl.innerHTML = `<p style="color: red;">Error: Could not find item.</p>`;
        return;
    }
    
    const allSports = window.getAllGlobalSports?.() || [];

    detailPaneEl.innerHTML = "";
    
    // 1. Header
    const header = document.createElement('div');
    header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid #eee; padding-bottom:10px; margin-bottom:15px;';
    const title = document.createElement('h3');
    title.style.margin = '0';
    title.textContent = item.name;
    makeEditable(title, newName => {
        if (!newName.trim()) return;
        item.name = newName;
        selectedItemId = `${type}-${newName}`;
        saveData();
        renderMasterLists();
    });
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.style.cssText = 'background:#c0392b; color:white; border:none; padding:6px 12px; border-radius:4px; cursor:pointer;';
    deleteBtn.onclick = () => {
        if (confirm(`Delete "${item.name}"?`)) {
            fields = fields.filter(f => f.name !== item.name);
            selectedItemId = null;
            saveData();
            renderMasterLists();
            renderDetailPane();
        }
    };
    header.appendChild(title);
    header.appendChild(deleteBtn);
    detailPaneEl.appendChild(header);
    
    // 2. Activities
    const actSection = document.createElement('div');
    actSection.innerHTML = `<strong>Activities:</strong>`;
    const bw = document.createElement("div"); 
    bw.style.cssText = "margin-top:8px; display:flex; flex-wrap:wrap; gap:5px;";
    allSports.forEach(act => {
        const b = document.createElement("button"); 
        b.textContent = act; 
        b.className = "activity-button";
        if (item.activities.includes(act)) b.classList.add("active");
        b.onclick = () => {
            if (item.activities.includes(act)) item.activities = item.activities.filter(a => a !== act);
            else item.activities.push(act);
            saveData(); renderDetailPane();
        };
        bw.appendChild(b);
    });
    const other = document.createElement("input");
    other.placeholder = "Add new sport...";
    other.style.marginTop = '5px';
    other.onkeyup = e => {
        if (e.key === "Enter" && other.value.trim()) {
            const newSport = other.value.trim();
            window.addGlobalSport?.(newSport);
            if (!item.activities.includes(newSport)) {
                item.activities.push(newSport);
                saveData();
            }
            other.value = "";
            renderDetailPane();
        }
    };
    actSection.appendChild(bw);
    actSection.appendChild(other);
    detailPaneEl.appendChild(actSection);

    // 3. Preferences (NEW)
    const prefControls = renderPreferenceUI(item, saveData, renderDetailPane);
    detailPaneEl.appendChild(prefControls);

    // 4. Sharable
    const sharableControls = renderSharableControls(item, saveData, renderDetailPane);
    detailPaneEl.appendChild(sharableControls);
    
    // 5. Allowed Bunks
    const limitControls = renderAllowedBunksControls(item, saveData, renderDetailPane);
    detailPaneEl.appendChild(limitControls);
    
    // 6. Time Rules
    const timeRuleControls = renderTimeRulesUI(item, saveData, renderDetailPane);
    detailPaneEl.appendChild(timeRuleControls);
}

function addField() {
    const n = addFieldInput.value.trim();
    if (!n) return;
    if (fields.some(f => f.name.toLowerCase() === n.toLowerCase())) {
        alert("Name already exists.");
        return;
    }
    fields.push({
        name: n,
        activities: [],
        available: true,
        sharableWith: { type: 'not_sharable', divisions: [] },
        limitUsage: { enabled: false, divisions: {} },
        preferences: { enabled: false, exclusive: false, list: [] },
        timeRules: []
    });
    addFieldInput.value = "";
    saveData();
    selectedItemId = `field-${n}`;
    renderMasterLists();
    renderDetailPane();
}

// --- NEW: Preference UI ---
function renderPreferenceUI(item, onSave, onRerender) {
    const container = document.createElement("div");
    container.style.cssText = "margin-top:15px; padding-top:10px; border-top:1px solid #eee;";
    container.innerHTML = `<strong>Priority & Preferences:</strong>`;

    if (!item.preferences) item.preferences = { enabled: false, exclusive: false, list: [] };
    const prefs = item.preferences;

    // Toggle Enable
    const mainToggle = document.createElement("label");
    mainToggle.className = "switch-label";
    mainToggle.style.cssText = "display:flex; align-items:center; gap:10px; margin-top:5px; cursor:pointer;";
    mainToggle.innerHTML = `
        <input type="checkbox" ${prefs.enabled ? 'checked' : ''}>
        <span>Enable Preferences</span>
    `;
    mainToggle.querySelector("input").onchange = (e) => {
        prefs.enabled = e.target.checked;
        onSave();
        onRerender();
    };
    container.appendChild(mainToggle);

    if (prefs.enabled) {
        const inner = document.createElement("div");
        inner.style.cssText = "padding-left:20px; margin-top:10px; border-left:3px solid #e3f2fd;";
        
        // Exclusive Toggle
        const exclToggle = document.createElement("label");
        exclToggle.style.cssText = "display:block; margin-bottom:10px; cursor:pointer; font-size:0.9em;";
        exclToggle.innerHTML = `
            <input type="checkbox" ${prefs.exclusive ? 'checked' : ''}> 
            <strong>Exclusive Mode:</strong> Only listed divisions can use this field.
        `;
        exclToggle.querySelector("input").onchange = (e) => {
            prefs.exclusive = e.target.checked;
            onSave();
        };
        inner.appendChild(exclToggle);

        // List
        const listDiv = document.createElement("div");
        if (prefs.list.length === 0) {
            listDiv.innerHTML = `<p class="muted">No divisions in priority list.</p>`;
        } else {
            const ol = document.createElement("ol");
            ol.style.paddingLeft = "25px";
            prefs.list.forEach((divName, idx) => {
                const li = document.createElement("li");
                li.style.marginBottom = "4px";
                li.innerHTML = `
                    <span style="font-weight:600;">${divName}</span>
                    <button class="tiny-btn" data-idx="${idx}">Remove</button>
                `;
                li.querySelector("button").onclick = () => {
                    prefs.list.splice(idx, 1);
                    onSave();
                    onRerender();
                };
                ol.appendChild(li);
            });
            listDiv.appendChild(ol);
        }
        inner.appendChild(listDiv);

        // Add Division Dropdown
        const addRow = document.createElement("div");
        addRow.style.marginTop = "10px";
        
        const select = document.createElement("select");
        select.innerHTML = `<option value="">-- Add Division to Priority List --</option>`;
        (window.availableDivisions || []).forEach(d => {
            if (!prefs.list.includes(d)) {
                select.innerHTML += `<option value="${d}">${d}</option>`;
            }
        });
        
        select.onchange = (e) => {
            if (e.target.value) {
                prefs.list.push(e.target.value);
                onSave();
                onRerender();
            }
        };
        addRow.appendChild(select);
        inner.appendChild(addRow);
        
        container.appendChild(inner);
    }

    return container;
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
    // ... (Keep existing logic, just shortened for brevity in this output, assume strict copy) ...
    // Actually I need to provide full code to avoid breaking.
    // I will paste the full renderTimeRulesUI, renderSharable, renderAllowed below.
    
    const container = document.createElement("div");
    container.style.marginTop = "10px";
    container.style.paddingTop = "10px";
    container.style.borderTop = "1px solid #eee";
    container.innerHTML = `<strong>Global Time Rules:</strong>`;
    if (!item.timeRules) item.timeRules = [];
    
    item.timeRules.forEach((rule, index) => {
        const ruleEl = document.createElement("div");
        ruleEl.style.cssText = "margin:2px 0; padding:4px; background:#f4f4f4; border-radius:4px;";
        ruleEl.innerHTML = `<strong style="color:${rule.type==='Available'?'green':'red'}">${rule.type}</strong> ${rule.start} to ${rule.end} <button onclick="this.parentElement.remove()" style="border:none; background:none; cursor:pointer;">✖</button>`;
        ruleEl.querySelector("button").onclick = () => { item.timeRules.splice(index, 1); onSave(); onRerender(); };
        container.appendChild(ruleEl);
    });

    const addDiv = document.createElement("div");
    addDiv.style.marginTop = "5px";
    addDiv.innerHTML = `
        <select id="tr-type"><option>Available</option><option>Unavailable</option></select>
        <input id="tr-start" placeholder="9:00am" style="width:70px"> to 
        <input id="tr-end" placeholder="10:00am" style="width:70px">
        <button id="tr-add">Add</button>
    `;
    addDiv.querySelector("#tr-add").onclick = () => {
        const t = addDiv.querySelector("#tr-type").value;
        const s = addDiv.querySelector("#tr-start").value;
        const e = addDiv.querySelector("#tr-end").value;
        if(s && e) { item.timeRules.push({type:t, start:s, end:e}); onSave(); onRerender(); }
    };
    container.appendChild(addDiv);
    return container;
}

function renderSharableControls(item, onSave, onRerender) {
    const container = document.createElement("div");
    container.style.cssText = "margin-top:10px; padding-top:10px; border-top:1px solid #eee;";
    const rules = item.sharableWith || { type: 'not_sharable' };
    
    const label = document.createElement("label");
    label.style.cssText = "display:flex; align-items:center; gap:10px; cursor:pointer;";
    label.innerHTML = `<input type="checkbox" ${rules.type!=='not_sharable'?'checked':''}> <strong>Sharable (2 bunks)</strong>`;
    label.querySelector("input").onchange = (e) => {
        rules.type = e.target.checked ? 'all' : 'not_sharable';
        rules.divisions = [];
        onSave(); onRerender();
    };
    container.appendChild(label);
    
    if (rules.type !== 'not_sharable') {
        const divBox = document.createElement("div");
        divBox.style.marginTop = "5px";
        (window.availableDivisions||[]).forEach(d => {
            const s = document.createElement("span");
            const active = rules.divisions.includes(d);
            s.textContent = d;
            s.style.cssText = `display:inline-block; padding:2px 8px; margin:2px; border-radius:10px; border:1px solid #ccc; cursor:pointer; background:${active?'#007BFF':'#fff'}; color:${active?'#fff':'#000'};`;
            s.onclick = () => {
                if(active) rules.divisions = rules.divisions.filter(x=>x!==d);
                else rules.divisions.push(d);
                rules.type = rules.divisions.length ? 'custom' : 'all';
                onSave(); onRerender();
            };
            divBox.appendChild(s);
        });
        container.appendChild(divBox);
    }
    return container;
}

function renderAllowedBunksControls(item, onSave, onRerender) {
    const container = document.createElement("div");
    container.style.cssText = "margin-top:10px; padding-top:10px; border-top:1px solid #eee;";
    container.innerHTML = `<strong>Allowed Bunks (Restrictions):</strong>`;
    const rules = item.limitUsage || { enabled: false, divisions: {} };
    
    const toggle = document.createElement("div");
    toggle.innerHTML = `<label style="cursor:pointer"><input type="checkbox" ${rules.enabled?'checked':''}> Enable Strict Restrictions</label>`;
    toggle.querySelector("input").onchange = (e) => { rules.enabled = e.target.checked; onSave(); onRerender(); };
    container.appendChild(toggle);
    
    if (rules.enabled) {
        const box = document.createElement("div");
        box.style.paddingLeft = "10px";
        (window.availableDivisions||[]).forEach(div => {
            const divRow = document.createElement("div");
            const isAllowed = rules.divisions[div] !== undefined;
            divRow.innerHTML = `<span style="font-weight:bold; cursor:pointer; color:${isAllowed?'green':'#aaa'}">${div}</span>`;
            divRow.querySelector("span").onclick = () => {
                if(isAllowed) delete rules.divisions[div];
                else rules.divisions[div] = []; 
                onSave(); onRerender();
            };
            
            if(isAllowed) {
                const bunks = window.divisions[div]?.bunks || [];
                const bBox = document.createElement("div");
                bBox.style.paddingLeft="15px";
                const allBtn = document.createElement("span");
                allBtn.textContent = "ALL";
                const allActive = rules.divisions[div].length === 0;
                allBtn.style.cssText = `margin-right:5px; cursor:pointer; font-size:0.8em; font-weight:bold; color:${allActive?'blue':'#ccc'}`;
                allBtn.onclick = () => { rules.divisions[div] = []; onSave(); onRerender(); };
                bBox.appendChild(allBtn);
                
                bunks.forEach(b => {
                    const s = document.createElement("span");
                    const active = rules.divisions[div].includes(b); // Wait, logic inversion?
                    // If array is empty -> ALL allowed.
                    // If array has items -> ONLY those items allowed.
                    // So 'active' means 'in array'.
                    // BUT visual cue needs to match "Is Allowed".
                    // If array empty -> Allowed (Blue).
                    // If array not empty -> Only items in array are Blue.
                    
                    const isEffective = allActive || rules.divisions[div].includes(b);
                    s.textContent = b;
                    s.style.cssText = `margin:2px; padding:1px 5px; border:1px solid #ccc; cursor:pointer; background:${isEffective?'#e3f2fd':'#fff'};`;
                    s.onclick = () => {
                        if (allActive) {
                            // Switch to specific mode, add all OTHERS, or just add THIS one?
                            // Logic: user clicked one bunk to Toggle it.
                            // If it was ALL, and user clicks B1, usually implies "Only B1" or "Except B1".
                            // Let's stick to "Only B1".
                            rules.divisions[div] = [b];
                        } else {
                            if (rules.divisions[div].includes(b)) {
                                rules.divisions[div] = rules.divisions[div].filter(x=>x!==b);
                            } else {
                                rules.divisions[div].push(b);
                            }
                        }
                        onSave(); onRerender();
                    };
                    bBox.appendChild(s);
                });
                divRow.appendChild(bBox);
            }
            box.appendChild(divRow);
        });
        container.appendChild(box);
    }
    return container;
}

window.initFieldsTab = initFieldsTab;

})();
