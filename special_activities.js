// ============================================================================
// special_activities.js — MERGED: FIELDS.JS UX STYLE
// ============================================================================
// 1. Layout: Apple-inspired Two-Pane with Collapsible Detail Sections.
// 2. Logic: Retains all Transition, Sharing, Frequency, and Time Rules.
// 3. Style: Matches fields.js for consistent UI/UX across the app.
// ============================================================================
(function() {
'use strict';

let specialActivities = [];
let selectedItemId = null;
let specialsListEl = null;
let detailPaneEl = null;
let addSpecialInput = null;

//------------------------------------------------------------------
// INIT
//------------------------------------------------------------------
function initSpecialActivitiesTab() {
    const container = document.getElementById("special_activities");
    if (!container) return;

    loadData();
    container.innerHTML = "";

    // Inject Styles (matching fields.js)
    const style = document.createElement('style');
    style.innerHTML = `
        /* Master List Styles */
        .sa-master-list { border: 1px solid #E5E7EB; border-radius: 12px; background: #fff; overflow: hidden; }
        .sa-list-item { padding: 12px 14px; border-bottom: 1px solid #F3F4F6; cursor: pointer; display: flex; justify-content: space-between; align-items: center; transition: background 0.15s; }
        .sa-list-item:last-child { border-bottom: none; }
        .sa-list-item:hover { background: #F9FAFB; }
        .sa-list-item.selected { background: #F0FDF4; border-left: 3px solid #10B981; }
        .sa-list-item-name { font-weight: 500; color: #1F2937; font-size: 0.9rem; }
        .sa-list-item-meta { font-size: 0.75rem; color: #6B7280; margin-left: 6px; }

        /* Accordion / Collapsible Sections */
        .sa-detail-section { margin-bottom: 12px; border: 1px solid #E5E7EB; border-radius: 12px; background: #fff; overflow: hidden; }
        .sa-detail-section-header { padding: 12px 16px; background: #F9FAFB; cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none; }
        .sa-detail-section-header:hover { background: #F3F4F6; }
        .sa-detail-section-title { font-size: 0.9rem; font-weight: 600; color: #111; }
        .sa-detail-section-summary { font-size: 0.8rem; color: #6B7280; margin-top: 2px; }
        .sa-detail-section-body { display: none; padding: 16px; border-top: 1px solid #E5E7EB; }

        /* Chips */
        .sa-chip { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 0.75rem; cursor: pointer; border: 1px solid #E5E7EB; margin-right: 4px; margin-bottom: 4px; transition: all 0.2s; }
        .sa-chip.active { background: #10B981; color: white; border-color: #10B981; box-shadow: 0 2px 5px rgba(16, 185, 129, 0.3); }
        .sa-chip.inactive { background: #F3F4F6; color: #374151; }
        .sa-chip:hover { transform: translateY(-1px); }

        /* Switch/Toggle */
        .sa-switch { position: relative; display: inline-block; width: 34px; height: 20px; flex-shrink: 0; }
        .sa-switch input { opacity: 0; width: 0; height: 0; }
        .sa-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #ccc; transition: .4s; border-radius: 34px; }
        .sa-slider:before { position: absolute; content: ""; height: 14px; width: 14px; left: 3px; bottom: 3px; background-color: white; transition: .4s; border-radius: 50%; }
        .sa-switch input:checked + .sa-slider { background-color: #10B981; }
        .sa-switch input:checked + .sa-slider:before { transform: translateX(14px); }

        /* Form inputs */
        .sa-field-input {
            padding: 6px 10px;
            border: 1px solid #D1D5DB;
            border-radius: 6px;
            font-size: 0.9rem;
            transition: all 0.15s ease;
        }
        .sa-field-input:focus {
            outline: none;
            border-color: #10B981;
            box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.2);
        }

        /* Priority List */
        .sa-priority-list-item { display: flex; align-items: center; gap: 10px; padding: 8px; background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 8px; margin-bottom: 6px; }
        .sa-priority-btn { width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; border: 1px solid #D1D5DB; border-radius: 4px; background: white; cursor: pointer; font-size: 0.8rem; transition: all 0.15s; }
        .sa-priority-btn:hover:not(:disabled) { border-color: #10B981; color: #10B981; }
        .sa-priority-btn:disabled { opacity: 0.4; cursor: default; }

        .sa-muted { color: #6B7280; font-size: 0.85rem; }
    `;
    container.appendChild(style);

    // Create the main content wrapper
    const contentWrapper = document.createElement('div');
    contentWrapper.innerHTML = `
        <div class="setup-grid">
          <section class="setup-card setup-card-wide" style="border:none; box-shadow:none; background:transparent;">
            <div class="setup-card-header" style="margin-bottom:20px;">
              <span class="setup-step-pill">Specials</span>
              <div class="setup-card-text">
                <h3>Special Activities & Rotations</h3>
                <p>Add canteen, electives, trips, lakes, buses, and control availability, sharing, division access, and rotation rules.</p>
              </div>
            </div>

            <div style="display:flex; flex-wrap:wrap; gap:24px;">
              <!-- LEFT SIDE: MASTER LIST -->
              <div style="flex:1; min-width:280px;">
                <div style="display:flex; justify-content:space-between; align-items:end; margin-bottom:8px;">
                    <div class="setup-subtitle">All Specials</div>
                </div>
                
                <div style="background:white; padding:10px; border-radius:12px; border:1px solid #E5E7EB; margin-bottom:12px; display:flex; gap:8px;">
                  <input id="new-special-input" placeholder="New Special (e.g., Canteen)" style="flex:1; border:none; outline:none; font-size:0.9rem;">
                  <button id="add-special-btn" style="background:#111; color:white; border:none; border-radius:6px; padding:6px 12px; font-size:0.8rem; cursor:pointer;">Add</button>
                </div>
                <div id="specials-master-list" class="sa-master-list" style="max-height:600px; overflow-y:auto;"></div>
              </div>

              <!-- RIGHT SIDE: DETAIL PANE -->
              <div style="flex:1.4; min-width:340px;">
                <div class="setup-subtitle">Special Configuration</div>
                <div id="specials-detail-pane" style="margin-top:8px;"></div>
              </div>
            </div>
          </section>
        </div>`;
    container.appendChild(contentWrapper);

    specialsListEl = document.getElementById("specials-master-list");
    detailPaneEl = document.getElementById("specials-detail-pane");
    addSpecialInput = document.getElementById("new-special-input");

    document.getElementById("add-special-btn").onclick = addSpecial;
    addSpecialInput.onkeyup = e => { if (e.key === "Enter") addSpecial(); };

    renderMasterList();
    renderDetailPane();
}

//------------------------------------------------------------------
// DATA LOADING
//------------------------------------------------------------------
function loadData() {
    specialActivities = window.getGlobalSpecialActivities?.() || [];
    
    // Ensure data completeness
    specialActivities.forEach(s => {
        s.available = s.available !== false;
        s.timeRules = s.timeRules || [];
        s.sharableWith = s.sharableWith || { type: 'not_sharable', divisions: [], capacity: 2 };
        if (!s.sharableWith.capacity) s.sharableWith.capacity = 2;
        s.limitUsage = s.limitUsage || { enabled: false, divisions: {} };
        s.preferences = s.preferences || { enabled: false, exclusive: false, list: [] };
        s.maxUsage = (s.maxUsage !== undefined && s.maxUsage !== "") ? s.maxUsage : null;
        s.frequencyWeeks = s.frequencyWeeks || 0;

        // Transition fields
        s.transition = s.transition || {
            preMin: 0,
            postMin: 0,
            label: "Change Time",
            zone: window.DEFAULT_ZONE_NAME || "Default",
            occupiesField: true,
            minDurationMin: 0
        };
    });
}

function saveData() {
    window.saveGlobalSpecialActivities?.(specialActivities);
}

//------------------------------------------------------------------
// LEFT LIST (Master List)
//------------------------------------------------------------------
function renderMasterList() {
    specialsListEl.innerHTML = "";
    
    if (specialActivities.length === 0) {
        specialsListEl.innerHTML = `<div style="padding:20px; text-align:center; color:#9CA3AF;">No special activities yet.</div>`;
        return;
    }
    
    specialActivities.forEach(item => {
        specialsListEl.appendChild(createMasterListItem(item));
    });
}

function createMasterListItem(item) {
    const id = `special-${item.name}`;
    const el = document.createElement("div");
    el.className = "sa-list-item" + (id === selectedItemId ? " selected" : "");
    el.onclick = () => { 
        selectedItemId = id; 
        renderMasterList(); 
        renderDetailPane(); 
    };

    const infoDiv = document.createElement("div");
    
    const nameEl = document.createElement("div");
    nameEl.className = "sa-list-item-name";
    nameEl.textContent = item.name;

    // Add meta info (Transition times)
    if (item.transition.preMin > 0 || item.transition.postMin > 0) {
        const meta = document.createElement("span");
        meta.className = "sa-list-item-meta";
        meta.textContent = `(${item.transition.preMin}m / ${item.transition.postMin}m)`;
        nameEl.appendChild(meta);
    }

    infoDiv.appendChild(nameEl);
    el.appendChild(infoDiv);

    // Toggle Switch
    const tog = document.createElement("label");
    tog.className = "sa-switch";
    tog.onclick = e => e.stopPropagation();

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = item.available;
    cb.onchange = () => { 
        item.available = cb.checked; 
        saveData(); 
        renderDetailPane(); 
    };

    const slider = document.createElement("span");
    slider.className = "sa-slider";
    tog.appendChild(cb);
    tog.appendChild(slider);
    el.appendChild(tog);

    return el;
}

//------------------------------------------------------------------
// RIGHT PANEL — APPLE STYLE COLLAPSIBLE SECTIONS
//------------------------------------------------------------------
function renderDetailPane() {
    if (!selectedItemId) {
        detailPaneEl.innerHTML = `
            <div style="height:300px; display:flex; align-items:center; justify-content:center; color:#9CA3AF; border:1px dashed #E5E7EB; border-radius:12px;">
                Select a special to edit details
            </div>`;
        return;
    }

    const [, name] = selectedItemId.split(/-(.+)/);
    const item = specialActivities.find(s => s.name === name);
    
    if (!item) {
        detailPaneEl.innerHTML = `<p class='sa-muted'>Not found.</p>`;
        selectedItemId = null;
        return;
    }

    detailPaneEl.innerHTML = "";

    // -- 1. HEADER (Title & Delete) --
    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.alignItems = "center";
    header.style.marginBottom = "16px";

    const title = document.createElement("h2");
    title.textContent = item.name;
    title.style.margin = "0";
    title.style.fontSize = "1.25rem";
    title.title = "Double click to rename";
    makeEditable(title, newName => {
        if (!newName.trim()) return;
        item.name = newName;
        selectedItemId = `special-${newName}`;
        saveData();
        renderMasterList();
        renderDetailPane();
    });

    const delBtn = document.createElement("button");
    delBtn.innerHTML = `
        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
        </svg> Delete`;
    delBtn.style.color = "#DC2626";
    delBtn.style.background = "#FEF2F2";
    delBtn.style.border = "1px solid #FECACA";
    delBtn.style.padding = "6px 12px";
    delBtn.style.borderRadius = "6px";
    delBtn.style.cursor = "pointer";
    delBtn.style.display = "flex";
    delBtn.style.gap = "6px";
    delBtn.style.alignItems = "center";
    delBtn.onclick = () => {
        if (confirm(`Delete "${item.name}"?`)) {
            specialActivities = specialActivities.filter(s => s.name !== item.name);
            saveData();
            selectedItemId = null;
            renderMasterList();
            renderDetailPane();
        }
    };

    header.appendChild(title);
    header.appendChild(delBtn);
    detailPaneEl.appendChild(header);

    // -- 2. AVAILABILITY STRIP --
    const availability = document.createElement("div");
    availability.style.padding = "12px";
    availability.style.borderRadius = "8px";
    availability.style.marginBottom = "20px";
    availability.style.background = item.available ? "#ECFDF5" : "#FEF2F2";
    availability.style.border = item.available ? "1px solid #A7F3D0" : "1px solid #FECACA";
    availability.style.color = item.available ? "#065F46" : "#991B1B";
    availability.style.fontSize = "0.9rem";
    availability.style.display = "flex";
    availability.style.justifyContent = "space-between";
    availability.innerHTML = `<span>Special is <strong>${item.available ? 'AVAILABLE' : 'UNAVAILABLE'}</strong></span> <span style="font-size:0.8rem; opacity:0.8;">Toggle in master list</span>`;
    detailPaneEl.appendChild(availability);

    // -- 3. ACCORDION SECTIONS --
    
    // Transition & Zone Rules
    detailPaneEl.appendChild(createSection("Transition & Zone Rules", summaryTransition(item), 
        () => renderTransition(item)));

    // Frequency Limits
    detailPaneEl.appendChild(createSection("Frequency Limits", summaryFrequency(item), 
        () => renderFrequency(item)));

    // Sharing Rules
    detailPaneEl.appendChild(createSection("Sharing Rules", summarySharing(item), 
        () => renderSharing(item)));

    // Access & Restrictions
    detailPaneEl.appendChild(createSection("Access & Restrictions", summaryAccess(item), 
        () => renderAccess(item)));

    // Time Rules
    detailPaneEl.appendChild(createSection("Time Rules", summaryTime(item), 
        () => renderTimeRules(item)));
}

//------------------------------------------------------------------
// SECTION BUILDER (Accordion UX)
//------------------------------------------------------------------
function createSection(title, summary, builder) {
    const wrap = document.createElement("div");
    wrap.className = "sa-detail-section";

    const head = document.createElement("div");
    head.className = "sa-detail-section-header";

    const t = document.createElement("div");
    t.innerHTML = `<div class="sa-detail-section-title">${escapeHtml(title)}</div><div class="sa-detail-section-summary">${escapeHtml(summary)}</div>`;

    const caret = document.createElement("span");
    caret.innerHTML = `<svg width="20" height="20" fill="none" stroke="#9CA3AF" stroke-width="2" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"></path></svg>`;
    caret.style.transition = "transform 0.2s";

    head.appendChild(t);
    head.appendChild(caret);

    const body = document.createElement("div");
    body.className = "sa-detail-section-body";

    head.onclick = () => {
        const open = body.style.display === "block";
        body.style.display = open ? "none" : "block";
        caret.style.transform = open ? "rotate(0deg)" : "rotate(90deg)";
        if (!open && !body.dataset.built) {
            body.innerHTML = "";
            body.appendChild(builder());
            body.dataset.built = "1";
        }
    };

    wrap.appendChild(head);
    wrap.appendChild(body);
    return wrap;
}

//------------------------------------------------------------------
// SUMMARY GENERATORS
//------------------------------------------------------------------
function summaryTransition(item) { 
    return `${item.transition.preMin}m Pre / ${item.transition.postMin}m Post`; 
}

function summaryFrequency(item) {
    if (item.maxUsage === null || item.maxUsage === undefined) {
        return "Unlimited usage";
    }
    const freqLabels = { 0: "Summer", 1: "Week", 2: "2 Weeks", 3: "3 Weeks", 4: "4 Weeks" };
    return `${item.maxUsage}x per ${freqLabels[item.frequencyWeeks] || "Summer"}`;
}

function summarySharing(item) { 
    return item.sharableWith.type === "not_sharable" ? "Not sharable" : `Sharable (Max ${item.sharableWith.capacity})`; 
}

function summaryAccess(item) {
    if (!item.limitUsage.enabled) return "Open to All Divisions";
    if (item.preferences?.exclusive) return "Exclusive to specific divisions";
    return "Priority/Restrictions Active";
}

function summaryTime(item) { 
    return item.timeRules.length ? `${item.timeRules.length} rule(s) active` : "Available all day"; 
}

//------------------------------------------------------------------
// CONTENT RENDERERS
//------------------------------------------------------------------

// 1. TRANSITION & ZONE
function renderTransition(item) {
    const t = item.transition;
    const container = document.createElement("div");
    
    const update = () => { 
        saveData(); 
        renderMasterList(); 
        // Update summary
        const summaryEl = container.closest('.sa-detail-section')?.querySelector('.sa-detail-section-summary');
        if (summaryEl) summaryEl.textContent = summaryTransition(item);
    };

    // Times Row
    const timeRow = document.createElement("div");
    timeRow.style.display = "flex";
    timeRow.style.gap = "12px";
    timeRow.style.marginBottom = "12px";
    timeRow.style.flexWrap = "wrap";

    const mkInput = (lbl, val, setter) => {
        const d = document.createElement("div");
        d.innerHTML = `<label style="display:block; font-size:0.8rem; font-weight:600; margin-bottom:4px;">${lbl}</label>`;
        const i = document.createElement("input");
        i.type = "number";
        i.min = "0";
        i.step = "5";
        i.value = val;
        i.className = "sa-field-input";
        i.style.width = "80px";
        i.onchange = () => { setter(parseInt(i.value) || 0); update(); };
        d.appendChild(i);
        return d;
    };

    timeRow.appendChild(mkInput("Pre-Buffer (min)", t.preMin, v => t.preMin = v));
    timeRow.appendChild(mkInput("Post-Buffer (min)", t.postMin, v => t.postMin = v));
    container.appendChild(timeRow);

    // Label & Zone Row
    const metaRow = document.createElement("div");
    metaRow.style.display = "flex";
    metaRow.style.gap = "12px";
    metaRow.style.marginBottom = "12px";
    metaRow.style.flexWrap = "wrap";

    // Label Input
    const labelDiv = document.createElement("div");
    labelDiv.style.flex = "1";
    labelDiv.style.minWidth = "120px";
    labelDiv.innerHTML = `<label style="display:block; font-size:0.8rem; font-weight:600; margin-bottom:4px;">Label</label>`;
    const labelIn = document.createElement("input");
    labelIn.type = "text";
    labelIn.value = t.label;
    labelIn.className = "sa-field-input";
    labelIn.style.width = "100%";
    labelIn.onchange = () => { t.label = labelIn.value.trim() || "Transition"; update(); };
    labelDiv.appendChild(labelIn);
    metaRow.appendChild(labelDiv);

    // Zone Select
    const zoneDiv = document.createElement("div");
    zoneDiv.style.flex = "1";
    zoneDiv.style.minWidth = "120px";
    zoneDiv.innerHTML = `<label style="display:block; font-size:0.8rem; font-weight:600; margin-bottom:4px;">Zone (Location)</label>`;
    const zoneSel = document.createElement("select");
    zoneSel.className = "sa-field-input";
    zoneSel.style.width = "100%";
    const zones = window.getZones?.() || {};
    Object.values(zones).forEach(z => {
        const opt = document.createElement("option");
        opt.value = z.name;
        opt.textContent = z.name + (z.isDefault ? " (Default)" : "");
        if (z.name === t.zone) opt.selected = true;
        zoneSel.appendChild(opt);
    });
    zoneSel.onchange = () => { t.zone = zoneSel.value; update(); };
    zoneDiv.appendChild(zoneSel);
    metaRow.appendChild(zoneDiv);

    // Min Duration
    metaRow.appendChild(mkInput("Min Duration (min)", t.minDurationMin, v => t.minDurationMin = v));

    container.appendChild(metaRow);

    // Occupancy Toggle
    const occLabel = document.createElement("label");
    occLabel.style.display = "flex";
    occLabel.style.alignItems = "center";
    occLabel.style.gap = "8px";
    occLabel.style.cursor = "pointer";
    occLabel.style.marginTop = "8px";

    const occCk = document.createElement("input");
    occCk.type = "checkbox";
    occCk.checked = t.occupiesField;
    occCk.onchange = () => { t.occupiesField = occCk.checked; update(); };

    occLabel.appendChild(occCk);
    occLabel.appendChild(document.createTextNode("Buffer occupies resource (e.g. Setup/Change)"));
    container.appendChild(occLabel);

    const hint = document.createElement("p");
    hint.className = "sa-muted";
    hint.style.fontSize = "0.75rem";
    hint.style.marginTop = "4px";
    hint.style.paddingLeft = "22px";
    hint.textContent = "If unchecked (Travel), the resource is available during transition time.";
    container.appendChild(hint);

    return container;
}

// 2. FREQUENCY LIMITS
function renderFrequency(item) {
    const container = document.createElement("div");

    const updateSummary = () => {
        const summaryEl = container.closest('.sa-detail-section')?.querySelector('.sa-detail-section-summary');
        if (summaryEl) summaryEl.textContent = summaryFrequency(item);
    };

    const renderContent = () => {
        container.innerHTML = "";

        if (item.maxUsage === null || item.maxUsage === undefined) {
            // No limit set
            const noLimitBox = document.createElement("div");
            noLimitBox.style.padding = "16px";
            noLimitBox.style.background = "#F9FAFB";
            noLimitBox.style.borderRadius = "8px";
            noLimitBox.style.textAlign = "center";
            noLimitBox.innerHTML = `
                <p style="margin:0 0 12px; color:#6B7280;">Unlimited usage allowed.</p>
                <button id="add-freq-rule" style="background:#10B981; color:white; border:none; padding:8px 20px; border-radius:999px; cursor:pointer; font-weight:500;">
                    + Add Frequency Rule
                </button>
            `;
            container.appendChild(noLimitBox);

            container.querySelector('#add-freq-rule').onclick = () => {
                item.maxUsage = 1;
                item.frequencyWeeks = 0;
                saveData();
                renderContent();
                updateSummary();
            };
        } else {
            // Has limit
            const desc = document.createElement("p");
            desc.className = "sa-muted";
            desc.style.marginBottom = "12px";
            desc.textContent = "Bunks are allowed to use this special:";
            container.appendChild(desc);

            const controlRow = document.createElement("div");
            controlRow.style.display = "flex";
            controlRow.style.gap = "10px";
            controlRow.style.alignItems = "center";
            controlRow.style.flexWrap = "wrap";

            // Count Input
            const maxInput = document.createElement("input");
            maxInput.type = "number";
            maxInput.min = "1";
            maxInput.value = item.maxUsage;
            maxInput.className = "sa-field-input";
            maxInput.style.width = "60px";
            maxInput.onchange = () => {
                const val = parseInt(maxInput.value) || 1;
                item.maxUsage = Math.max(1, val);
                saveData();
                updateSummary();
            };

            const timeLabel = document.createElement("span");
            timeLabel.textContent = "time(s) per";
            timeLabel.style.fontSize = "0.85rem";

            // Frequency Dropdown
            const freqSelect = document.createElement("select");
            freqSelect.className = "sa-field-input";
            const opts = [
                { v: 0, t: "Summer (Lifetime)" },
                { v: 1, t: "1 Week (7 Days)" },
                { v: 2, t: "2 Weeks (14 Days)" },
                { v: 3, t: "3 Weeks (21 Days)" },
                { v: 4, t: "4 Weeks (28 Days)" }
            ];
            opts.forEach(o => {
                const op = document.createElement("option");
                op.value = o.v;
                op.textContent = o.t;
                if (item.frequencyWeeks === o.v) op.selected = true;
                freqSelect.appendChild(op);
            });
            freqSelect.onchange = () => {
                item.frequencyWeeks = parseInt(freqSelect.value, 10);
                saveData();
                updateSummary();
            };

            // Remove Button
            const removeBtn = document.createElement("button");
            removeBtn.textContent = "Remove Rule";
            removeBtn.style.background = "#FEE2E2";
            removeBtn.style.color = "#DC2626";
            removeBtn.style.border = "1px solid #FECACA";
            removeBtn.style.padding = "6px 12px";
            removeBtn.style.borderRadius = "6px";
            removeBtn.style.cursor = "pointer";
            removeBtn.onclick = () => {
                item.maxUsage = null;
                item.frequencyWeeks = 0;
                saveData();
                renderContent();
                updateSummary();
            };

            controlRow.appendChild(maxInput);
            controlRow.appendChild(timeLabel);
            controlRow.appendChild(freqSelect);
            controlRow.appendChild(removeBtn);
            container.appendChild(controlRow);
        }
    };

    renderContent();
    return container;
}

// 3. SHARING RULES
function renderSharing(item) {
    const container = document.createElement("div");

    const updateSummary = () => {
        const summaryEl = container.closest('.sa-detail-section')?.querySelector('.sa-detail-section-summary');
        if (summaryEl) summaryEl.textContent = summarySharing(item);
    };

    const renderContent = () => {
        container.innerHTML = "";

        const rules = item.sharableWith;

        // Toggle
        const tog = document.createElement("label");
        tog.className = "sa-switch";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = rules.type !== 'not_sharable';
        cb.onchange = () => {
            rules.type = cb.checked ? 'all' : 'not_sharable';
            rules.divisions = [];
            saveData();
            renderContent();
            updateSummary();
        };
        const sl = document.createElement("span");
        sl.className = "sa-slider";
        tog.appendChild(cb);
        tog.appendChild(sl);

        const header = document.createElement("div");
        header.style.display = "flex";
        header.style.alignItems = "center";
        header.style.gap = "10px";
        header.appendChild(tog);
        header.appendChild(document.createTextNode("Allow Sharing (Multiple bunks at once)"));
        container.appendChild(header);

        if (rules.type !== 'not_sharable') {
            const det = document.createElement("div");
            det.style.marginTop = "16px";
            det.style.paddingLeft = "12px";
            det.style.borderLeft = "2px solid #E5E7EB";

            // Capacity
            const capRow = document.createElement("div");
            capRow.style.marginBottom = "12px";
            capRow.innerHTML = `<span style="font-size:0.85rem;">Max Capacity: </span>`;
            const capIn = document.createElement("input");
            capIn.type = "number";
            capIn.min = "2";
            capIn.value = rules.capacity;
            capIn.className = "sa-field-input";
            capIn.style.width = "60px";
            capIn.style.marginLeft = "8px";
            capIn.onchange = () => { 
                rules.capacity = Math.max(2, parseInt(capIn.value) || 2); 
                saveData(); 
                updateSummary();
            };
            capRow.appendChild(capIn);
            det.appendChild(capRow);

            // Limit Divisions
            const divLabel = document.createElement("div");
            divLabel.textContent = "Limit sharing to specific divisions (Optional):";
            divLabel.style.fontSize = "0.85rem";
            divLabel.style.marginBottom = "6px";
            det.appendChild(divLabel);

            const chipWrap = document.createElement("div");
            const allDivs = window.availableDivisions || [];
            allDivs.forEach(d => {
                const isActive = rules.divisions.includes(d);
                const chip = document.createElement("span");
                chip.className = "sa-chip " + (isActive ? "active" : "inactive");
                chip.textContent = d;
                chip.onclick = () => {
                    if (isActive) rules.divisions = rules.divisions.filter(x => x !== d);
                    else rules.divisions.push(d);
                    rules.type = rules.divisions.length > 0 ? 'custom' : 'all';
                    saveData();
                    chip.className = "sa-chip " + (rules.divisions.includes(d) ? "active" : "inactive");
                };
                chipWrap.appendChild(chip);
            });
            det.appendChild(chipWrap);
            container.appendChild(det);
        }
    };

    renderContent();
    return container;
}

// 4. ACCESS & RESTRICTIONS
function renderAccess(item) {
    const container = document.createElement("div");

    const updateSummary = () => {
        const summaryEl = container.closest('.sa-detail-section')?.querySelector('.sa-detail-section-summary');
        if (summaryEl) summaryEl.textContent = summaryAccess(item);
    };

    const renderContent = () => {
        container.innerHTML = "";

        const rules = item.limitUsage;
        const prefs = item.preferences;

        // Toggle Mode Buttons
        const modeWrap = document.createElement("div");
        modeWrap.style.display = "flex";
        modeWrap.style.gap = "12px";
        modeWrap.style.marginBottom = "16px";

        const btnAll = document.createElement("button");
        btnAll.textContent = "Open to All";
        btnAll.style.cssText = `flex:1; padding:8px; border-radius:6px; border:1px solid #E5E7EB; cursor:pointer; background:${!rules.enabled ? '#ECFDF5' : '#fff'}; color:${!rules.enabled ? '#047857' : '#333'}; border-color:${!rules.enabled ? '#10B981' : '#E5E7EB'}; font-weight:${!rules.enabled ? '600' : '400'}; transition:all 0.2s;`;

        const btnRes = document.createElement("button");
        btnRes.textContent = "Restricted / Priority";
        btnRes.style.cssText = `flex:1; padding:8px; border-radius:6px; border:1px solid #E5E7EB; cursor:pointer; background:${rules.enabled ? '#ECFDF5' : '#fff'}; color:${rules.enabled ? '#047857' : '#333'}; border-color:${rules.enabled ? '#10B981' : '#E5E7EB'}; font-weight:${rules.enabled ? '600' : '400'}; transition:all 0.2s;`;

        btnAll.onclick = () => {
            rules.enabled = false;
            prefs.enabled = false;
            saveData();
            renderContent();
            updateSummary();
        };

        btnRes.onclick = () => {
            rules.enabled = true;
            prefs.enabled = true;
            saveData();
            renderContent();
            updateSummary();
        };

        modeWrap.appendChild(btnAll);
        modeWrap.appendChild(btnRes);
        container.appendChild(modeWrap);

        if (rules.enabled) {
            const body = document.createElement("div");

            // Exclusive Checkbox
            const exLabel = document.createElement("label");
            exLabel.style.display = "flex";
            exLabel.style.alignItems = "center";
            exLabel.style.gap = "8px";
            exLabel.style.marginBottom = "12px";
            exLabel.style.cursor = "pointer";

            const exCk = document.createElement("input");
            exCk.type = "checkbox";
            exCk.checked = prefs.exclusive;
            exCk.onchange = () => { 
                prefs.exclusive = exCk.checked; 
                saveData(); 
                updateSummary(); 
            };

            exLabel.appendChild(exCk);
            exLabel.appendChild(document.createTextNode("Exclusive Mode (Only allowed divisions can use this)"));
            body.appendChild(exLabel);

            // Priority List Header
            const pHeader = document.createElement("div");
            pHeader.textContent = "Priority Order (Top = First Choice):";
            pHeader.style.fontSize = "0.85rem";
            pHeader.style.fontWeight = "600";
            pHeader.style.marginBottom = "6px";
            body.appendChild(pHeader);

            const listContainer = document.createElement("div");

            prefs.list = (prefs.list || []).filter(d => rules.divisions.hasOwnProperty(d));

            if (prefs.list.length === 0) {
                listContainer.innerHTML = `<div class="sa-muted" style="font-size:0.8rem; font-style:italic; padding:4px;">No priority divisions set. Add below.</div>`;
            }

            prefs.list.forEach((divName, idx) => {
                const row = document.createElement("div");
                row.className = "sa-priority-list-item";
                row.innerHTML = `<span style="font-weight:bold; color:#10B981; width:20px;">${idx + 1}</span> <span style="flex:1;">${escapeHtml(divName)}</span>`;

                const ctrls = document.createElement("div");
                ctrls.style.display = "flex";
                ctrls.style.gap = "4px";

                const mkBtn = (txt, fn, dis) => {
                    const b = document.createElement("button");
                    b.className = "sa-priority-btn";
                    b.textContent = txt;
                    if (dis) b.disabled = true;
                    else b.onclick = fn;
                    return b;
                };

                ctrls.appendChild(mkBtn("↑", () => {
                    [prefs.list[idx - 1], prefs.list[idx]] = [prefs.list[idx], prefs.list[idx - 1]];
                    saveData();
                    renderContent();
                }, idx === 0));

                ctrls.appendChild(mkBtn("↓", () => {
                    [prefs.list[idx + 1], prefs.list[idx]] = [prefs.list[idx], prefs.list[idx + 1]];
                    saveData();
                    renderContent();
                }, idx === prefs.list.length - 1));

                const rm = mkBtn("✕", () => {
                    prefs.list = prefs.list.filter(d => d !== divName);
                    saveData();
                    renderContent();
                }, false);
                rm.style.color = "#DC2626";
                rm.style.borderColor = "#FECACA";
                ctrls.appendChild(rm);

                row.appendChild(ctrls);
                listContainer.appendChild(row);
            });

            body.appendChild(listContainer);

            // Division Selector Chips
            const divHeader = document.createElement("div");
            divHeader.textContent = "Allowed Divisions (Click to add/remove from priority):";
            divHeader.style.fontSize = "0.85rem";
            divHeader.style.fontWeight = "600";
            divHeader.style.marginTop = "16px";
            divHeader.style.marginBottom = "6px";
            body.appendChild(divHeader);

            const chipWrap = document.createElement("div");
            const availableDivisions = window.availableDivisions || [];

            availableDivisions.forEach(divName => {
                const isAllowed = divName in rules.divisions;
                const c = document.createElement("span");
                c.className = "sa-chip " + (isAllowed ? "active" : "inactive");
                c.textContent = divName;
                c.onclick = () => {
                    if (isAllowed) {
                        delete rules.divisions[divName];
                        prefs.list = prefs.list.filter(d => d !== divName);
                    } else {
                        rules.divisions[divName] = [];
                        if (!prefs.list.includes(divName)) prefs.list.push(divName);
                    }
                    saveData();
                    renderContent();
                };
                chipWrap.appendChild(c);
            });

            body.appendChild(chipWrap);
            container.appendChild(body);
        }
    };

    renderContent();
    return container;
}

// 5. TIME RULES
function renderTimeRules(item) {
    const container = document.createElement("div");

    const updateSummary = () => {
        const summaryEl = container.closest('.sa-detail-section')?.querySelector('.sa-detail-section-summary');
        if (summaryEl) summaryEl.textContent = summaryTime(item);
    };

    const renderContent = () => {
        container.innerHTML = "";

        // Existing Rules
        if (item.timeRules.length > 0) {
            item.timeRules.forEach((r, i) => {
                const row = document.createElement("div");
                row.style.display = "flex";
                row.style.justifyContent = "space-between";
                row.style.alignItems = "center";
                row.style.background = "#F9FAFB";
                row.style.padding = "8px";
                row.style.marginBottom = "6px";
                row.style.borderRadius = "6px";
                row.style.border = "1px solid #E5E7EB";

                const txt = document.createElement("span");
                txt.innerHTML = `<strong style="color:${r.type === 'Available' ? '#059669' : '#DC2626'}">${escapeHtml(r.type)}</strong>: ${escapeHtml(r.start)} to ${escapeHtml(r.end)}`;

                const del = document.createElement("button");
                del.textContent = "✕";
                del.style.border = "none";
                del.style.background = "transparent";
                del.style.color = "#9CA3AF";
                del.style.cursor = "pointer";
                del.onclick = () => {
                    item.timeRules.splice(i, 1);
                    saveData();
                    renderContent();
                    updateSummary();
                };

                row.appendChild(txt);
                row.appendChild(del);
                container.appendChild(row);
            });
        } else {
            container.innerHTML = `<div class="sa-muted" style="font-size:0.8rem; margin-bottom:10px;">No specific time rules (Available all day).</div>`;
        }

        // Add New Row
        const addRow = document.createElement("div");
        addRow.style.display = "flex";
        addRow.style.gap = "8px";
        addRow.style.marginTop = "12px";
        addRow.style.paddingTop = "12px";
        addRow.style.borderTop = "1px dashed #E5E7EB";
        addRow.style.flexWrap = "wrap";
        addRow.style.alignItems = "center";

        const typeSel = document.createElement("select");
        typeSel.innerHTML = `<option>Available</option><option>Unavailable</option>`;
        typeSel.className = "sa-field-input";

        const startIn = document.createElement("input");
        startIn.placeholder = "9:00am";
        startIn.className = "sa-field-input";
        startIn.style.width = "80px";

        const endIn = document.createElement("input");
        endIn.placeholder = "10:00am";
        endIn.className = "sa-field-input";
        endIn.style.width = "80px";

        const btn = document.createElement("button");
        btn.textContent = "Add";
        btn.style.background = "#111";
        btn.style.color = "white";
        btn.style.border = "none";
        btn.style.borderRadius = "6px";
        btn.style.padding = "6px 16px";
        btn.style.cursor = "pointer";

        btn.onclick = () => {
            if (!startIn.value || !endIn.value) {
                alert("Please enter both start and end times.");
                return;
            }
            if (parseTimeToMinutes(startIn.value) === null) {
                alert("Invalid Start Time format. Use format like 9:00am");
                return;
            }
            if (parseTimeToMinutes(endIn.value) === null) {
                alert("Invalid End Time format. Use format like 10:00am");
                return;
            }
            if (parseTimeToMinutes(startIn.value) >= parseTimeToMinutes(endIn.value)) {
                alert("End time must be after start time.");
                return;
            }
            item.timeRules.push({ 
                type: typeSel.value, 
                start: startIn.value, 
                end: endIn.value 
            });
            saveData();
            renderContent();
            updateSummary();
        };

        addRow.appendChild(typeSel);
        addRow.appendChild(startIn);
        addRow.appendChild(document.createTextNode(" to "));
        addRow.appendChild(endIn);
        addRow.appendChild(btn);

        container.appendChild(addRow);
    };

    renderContent();
    return container;
}

//------------------------------------------------------------------
// ADD SPECIAL
//------------------------------------------------------------------
function addSpecial() {
    const n = addSpecialInput.value.trim();
    if (!n) return;
    
    if (specialActivities.some(s => s.name.toLowerCase() === n.toLowerCase())) {
        alert("A special activity with that name already exists.");
        return;
    }

    specialActivities.push({
        name: n,
        available: true,
        sharableWith: { type: 'not_sharable', divisions: [], capacity: 2 },
        limitUsage: { enabled: false, divisions: {} },
        preferences: { enabled: false, exclusive: false, list: [] },
        timeRules: [],
        maxUsage: null,
        frequencyWeeks: 0,
        transition: {
            preMin: 0,
            postMin: 0,
            label: "Change Time",
            zone: window.DEFAULT_ZONE_NAME || "Default",
            occupiesField: true,
            minDurationMin: 0
        }
    });

    addSpecialInput.value = "";
    saveData();
    selectedItemId = `special-${n}`;
    renderMasterList();
    renderDetailPane();
}

//------------------------------------------------------------------
// HELPERS
//------------------------------------------------------------------
function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    const div = document.createElement("div");
    div.textContent = String(str);
    return div.innerHTML;
}

function makeEditable(el, save) {
    el.ondblclick = () => {
        const inp = document.createElement("input");
        inp.value = el.textContent;
        inp.style.fontSize = "inherit";
        inp.style.fontWeight = "inherit";
        inp.style.border = "1px solid #10B981";
        inp.style.outline = "none";
        inp.style.borderRadius = "4px";
        inp.style.padding = "2px 6px";
        inp.style.width = Math.max(100, el.offsetWidth + 20) + "px";
        el.replaceWith(inp);
        inp.focus();
        inp.select();

        const finish = () => {
            const newVal = inp.value.trim();
            if (newVal && newVal !== el.textContent) {
                save(newVal);
            } else {
                if (inp.parentNode) inp.replaceWith(el);
            }
        };

        inp.onblur = finish;
        inp.onkeyup = e => {
            if (e.key === "Enter") finish();
            if (e.key === "Escape") { inp.replaceWith(el); }
        };
    };
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
        if (hh === 12) hh = mer === "am" ? 0 : 12;
        else if (mer === "pm") hh += 12;
    }
    return hh * 60 + mm;
}

//------------------------------------------------------------------
// EXPORTS
//------------------------------------------------------------------
window.initSpecialActivitiesTab = initSpecialActivitiesTab;
window.specialActivities = specialActivities;

// Export getters for external access
window.getSpecialActivities = function() {
    return specialActivities;
};

window.getSpecialActivityByName = function(name) {
    return specialActivities.find(s => s.name === name);
};

})();
