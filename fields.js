// ============================================================================
// fields.js — MERGED: NEW UX + SPORT PLAYER REQS + RAINY DAY AVAILABILITY
// ============================================================================
// 1. Layout: Apple-inspired Two-Pane with Collapsible Detail Sections.
// 2. Logic: Retains all Transition, Sharing, Priority, and Sport Logic.
// 3. Fix: Access & Restrictions toggle stays open and updates locally.
// 4. Feat: Sport Player Requirements section.
// 5. NEW: Weather & Availability (Rainy Day Mode configuration).
// ============================================================================
(function(){
'use strict';

let fields = [];
let selectedItemId = null;
let fieldsListEl = null;
let detailPaneEl = null;
let addFieldInput = null;

// Sport metadata (min/max players) - synced with app1.js sportMetaData
let sportMetaData = {};

//------------------------------------------------------------------
// INIT
//------------------------------------------------------------------
function initFieldsTab(){
    const container = document.getElementById("fields");
    if(!container) return;
    
    loadData();

    // Clear any existing content first
    container.innerHTML = "";

    // Inject Styles for the new UI and the inner controls
    const style = document.createElement('style');
    style.innerHTML = `
        /* New UX Styles */
        .master-list { border: 1px solid #E5E7EB; border-radius: 12px; background: #fff; overflow: hidden; }
        .list-item { padding: 12px 14px; border-bottom: 1px solid #F3F4F6; cursor: pointer; display: flex; justify-content: space-between; align-items: center; transition: background 0.15s; }
        .list-item:last-child { border-bottom: none; }
        .list-item:hover { background: #F9FAFB; }
        .list-item.selected { background: #F0FDF4; border-left: 3px solid #10B981; }
        .list-item-name { font-weight: 500; color: #1F2937; font-size: 0.9rem; }
        .list-item-meta { font-size: 0.75rem; color: #6B7280; margin-left: 6px; }

        /* Accordion / Collapsible Sections */
        .detail-section { margin-bottom: 12px; border: 1px solid #E5E7EB; border-radius: 12px; background: #fff; overflow: hidden; }
        .detail-section-header { padding: 12px 16px; background: #F9FAFB; cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none; }
        .detail-section-header:hover { background: #F3F4F6; }
        .detail-section-title { font-size: 0.9rem; font-weight: 600; color: #111; }
        .detail-section-summary { font-size: 0.8rem; color: #6B7280; margin-top: 2px; }
        .detail-section-body { display: none; padding: 16px; border-top: 1px solid #E5E7EB; }
        
        /* Inner Controls (Chips, Priority Lists) */
        .chip { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 0.75rem; cursor: pointer; border: 1px solid #E5E7EB; margin-right: 4px; margin-bottom: 4px; transition: all 0.2s; }
        .chip.active { background: #10B981; color: white; border-color: #10B981; box-shadow: 0 2px 5px rgba(16, 185, 129, 0.3); }
        .chip.inactive { background: #F3F4F6; color: #374151; }
        .chip:hover { transform: translateY(-1px); }
        
        .priority-list-item { display: flex; align-items: center; gap: 10px; padding: 8px; background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 8px; margin-bottom: 6px; }
        .priority-btn { width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; border: 1px solid #D1D5DB; border-radius: 4px; background: white; cursor: pointer; font-size: 0.8rem; transition: all 0.15s; }
        .priority-btn:hover:not(:disabled) { border-color: #10B981; color: #10B981; }
        .priority-btn:disabled { opacity: 0.4; cursor: default; }

        .activity-button { padding: 6px 12px; border: 1px solid #E5E7EB; border-radius: 8px; background: white; cursor: pointer; font-size: 0.85rem; transition: all 0.2s; }
        .activity-button:hover { background: #F9FAFB; }
        .activity-button.active { background: #ECFDF5; color: #047857; border-color: #10B981; font-weight: 500; }
        
        /* Switch/Toggle */
        .switch { position: relative; display: inline-block; width: 34px; height: 20px; flex-shrink: 0; }
        .switch input { opacity: 0; width: 0; height: 0; }
        .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #ccc; transition: .4s; border-radius: 34px; }
        .slider:before { position: absolute; content: ""; height: 14px; width: 14px; left: 3px; bottom: 3px; background-color: white; transition: .4s; border-radius: 50%; }
        input:checked + .slider { background-color: #10B981; }
        input:checked + .slider:before { transform: translateX(14px); }

        /* Sport Rules Card */
        .sport-rules-card {
            border: 1px solid #E5E7EB;
            border-radius: 16px;
            padding: 20px;
            background: linear-gradient(135deg, #F0FDF4 0%, #FFFFFF 100%);
            margin-bottom: 24px;
        }
        .sport-rules-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            cursor: pointer;
            user-select: none;
        }
        .sport-rules-title {
            font-size: 1.1rem;
            font-weight: 600;
            color: #111827;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .sport-rules-badge {
            background: #10B981;
            color: white;
            padding: 2px 10px;
            border-radius: 999px;
            font-size: 0.7rem;
            font-weight: 600;
        }
        .sport-rule-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px 0;
            border-bottom: 1px solid #F3F4F6;
        }
        .sport-rule-row:last-child {
            border-bottom: none;
        }
        .sport-rule-name {
            font-weight: 500;
            color: #374151;
            flex: 1;
        }
        .sport-rule-inputs {
            display: flex;
            align-items: center;
            gap: 16px;
        }
        .sport-rule-input-group {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .sport-rule-label {
            font-size: 0.8rem;
            color: #6B7280;
        }
        .sport-rule-input {
            width: 60px;
            padding: 6px 8px;
            border: 1px solid #D1D5DB;
            border-radius: 6px;
            text-align: center;
            font-size: 0.9rem;
        }
        .sport-rule-input:focus {
            outline: none;
            border-color: #10B981;
            box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.2);
        }
        .sport-rules-hint {
            font-size: 0.85rem;
            color: #6B7280;
            margin-bottom: 16px;
            padding: 12px;
            background: #F9FAFB;
            border-radius: 8px;
            border-left: 3px solid #10B981;
        }

        /* Form inputs */
        .field-input {
            padding: 6px 10px;
            border: 1px solid #D1D5DB;
            border-radius: 6px;
            font-size: 0.9rem;
            transition: all 0.15s ease;
        }
        .field-input:focus {
            outline: none;
            border-color: #10B981;
            box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.2);
        }

        .muted {
            color: #6B7280;
            font-size: 0.85rem;
        }
    `;
    container.appendChild(style);

    // Create the main content wrapper
    const contentWrapper = document.createElement('div');
    contentWrapper.innerHTML = `
        <div class="setup-grid">
          <section class="setup-card setup-card-wide" style="border:none; box-shadow:none; background:transparent;">
            <div class="setup-card-header" style="margin-bottom:20px;">
              <span class="setup-step-pill">Fields</span>
              <div class="setup-card-text">
                <h3>Manage Fields & Facilities</h3>
                <p>Configure courts, fields, capabilities, restriction rules, and sport player requirements.</p>
              </div>
            </div>

            <!-- SPORT PLAYER REQUIREMENTS SECTION -->
            <div id="sport-rules-section"></div>

            <div style="display:flex; flex-wrap:wrap; gap:24px;">
              <!-- LEFT SIDE: MASTER LIST -->
              <div style="flex:1; min-width:280px;">
                <div style="display:flex; justify-content:space-between; align-items:end; margin-bottom:8px;">
                    <div class="setup-subtitle">All Fields</div>
                </div>
                
                <div style="background:white; padding:10px; border-radius:12px; border:1px solid #E5E7EB; margin-bottom:12px; display:flex; gap:8px;">
                  <input id="new-field-input" placeholder="New Field (e.g., Court 1)" style="flex:1; border:none; outline:none; font-size:0.9rem;">
                  <button id="add-field-btn" style="background:#111; color:white; border:none; border-radius:6px; padding:6px 12px; font-size:0.8rem; cursor:pointer;">Add</button>
                </div>

                <div id="fields-master-list" class="master-list" style="max-height:600px; overflow-y:auto;"></div>
              </div>

              <!-- RIGHT SIDE: DETAIL PANE -->
              <div style="flex:1.4; min-width:340px;">
                <div class="setup-subtitle">Field Configuration</div>
                <div id="fields-detail-pane" style="margin-top:8px;"></div>
              </div>
            </div>
          </section>
        </div>`;

    container.appendChild(contentWrapper);

    fieldsListEl = document.getElementById("fields-master-list");
    detailPaneEl = document.getElementById("fields-detail-pane");
    addFieldInput = document.getElementById("new-field-input");

    document.getElementById("add-field-btn").onclick = addField;
    addFieldInput.onkeyup = e => { if(e.key === "Enter") addField(); };

    renderSportRulesSection();
    renderMasterLists();
    renderDetailPane();
}

//------------------------------------------------------------------
// DATA LOADING
//------------------------------------------------------------------
function loadData(){
    const app1 = (window.loadGlobalSettings?.().app1) || {};
    fields = app1.fields || [];
    sportMetaData = app1.sportMetaData || {};

    fields.forEach(f => {
        f.available = f.available !== false;
        f.activities = f.activities || [];
        f.timeRules = f.timeRules || [];

        f.sharableWith = f.sharableWith || { type:"not_sharable", divisions:[], capacity:2 };
        if(!f.sharableWith.capacity) f.sharableWith.capacity = 2;
        
        f.limitUsage = f.limitUsage || { enabled:false, divisions:{} };
        f.preferences = f.preferences || { enabled:false, exclusive:false, list:[] };
        
        // Ensure Transition/Zone Logic exists
        f.transition = f.transition || {
            preMin:0,
            postMin:0,
            label:"Travel",
            zone:window.DEFAULT_ZONE_NAME || "Default",
            occupiesField:false,
            minDurationMin:0
        };

        // Rainy Day Default
        f.rainyDayAvailable = f.rainyDayAvailable ?? false;
    });
}

function saveData(){
    const settings = window.loadGlobalSettings?.() || {};
    settings.app1 = settings.app1 || {};
    settings.app1.fields = fields;
    settings.app1.sportMetaData = sportMetaData;
    window.saveGlobalSettings?.("app1", settings.app1);
}

//------------------------------------------------------------------
// SPORT RULES SECTION (Dropdown/Collapsible)
//------------------------------------------------------------------
function renderSportRulesSection() {
    const container = document.getElementById("sport-rules-section");
    if (!container) return;

    const allSports = window.getAllGlobalSports?.() || [];
    
    // Empty state handling
    if (allSports.length === 0) {
        container.innerHTML = `
            <div class="sport-rules-card">
                <div class="sport-rules-header">
                    <div class="sport-rules-title">
                        ⚡ Sports Rules
                    </div>
                </div>
                <div class="sport-rules-body" style="display:block; padding-top:10px; text-align:center;">
                    <p class="muted" style="padding:10px;">
                        No sports configured yet. Add sports to fields first.
                    </p>
                </div>
            </div>
        `;
        return;
    }

    let sportsHTML = '';
    const sortedSports = [...allSports].sort();

    sortedSports.forEach(sport => {
        const meta = sportMetaData[sport] || {};
        const minPlayers = meta.minPlayers || '';
        const maxPlayers = meta.maxPlayers || '';

        sportsHTML += `
            <div class="sport-rule-row">
                <span class="sport-rule-name">${escapeHtml(sport)}</span>
                <div class="sport-rule-inputs">
                    <div class="sport-rule-input-group">
                        <span class="sport-rule-label">Min:</span>
                        <input type="number" 
                               class="sport-rule-input" 
                               data-sport="${escapeHtml(sport)}" 
                               data-type="min"
                               value="${minPlayers}" 
                               placeholder="—"
                               min="1">
                    </div>
                    <div class="sport-rule-input-group">
                        <span class="sport-rule-label">Max:</span>
                        <input type="number" 
                               class="sport-rule-input" 
                               data-sport="${escapeHtml(sport)}" 
                               data-type="max"
                               value="${maxPlayers}" 
                               placeholder="∞"
                               min="1">
                    </div>
                </div>
            </div>
        `;
    });

    // Render the dropdown structure
    container.innerHTML = `
        <div class="sport-rules-card">
            <!-- Header (Toggle Trigger) -->
            <div class="sport-rules-header" id="sport-rules-toggle">
                <div class="sport-rules-title">
                    ⚡ Sports Rules
                </div>
                <span id="sport-rules-caret" style="transform: rotate(0deg); transition: transform 0.2s; color:#6B7280;">
                      <svg width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"></path></svg>
                </span>
            </div>
            
            <!-- Body (Collapsible Content) -->
            <div id="sport-rules-body" style="display:none; margin-top:16px; padding-top:16px; border-top:1px solid #E5E7EB;">
                <div class="sport-rules-hint">
                    <strong>How this works:</strong> Set minimum and maximum players for each sport. 
                    The scheduler will try to match bunks appropriately based on their sizes. 
                    If a bunk is too small, it may be paired with another bunk. 
                    If combined bunks are slightly over the max, the scheduler will still prefer a valid sport over "Free".
                </div>
                <div id="sport-rules-list">
                    ${sportsHTML}
                </div>
                <div style="margin-top:20px; text-align:right;">
                      <button id="save-sport-rules-btn" style="background:#10B981; color:white; border:none; padding:8px 24px; border-radius:999px; cursor:pointer; font-weight:600; font-size:0.9rem; box-shadow: 0 2px 5px rgba(16,185,129,0.3);">
                        Save Rules
                    </button>
                </div>
            </div>
        </div>
    `;

    // Toggle Logic
    const toggleBtn = document.getElementById('sport-rules-toggle');
    const bodyEl = document.getElementById('sport-rules-body');
    const caretEl = document.getElementById('sport-rules-caret');

    toggleBtn.onclick = () => {
        const isHidden = bodyEl.style.display === 'none';
        bodyEl.style.display = isHidden ? 'block' : 'none';
        caretEl.style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0deg)';
    };

    // Add event listeners for Inputs
    container.querySelectorAll('.sport-rule-input').forEach(input => {
        input.addEventListener('change', () => {
            const sport = input.dataset.sport;
            const type = input.dataset.type;
            const val = parseInt(input.value) || null;

            if (!sportMetaData[sport]) sportMetaData[sport] = {};
            
            if (type === 'min') {
                sportMetaData[sport].minPlayers = val;
            } else if (type === 'max') {
                sportMetaData[sport].maxPlayers = val;
            }
        });
    });

    // Save Button Logic
    const saveBtn = document.getElementById('save-sport-rules-btn');
    if(saveBtn) {
        saveBtn.onclick = (e) => {
            e.stopPropagation();

            // Collect all values
            container.querySelectorAll('.sport-rule-input').forEach(input => {
                const sport = input.dataset.sport;
                const type = input.dataset.type;
                const val = parseInt(input.value) || null;

                if (!sportMetaData[sport]) sportMetaData[sport] = {};
                
                if (type === 'min') {
                    sportMetaData[sport].minPlayers = val;
                } else if (type === 'max') {
                    sportMetaData[sport].maxPlayers = val;
                }
            });

            saveData();
            
            // Visual feedback
            const originalText = saveBtn.textContent;
            saveBtn.textContent = '✓ Saved!';
            saveBtn.style.background = '#059669';
            setTimeout(() => {
                saveBtn.textContent = originalText;
                saveBtn.style.background = '#10B981';
            }, 1500);
        };
    }
}

//------------------------------------------------------------------
// LEFT LIST
//------------------------------------------------------------------
function renderMasterLists(){
    fieldsListEl.innerHTML = "";

    if(fields.length === 0){
        fieldsListEl.innerHTML = `<div style="padding:20px; text-align:center; color:#9CA3AF;">No fields created yet.</div>`;
        return;
    }

    fields.forEach(f => fieldsListEl.appendChild(masterListItem(f)));
}

function masterListItem(item){
    const id = `field-${item.name}`;
    const el = document.createElement("div");
    el.className = "list-item" + (id === selectedItemId ? " selected" : "");
    el.onclick = ()=>{ selectedItemId = id; renderMasterLists(); renderDetailPane(); };

    const infoDiv = document.createElement("div");
    
    const name = document.createElement("div");
    name.className = "list-item-name";
    name.textContent = item.name;
    
    // Add meta info (Transition/Zone)
    if(item.transition.preMin > 0 || item.transition.postMin > 0){
        const meta = document.createElement("span");
        meta.className = "list-item-meta";
        meta.textContent = `(${item.transition.preMin}m / ${item.transition.postMin}m)`;
        name.appendChild(meta);
    }
    
    infoDiv.appendChild(name);
    el.appendChild(infoDiv);

    // Toggle Switch
    const tog = document.createElement("label");
    tog.className = "switch list-item-toggle";
    tog.onclick = e => e.stopPropagation();
    
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = item.available;
    cb.onchange = () => { item.available = cb.checked; saveData(); renderDetailPane(); };
    
    const slider = document.createElement("span"); 
    slider.className = "slider";
    tog.appendChild(cb); 
    tog.appendChild(slider);
    el.appendChild(tog);

    return el;
}

//------------------------------------------------------------------
// RIGHT PANEL — APPLE STYLE COLLAPSIBLE SECTIONS
//------------------------------------------------------------------
function renderDetailPane(){
    if(!selectedItemId){ 
        detailPaneEl.innerHTML = `
            <div style="height:300px; display:flex; align-items:center; justify-content:center; color:#9CA3AF; border:1px dashed #E5E7EB; border-radius:12px;">
                Select a field to edit details
            </div>`; 
        return; 
    }

    const [, name] = selectedItemId.split(/-(.+)/);
    const item = fields.find(f => f.name === name);

    if(!item){ 
        detailPaneEl.innerHTML = `<p class='muted'>Not found.</p>`; 
        return; 
    }

    const allSports = window.getAllGlobalSports?.() || [];
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

    makeEditable(title, newName=>{
        if(!newName.trim()) return;
        item.name = newName;
        selectedItemId = `field-${newName}`;
        saveData();
        renderMasterLists();
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

    delBtn.onclick = ()=>{
        if(confirm(`Delete "${item.name}"?`)){
            fields = fields.filter(f => f !== item);
            saveData();
            selectedItemId = null;
            renderMasterLists();
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
    availability.innerHTML = `<span>Field is <strong>${item.available ? 'AVAILABLE' : 'UNAVAILABLE'}</strong></span> <span style="font-size:0.8rem; opacity:0.8;">Toggle in master list</span>`;
    detailPaneEl.appendChild(availability);

    // -- 3. ACCORDION SECTIONS (Logic Wrappers) --
    
    // Activities
    detailPaneEl.appendChild(section("Activities", summaryActivities(item), 
        () => renderActivities(item, allSports)));

    // Transition & Zones
    detailPaneEl.appendChild(section("Transition & Zone Rules", summaryTransition(item), 
        () => renderTransition(item)));

    // Access & Priority
    detailPaneEl.appendChild(section("Access & Restrictions", summaryAccess(item), 
        () => renderAccess(item)));

    // Sharing Rules
    detailPaneEl.appendChild(section("Sharing Rules", summarySharing(item), 
        () => renderSharing(item)));

    // Time Rules
    detailPaneEl.appendChild(section("Time Rules", summaryTime(item), 
        () => renderTimeRules(item)));

    // Weather & Availability (Rainy Day)
    detailPaneEl.appendChild(section("Weather & Availability", summaryWeather(item), 
        () => renderWeatherSettings(item)));
}

//------------------------------------------------------------------
// SECTION BUILDER (Accordion UX)
//------------------------------------------------------------------
function section(title, summary, builder){
    const wrap = document.createElement("div"); 
    wrap.className = "detail-section";

    const head = document.createElement("div");
    head.className = "detail-section-header";

    const t = document.createElement("div");
    t.innerHTML = `<div class="detail-section-title">${escapeHtml(title)}</div><div class="detail-section-summary">${escapeHtml(summary)}</div>`;

    const caret = document.createElement("span");
    caret.innerHTML = `<svg width="20" height="20" fill="none" stroke="#9CA3AF" stroke-width="2" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"></path></svg>`;
    caret.style.transition = "transform 0.2s";

    head.appendChild(t);
    head.appendChild(caret);

    const body = document.createElement("div");
    body.className = "detail-section-body";

    head.onclick = ()=>{
        const open = body.style.display === "block";
        body.style.display = open ? "none" : "block";
        caret.style.transform = open ? "rotate(0deg)" : "rotate(90deg)";

        if(!open && !body.dataset.built){ 
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
// CONTENT GENERATORS
//------------------------------------------------------------------
function summaryActivities(f){ return f.activities.length ? `${f.activities.length} sports selected` : "No sports selected"; }
function summarySharing(f){ return f.sharableWith.type === "not_sharable" ? "Not sharable" : `Sharable (Max ${f.sharableWith.capacity})`; }
function summaryAccess(f){ 
    if(!f.limitUsage.enabled) return "Open to All Divisions";
    if(f.preferences.exclusive) return "Exclusive to specific divisions";
    return "Priority/Restrictions Active";
}
function summaryTransition(f){ return `${f.transition.preMin}m Pre / ${f.transition.postMin}m Post`; }
function summaryTime(f){ return f.timeRules.length ? `${f.timeRules.length} rule(s) active` : "Available all day"; }
function summaryWeather(f) { return f.rainyDayAvailable ? "🏠 Indoor (Rain OK)" : "🌳 Outdoor"; }

// 1. ACTIVITIES
function renderActivities(item, allSports){
    const box = document.createElement("div");
    const wrap = document.createElement("div"); 
    wrap.style.display = "flex"; 
    wrap.style.flexWrap = "wrap"; 
    wrap.style.gap = "8px"; 
    wrap.style.marginBottom = "12px";

    // Get the list of "built-in" sports that exist across all fields (for determining custom sports)
    const globalSports = window.getAllGlobalSports?.() || [];

    allSports.forEach(s=>{
        const b = document.createElement("button");
        b.textContent = s;
        b.className = "activity-button" + (item.activities.includes(s) ? " active" : "");
        
        // Check if this is a custom sport (only exists on this field)
        const isCustom = !globalSports.includes(s) || 
            (item.activities.includes(s) && fields.filter(f => f.activities.includes(s)).length === 1);
        
        if(isCustom && item.activities.includes(s)) {
            b.title = "Double-click to remove this custom activity";
        }

       let clickTimer = null;
        b.onclick = ()=>{
            if(clickTimer) {
                clearTimeout(clickTimer);
                clickTimer = null;
                return; // Double-click detected, let ondblclick handle it
            }
            clickTimer = setTimeout(() => {
                clickTimer = null;
                if(item.activities.includes(s)) item.activities = item.activities.filter(x=>x!==s);
                else item.activities.push(s);
                saveData(); 
                b.className = "activity-button" + (item.activities.includes(s) ? " active" : "");

                // Update summary without rerendering everything
                const summaryEl = b.closest('.detail-section').querySelector('.detail-section-summary');
                if(summaryEl) summaryEl.textContent = summaryActivities(item);

                // Re-render sport rules section to show updated sports
                renderSportRulesSection();
            }, 300);
        };

        
        // Double-click to delete custom activities
        b.ondblclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            // Cancel any pending single-click action
            if(clickTimer) {
                clearTimeout(clickTimer);
                clickTimer = null;
            }
            
            // Check how many fields use this sport
            const fieldsUsingSport = fields.filter(f => f.activities.includes(s));
            
            if(fieldsUsingSport.length > 1) {
                // Sport is used by multiple fields - just remove from this field
                if(confirm(`Remove "${s}" from this field? (Other fields still use this activity)`)) {
                    item.activities = item.activities.filter(x => x !== s);
                    saveData();
                    b.className = "activity-button";
                    
                    const summaryEl = b.closest('.detail-section')?.querySelector('.detail-section-summary');
                    if(summaryEl) summaryEl.textContent = summaryActivities(item);
                    
                    renderSportRulesSection();
                }
            } else {
                // Sport is only on this field (or not on any field) - delete it globally
                const msg = fieldsUsingSport.length === 1 
                    ? `Remove "${s}"? This will delete this activity completely.`
                    : `Delete "${s}" from all activities?`;
                    
                if(confirm(msg)) {
                    item.activities = item.activities.filter(x => x !== s);
                    
                    // Remove from all fields to ensure it's gone globally
                    fields.forEach(f => {
                        f.activities = f.activities.filter(x => x !== s);
                    });
                    
                    // Remove from sport metadata
                    delete sportMetaData[s];
                    
                    // Also call global remove if it exists
                    window.removeGlobalSport?.(s);
                    
                    saveData();
                    
                    // Re-render the activities section with fresh global sports list
                    const parentBody = box.parentElement;
                    if(parentBody) {
                        parentBody.innerHTML = '';
                        parentBody.appendChild(renderActivities(item, window.getAllGlobalSports?.() || []));
                    }
                    
                    // Update summary
                    const summaryEl = box.closest('.detail-section')?.querySelector('.detail-section-summary');
                    if(summaryEl) summaryEl.textContent = summaryActivities(item);
                    
                    renderSportRulesSection();
                }
            }
        };

        wrap.appendChild(b);
    });

    const add = document.createElement("input");
    add.placeholder = "Add new sport (Type & Enter)...";
    add.style.width = "100%";
    add.style.padding = "8px";
    add.style.borderRadius = "6px";
    add.style.border = "1px solid #D1D5DB";

    add.onkeyup = e=>{
        if(e.key==="Enter" && add.value.trim()){
            const s = add.value.trim();
            window.addGlobalSport?.(s);
            if(!item.activities.includes(s)) item.activities.push(s);
            saveData(); 
            
            // Re-render the activities section in place
            const parentBody = box.parentElement;
            if(parentBody) {
                parentBody.innerHTML = '';
                parentBody.appendChild(renderActivities(item, window.getAllGlobalSports?.() || []));
            }
            
            // Update summary
            const summaryEl = box.closest('.detail-section')?.querySelector('.detail-section-summary');
            if(summaryEl) summaryEl.textContent = summaryActivities(item);
            
            renderSportRulesSection();
        }
    };

    // Help text
    const helpText = document.createElement("div");
    helpText.style.fontSize = "0.75rem";
    helpText.style.color = "#9CA3AF";
    helpText.style.marginTop = "8px";
    helpText.textContent = "💡 Tip: Double-click an activity to remove it";

    box.appendChild(wrap);
    box.appendChild(add);
    box.appendChild(helpText);
    return box;
}

// 2. TRANSITION
function renderTransition(item){
    const t = item.transition;
    const box = document.createElement("div");
    const update = () => { saveData(); renderMasterLists(); };

    // Times
    const timeRow = document.createElement("div");
    timeRow.style.display="flex"; 
    timeRow.style.gap="12px"; 
    timeRow.style.marginBottom="12px";
    
    const mkInput = (lbl, val, setter) => {
        const d = document.createElement("div");
        d.innerHTML = `<label style="display:block; font-size:0.8rem; font-weight:600; margin-bottom:4px;">${lbl}</label>`;
        const i = document.createElement("input");
        i.type="number"; i.min="0"; i.step="5"; i.value=val;
        i.style.width="80px"; i.style.padding="6px"; i.style.border="1px solid #D1D5DB"; i.style.borderRadius="6px";
        i.onchange = ()=>{ setter(parseInt(i.value)||0); update(); };
        d.appendChild(i); 
        return d;
    };

    timeRow.appendChild(mkInput("Pre-Buffer (min)", t.preMin, v=>t.preMin=v));
    timeRow.appendChild(mkInput("Post-Buffer (min)", t.postMin, v=>t.postMin=v));
    box.appendChild(timeRow);

    // Label & Zone
    const metaRow = document.createElement("div");
    metaRow.style.display="flex"; 
    metaRow.style.gap="12px"; 
    metaRow.style.marginBottom="12px";
    
    // Zone Select
    const zoneDiv = document.createElement("div");
    zoneDiv.style.flex = "1";
    zoneDiv.innerHTML = `<label style="display:block; font-size:0.8rem; font-weight:600; margin-bottom:4px;">Zone (Location)</label>`;
    const zoneSel = document.createElement("select");
    zoneSel.style.width="100%"; zoneSel.style.padding="6px"; zoneSel.style.borderRadius="6px"; zoneSel.style.border="1px solid #D1D5DB";

    const zones = window.getZones?.() || {};
    Object.values(zones).forEach(z => {
        const opt = document.createElement("option");
        opt.value = z.name;
        opt.textContent = z.name + (z.isDefault ? " (Default)" : "");
        if(z.name === t.zone) opt.selected = true;
        zoneSel.appendChild(opt);
    });

    zoneSel.onchange = ()=>{ t.zone = zoneSel.value; update(); };
    zoneDiv.appendChild(zoneSel);
    metaRow.appendChild(zoneDiv);
    
    // Min Duration
    metaRow.appendChild(mkInput("Min Activity (min)", t.minDurationMin, v=>t.minDurationMin=v));
    
    box.appendChild(metaRow);

    // Occupancy Toggle
    const occLabel = document.createElement("label");
    occLabel.style.display="flex"; occLabel.style.alignItems="center"; occLabel.style.gap="8px"; occLabel.style.cursor="pointer";
    const occCk = document.createElement("input"); 
    occCk.type="checkbox"; 
    occCk.checked = t.occupiesField;
    occCk.onchange = ()=>{ t.occupiesField = occCk.checked; update(); };
    occLabel.appendChild(occCk);
    occLabel.appendChild(document.createTextNode("Buffer occupies field (e.g. Setup/Teardown)"));
    box.appendChild(occLabel);

    return box;
}

// 3. SHARING
function renderSharing(item){
    const container = document.createElement("div");

    // Helper to update the summary in the accordion header
    const updateSummary = () => {
        const summaryEl = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if(summaryEl) summaryEl.textContent = summarySharing(item);
    };

    // Main render function for this section
    const renderContent = () => {
        container.innerHTML = "";
        
        const rules = item.sharableWith;

        const tog = document.createElement("label"); 
        tog.className = "switch";
        const cb = document.createElement("input"); 
        cb.type = "checkbox";
        cb.checked = rules.type !== 'not_sharable';

        cb.onchange = ()=>{
            rules.type = cb.checked ? 'all' : 'not_sharable';
            rules.divisions = [];
            saveData();
            renderContent();
            updateSummary();
        };

        const sl = document.createElement("span"); 
        sl.className = "slider";
        tog.appendChild(cb); 
        tog.appendChild(sl);
        
        const header = document.createElement("div");
        header.style.display="flex"; header.style.alignItems="center"; header.style.gap="10px";
        header.appendChild(tog);
        header.appendChild(document.createTextNode("Allow Sharing (Multiple bunks at once)"));
        container.appendChild(header);

        if(rules.type !== 'not_sharable'){
            const det = document.createElement("div");
            det.style.marginTop="16px"; det.style.paddingLeft="12px"; det.style.borderLeft="2px solid #E5E7EB";

            // Capacity
            const capRow = document.createElement("div");
            capRow.style.marginBottom="12px";
            capRow.innerHTML = `<span>Max Capacity: </span>`;
            const capIn = document.createElement("input"); 
            capIn.type="number"; capIn.min="2"; capIn.value=rules.capacity;
            capIn.style.width="60px"; capIn.style.marginLeft="8px"; capIn.style.padding="4px";
            capIn.onchange = ()=>{ rules.capacity = Math.max(2, parseInt(capIn.value)||2); saveData(); };
            capRow.appendChild(capIn);
            det.appendChild(capRow);

            // Limit Divisions
            const divLabel = document.createElement("div");
            divLabel.textContent = "Limit sharing to specific divisions (Optional):";
            divLabel.style.fontSize="0.85rem"; divLabel.style.marginBottom="6px";
            det.appendChild(divLabel);

            const allDivs = window.availableDivisions || [];
            allDivs.forEach(d => {
                const isActive = rules.divisions.includes(d);
                const chip = document.createElement("span");
                chip.className = "chip " + (isActive ? "active" : "inactive");
                chip.textContent = d;
                chip.onclick = ()=>{
                    if(isActive) rules.divisions = rules.divisions.filter(x=>x!==d);
                    else rules.divisions.push(d);
                    rules.type = rules.divisions.length > 0 ? 'custom' : 'all';
                    saveData();
                    chip.className = "chip " + (rules.divisions.includes(d) ? "active" : "inactive");
                };
                det.appendChild(chip);
            });

            container.appendChild(det);
        }
    };

    renderContent();
    return container;
}

// 4. ACCESS & PRIORITY
function renderAccess(item){
    const container = document.createElement("div");

    // Helper to update the summary in the accordion header
    const updateSummary = () => {
        const summaryEl = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if(summaryEl) summaryEl.textContent = summaryAccess(item);
    };

    // Main render function for this section
    const renderContent = () => {
        container.innerHTML = "";
        
        const rules = item.limitUsage;
        const prefs = item.preferences;

        // Toggle Mode Buttons
        const modeWrap = document.createElement("div");
        modeWrap.style.display="flex"; modeWrap.style.gap="12px"; modeWrap.style.marginBottom="16px";
        
        const btnAll = document.createElement("button");
        btnAll.textContent = "Open to All";
        btnAll.style.cssText = `flex:1; padding:8px; border-radius:6px; border:1px solid #E5E7EB; cursor:pointer; background:${!rules.enabled ? '#ECFDF5' : '#fff'}; color:${!rules.enabled ? '#047857' : '#333'}; border-color:${!rules.enabled ? '#10B981' : '#E5E7EB'}; font-weight:${!rules.enabled ? '600' : '400'}; transition:all 0.2s;`;
        
        const btnRes = document.createElement("button");
        btnRes.textContent = "Restricted / Priority";
        btnRes.style.cssText = `flex:1; padding:8px; border-radius:6px; border:1px solid #E5E7EB; cursor:pointer; background:${rules.enabled ? '#ECFDF5' : '#fff'}; color:${rules.enabled ? '#047857' : '#333'}; border-color:${rules.enabled ? '#10B981' : '#E5E7EB'}; font-weight:${rules.enabled ? '600' : '400'}; transition:all 0.2s;`;

        btnAll.onclick = ()=>{ 
            rules.enabled=false; 
            prefs.enabled=false; 
            saveData(); 
            renderContent(); 
            updateSummary();
        };

        btnRes.onclick = ()=>{ 
            rules.enabled=true; 
            prefs.enabled=true; 
            saveData(); 
            renderContent(); 
            updateSummary();
        };

        modeWrap.appendChild(btnAll);
        modeWrap.appendChild(btnRes);
        container.appendChild(modeWrap);

        if(rules.enabled){
            const body = document.createElement("div");
            
            // Exclusive Checkbox
            const exLabel = document.createElement("label");
            exLabel.style.display="flex"; exLabel.style.alignItems="center"; exLabel.style.gap="8px"; exLabel.style.marginBottom="12px"; exLabel.style.cursor="pointer";
            const exCk = document.createElement("input"); 
            exCk.type="checkbox"; 
            exCk.checked=prefs.exclusive;
            exCk.onchange = ()=>{ prefs.exclusive=exCk.checked; saveData(); updateSummary(); };
            exLabel.appendChild(exCk);
            exLabel.appendChild(document.createTextNode("Exclusive Mode (Only allowed divisions can use this)"));
            body.appendChild(exLabel);

            // Priority List
            const pHeader = document.createElement("div");
            pHeader.textContent = "Priority Order (Top = First Choice):";
            pHeader.style.fontSize="0.85rem"; pHeader.style.fontWeight="600"; pHeader.style.marginBottom="6px";
            body.appendChild(pHeader);

            const listContainer = document.createElement("div");
            
            prefs.list = (prefs.list || []).filter(d => rules.divisions.hasOwnProperty(d));

            if(prefs.list.length === 0) {
                listContainer.innerHTML = `<div class="muted" style="font-size:0.8rem; font-style:italic; padding:4px; color:#6B7280;">No priority divisions set. Add below.</div>`;
            }
            
            prefs.list.forEach((divName, idx) => {
                const row = document.createElement("div"); 
                row.className = "priority-list-item";
                row.innerHTML = `<span style="font-weight:bold; color:#10B981; width:20px;">${idx+1}</span> <span style="flex:1;">${escapeHtml(divName)}</span>`;
                
                const ctrls = document.createElement("div"); 
                ctrls.style.display="flex"; 
                ctrls.style.gap="4px";
                
                const mkBtn = (txt, fn, dis) => {
                    const b = document.createElement("button"); 
                    b.className="priority-btn"; 
                    b.textContent=txt;
                    if(dis) b.disabled=true; 
                    else b.onclick=fn;
                    return b;
                };
                
                ctrls.appendChild(mkBtn("↑", ()=>{ 
                    [prefs.list[idx-1], prefs.list[idx]] = [prefs.list[idx], prefs.list[idx-1]]; 
                    saveData(); 
                    renderContent(); 
                }, idx===0));
                
                ctrls.appendChild(mkBtn("↓", ()=>{ 
                    [prefs.list[idx+1], prefs.list[idx]] = [prefs.list[idx], prefs.list[idx+1]]; 
                    saveData(); 
                    renderContent(); 
                }, idx===prefs.list.length-1));
                
                const rm = mkBtn("✕", ()=>{ 
                    prefs.list = prefs.list.filter(d=>d!==divName); 
                    saveData(); 
                    renderContent(); 
                }, false);
                rm.style.color="#DC2626"; 
                rm.style.borderColor="#FECACA";
                ctrls.appendChild(rm);

                row.appendChild(ctrls);
                listContainer.appendChild(row);
            });

            body.appendChild(listContainer);

            // Division Selector Chips
            const divHeader = document.createElement("div");
            divHeader.textContent = "Allowed Divisions (Click to add/remove from priority):";
            divHeader.style.fontSize="0.85rem"; divHeader.style.fontWeight="600"; divHeader.style.marginTop="16px"; divHeader.style.marginBottom="6px";
            body.appendChild(divHeader);

            const chipWrap = document.createElement("div");
            const availableDivisions = window.availableDivisions || [];

            availableDivisions.forEach(divName => {
                const isAllowed = divName in rules.divisions;
                const c = document.createElement("span");
                c.className = "chip " + (isAllowed ? "active" : "inactive");
                c.textContent = divName;
                c.onclick = ()=>{
                    if(isAllowed){
                        delete rules.divisions[divName];
                        prefs.list = prefs.list.filter(d => d !== divName);
                    } else {
                        rules.divisions[divName] = [];
                        if(!prefs.list.includes(divName)) prefs.list.push(divName);
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
function renderTimeRules(item){
    const container = document.createElement("div");
    
    // Existing Rules
    if(item.timeRules.length > 0){
        item.timeRules.forEach((r, i) => {
            const row = document.createElement("div");
            row.style.display="flex"; row.style.justifyContent="space-between"; row.style.alignItems="center";
            row.style.background="#F9FAFB"; row.style.padding="8px"; row.style.marginBottom="6px"; row.style.borderRadius="6px"; row.style.border="1px solid #E5E7EB";
            
            const txt = document.createElement("span");
            txt.innerHTML = `<strong style="color:${r.type==='Available'?'#059669':'#DC2626'}">${escapeHtml(r.type)}</strong>: ${escapeHtml(r.start)} to ${escapeHtml(r.end)}`;
            
            const del = document.createElement("button");
            del.textContent="✕"; del.style.border="none"; del.style.background="transparent"; del.style.color="#9CA3AF"; del.style.cursor="pointer";
            del.onclick = ()=>{ item.timeRules.splice(i,1); saveData(); renderDetailPane(); };
            
            row.appendChild(txt); 
            row.appendChild(del);
            container.appendChild(row);
        });
    } else {
        container.innerHTML = `<div class="muted" style="font-size:0.8rem; margin-bottom:10px;">No specific time rules (Available all day).</div>`;
    }

    // Add New
    const addRow = document.createElement("div");
    addRow.style.display="flex"; addRow.style.gap="8px"; addRow.style.marginTop="12px"; addRow.style.paddingTop="12px"; addRow.style.borderTop="1px dashed #E5E7EB"; addRow.style.flexWrap="wrap"; addRow.style.alignItems="center";
    
    const typeSel = document.createElement("select");
    typeSel.innerHTML = `<option>Available</option><option>Unavailable</option>`;
    typeSel.style.borderRadius="6px"; typeSel.style.border="1px solid #D1D5DB"; typeSel.style.padding="4px";
    
    const startIn = document.createElement("input"); 
    startIn.placeholder="9:00am"; 
    startIn.style.width="70px"; startIn.style.padding="4px"; startIn.style.borderRadius="6px"; startIn.style.border="1px solid #D1D5DB";

    const endIn = document.createElement("input"); 
    endIn.placeholder="10:00am"; 
    endIn.style.width="70px"; endIn.style.padding="4px"; endIn.style.borderRadius="6px"; endIn.style.border="1px solid #D1D5DB";
    
    const btn = document.createElement("button");
    btn.textContent="Add"; 
    btn.style.background="#111"; btn.style.color="white"; btn.style.border="none"; btn.style.borderRadius="6px"; btn.style.padding="4px 12px"; btn.style.cursor="pointer";
    
    btn.onclick = ()=>{
        if(!startIn.value || !endIn.value) { 
            alert("Please enter both start and end times."); 
            return; 
        }
        if(parseTimeToMinutes(startIn.value) === null){ 
            alert("Invalid Start Time format. Use format like 9:00am"); 
            return; 
        }
        if(parseTimeToMinutes(endIn.value) === null){ 
            alert("Invalid End Time format. Use format like 10:00am"); 
            return; 
        }
        item.timeRules.push({ type: typeSel.value, start: startIn.value, end: endIn.value });
        saveData();
        renderDetailPane();
    };

    addRow.appendChild(typeSel);
    addRow.appendChild(startIn);
    addRow.appendChild(document.createTextNode(" to "));
    addRow.appendChild(endIn);
    addRow.appendChild(btn);
    
    container.appendChild(addRow);
    return container;
}

// 6. WEATHER / RAINY DAY AVAILABILITY
function renderWeatherSettings(item) {
    const container = document.createElement("div");
    
    const isIndoor = item.rainyDayAvailable === true;
    
    container.innerHTML = `
        <div style="margin-bottom: 16px;">
            <p style="font-size: 0.85rem; color: #6b7280; margin: 0 0 12px 0;">
                Mark this field as indoor/covered to keep it available during Rainy Day Mode.
                Outdoor fields will be automatically disabled when rainy weather is activated.
            </p>
            
            <div style="display: flex; align-items: center; gap: 12px; padding: 14px; 
                        background: ${isIndoor ? '#ecfdf5' : '#fef3c7'}; 
                        border: 1px solid ${isIndoor ? '#a7f3d0' : '#fcd34d'};
                        border-radius: 10px; transition: all 0.2s ease;">
                <span style="font-size: 28px;">${isIndoor ? '🏠' : '🌳'}</span>
                <div style="flex: 1;">
                    <div style="font-weight: 600; color: ${isIndoor ? '#065f46' : '#92400e'};">
                        ${isIndoor ? 'Indoor / Covered' : 'Outdoor'}
                    </div>
                    <div style="font-size: 0.85rem; color: ${isIndoor ? '#047857' : '#b45309'};">
                        ${isIndoor ? 'Available on rainy days' : 'Disabled during rainy days'}
                    </div>
                </div>
                <label class="switch">
                    <input type="checkbox" id="rainy-day-toggle" ${isIndoor ? 'checked' : ''}>
                    <span class="slider"></span>
                </label>
            </div>
        </div>
        
        <div style="background: #f9fafb; border-radius: 8px; padding: 12px; font-size: 0.85rem; color: #4b5563;">
            <strong>💡 Tip:</strong> Indoor facilities like gyms, covered courts, and activity rooms 
            should be marked as indoor. Outdoor fields like soccer fields, baseball diamonds, 
            and open courts should remain as outdoor.
        </div>
    `;
    
    // Bind toggle
    container.querySelector('#rainy-day-toggle').onchange = function() {
        item.rainyDayAvailable = this.checked;
        saveData();

        // Update the parent container to reflect the change
        const parentContainer = container.parentElement;
        parentContainer.innerHTML = '';
        parentContainer.appendChild(renderWeatherSettings(item));

        // Update summary
        const summaryEl = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if (summaryEl) summaryEl.textContent = summaryWeather(item);
    };
    
    return container;
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

function makeEditable(el, save){
    el.ondblclick = ()=>{
        const inp = document.createElement("input"); 
        inp.value = el.textContent;
        inp.style.fontSize = "inherit"; 
        inp.style.fontWeight = "inherit"; 
        inp.style.border="1px solid #10B981"; 
        inp.style.outline="none"; 
        inp.style.borderRadius="4px";
        inp.style.padding = "2px 6px";
        inp.style.width = Math.max(100, el.offsetWidth + 20) + "px";

        el.replaceWith(inp); 
        inp.focus();
        inp.select();

        const finish = ()=>{ 
            const newVal = inp.value.trim();
            if(newVal && newVal !== el.textContent) {
                save(newVal); 
            } else {
                if(inp.parentNode) inp.replaceWith(el); 
            }
        };

        inp.onblur = finish;
        inp.onkeyup = e=>{ 
            if(e.key==="Enter") finish(); 
            if(e.key==="Escape") { inp.replaceWith(el); }
        };
    };
}

function addField(){
    const n = addFieldInput.value.trim();
    if(!n) return;

    if(fields.some(f=>f.name.toLowerCase() === n.toLowerCase())){ 
        alert("A field with that name already exists."); 
        return; 
    }

    fields.push({
        name: n,
        activities: [],
        available: true,
        sharableWith: { type:'not_sharable', divisions:[], capacity:2 },
        limitUsage: { enabled:false, divisions:{} },
        preferences: { enabled:false, exclusive:false, list:[] },
        timeRules: [],
        transition: { preMin:0, postMin:0, label:"Travel", zone:window.DEFAULT_ZONE_NAME || "Default", occupiesField:false, minDurationMin:0 },
        rainyDayAvailable: false
    });

    addFieldInput.value = "";
    saveData();
    selectedItemId = `field-${n}`;
    renderMasterLists(); 
    renderDetailPane();
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
window.initFieldsTab = initFieldsTab;
window.fields = fields;

// Export sport metadata getter for scheduler
window.getSportMetaData = function() {
    return sportMetaData;
};

// Export for external access
window.getFields = function() {
    return fields;
};

window.getFieldByName = function(name) {
    return fields.find(f => f.name === name);
};

})();
