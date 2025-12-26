// ============================================================================
// locations.js — LOCATION ZONES & FACILITIES MANAGEMENT
// ============================================================================
// This module manages:
// 1. ZONES - Physical areas with transition times (Main Campus, #2 School, etc.)
// 2. FIELDS IN ZONE - Which sports fields belong to each zone
// 3. LOCATIONS/FACILITIES - Non-field spaces (Pool, Lunchroom, Gym, Auditorium)
//
// KEY CONCEPT: Location capacity = 1 ACTIVITY at a time (unlimited bunks)
// If Lunch is happening in Lunchroom, 20 bunks can be there.
// But Skits CANNOT happen there at the same time because it's a different activity.
// ============================================================================
(function(){
'use strict';

let locationZones = {};
let selectedZoneId = null;
let zonesListEl = null;
let detailPaneEl = null;
let addZoneInput = null;

//------------------------------------------------------------------
// INIT
//------------------------------------------------------------------
function initLocationsTab(){
    const container = document.getElementById("locations");
    if(!container) return;
    
    loadData();

    container.innerHTML = "";

    // Inject Styles
    const style = document.createElement('style');
    style.innerHTML = `
        /* Two-pane layout styles */
        .locations-master-list { border: 1px solid #E5E7EB; border-radius: 12px; background: #fff; overflow: hidden; }
        .locations-list-item { padding: 12px 14px; border-bottom: 1px solid #F3F4F6; cursor: pointer; display: flex; justify-content: space-between; align-items: center; transition: background 0.15s; }
        .locations-list-item:last-child { border-bottom: none; }
        .locations-list-item:hover { background: #F9FAFB; }
        .locations-list-item.selected { background: #EFF6FF; border-left: 3px solid #3B82F6; }
        .locations-list-item-name { font-weight: 500; color: #1F2937; font-size: 0.9rem; }
        .locations-list-item-meta { font-size: 0.75rem; color: #6B7280; margin-left: 6px; }
        .locations-list-item-badge { font-size: 0.65rem; padding: 2px 6px; border-radius: 4px; background: #DBEAFE; color: #1E40AF; margin-left: 8px; }

        /* Detail Section Accordion */
        .loc-detail-section { margin-bottom: 12px; border: 1px solid #E5E7EB; border-radius: 12px; background: #fff; overflow: hidden; }
        .loc-detail-section-header { padding: 12px 16px; background: #F9FAFB; cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none; }
        .loc-detail-section-header:hover { background: #F3F4F6; }
        .loc-detail-section-title { font-size: 0.9rem; font-weight: 600; color: #111; }
        .loc-detail-section-summary { font-size: 0.8rem; color: #6B7280; margin-top: 2px; }
        .loc-detail-section-body { display: none; padding: 16px; border-top: 1px solid #E5E7EB; }

        /* Multi-select dropdown */
        .multi-select-dropdown { position: relative; }
        .multi-select-trigger { 
            width: 100%; padding: 10px 12px; border: 1px solid #D1D5DB; border-radius: 8px; 
            background: #fff; cursor: pointer; display: flex; justify-content: space-between; 
            align-items: center; min-height: 42px; flex-wrap: wrap; gap: 4px;
        }
        .multi-select-trigger:hover { border-color: #9CA3AF; }
        .multi-select-trigger.open { border-color: #3B82F6; box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2); }
        .multi-select-placeholder { color: #9CA3AF; }
        .multi-select-tag { 
            background: #DBEAFE; color: #1E40AF; padding: 2px 8px; border-radius: 4px; 
            font-size: 0.8rem; display: inline-flex; align-items: center; gap: 4px;
        }
        .multi-select-tag-remove { cursor: pointer; opacity: 0.7; }
        .multi-select-tag-remove:hover { opacity: 1; }
        .multi-select-options { 
            position: absolute; top: 100%; left: 0; right: 0; z-index: 100;
            background: #fff; border: 1px solid #D1D5DB; border-radius: 8px; 
            margin-top: 4px; max-height: 200px; overflow-y: auto;
            box-shadow: 0 4px 12px rgba(0,0,0,0.1); display: none;
        }
        .multi-select-options.show { display: block; }
        .multi-select-option { 
            padding: 10px 12px; cursor: pointer; display: flex; align-items: center; gap: 8px;
            transition: background 0.1s;
        }
        .multi-select-option:hover { background: #F3F4F6; }
        .multi-select-option.selected { background: #EFF6FF; }
        .multi-select-checkbox { width: 16px; height: 16px; accent-color: #3B82F6; }

        /* Location item in list */
        .location-item { 
            display: flex; justify-content: space-between; align-items: center;
            padding: 10px 12px; background: #F9FAFB; border: 1px solid #E5E7EB; 
            border-radius: 8px; margin-bottom: 6px;
        }
        .location-item-name { font-weight: 500; color: #374151; }
        .location-item-actions { display: flex; gap: 8px; align-items: center; }
        .location-delete-btn { 
            background: transparent; border: none; color: #DC2626; cursor: pointer;
            padding: 4px 8px; border-radius: 4px; font-size: 0.85rem;
        }
        .location-delete-btn:hover { background: #FEE2E2; }

        /* Form inputs */
        .loc-input {
            padding: 8px 12px; border: 1px solid #D1D5DB; border-radius: 6px;
            font-size: 0.9rem; transition: all 0.15s ease; width: 100%; box-sizing: border-box;
        }
        .loc-input:focus {
            outline: none; border-color: #3B82F6;
            box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
        }
        .loc-input-small { width: 80px; text-align: center; }

        .loc-muted { color: #6B7280; font-size: 0.85rem; }

        /* Info callout */
        .loc-info-callout {
            background: #F0F9FF; border: 1px solid #BAE6FD; border-radius: 8px;
            padding: 12px 16px; font-size: 0.85rem; color: #0369A1;
            display: flex; align-items: flex-start; gap: 10px; margin-bottom: 16px;
        }
        .loc-info-callout svg { flex-shrink: 0; margin-top: 2px; }
    `;
    container.appendChild(style);

    // Create the main content wrapper
    const contentWrapper = document.createElement('div');
    contentWrapper.innerHTML = `
        <div class="setup-grid">
          <section class="setup-card setup-card-wide" style="border:none; box-shadow:none; background:transparent;">
            <div class="setup-card-header" style="margin-bottom:20px;">
              <span class="setup-step-pill">Locations</span>
              <div class="setup-card-text">
                <h3>Location Zones & Facilities</h3>
                <p>Organize physical areas, assign fields to zones, and create locations like Pool, Lunchroom, Gym.</p>
              </div>
            </div>

            <div class="loc-info-callout">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <path d="M12 16v-4M12 8h.01"></path>
                </svg>
                <div>
                    <strong>How Locations Work:</strong> Each location (Pool, Lunchroom, etc.) can only have 
                    <strong>one activity at a time</strong>. Multiple bunks can participate in that activity, 
                    but no other activity can use that space simultaneously. For example, if Lunch is in the 
                    Lunchroom, Skits cannot happen there at the same time.
                </div>
            </div>

            <div style="display:flex; flex-wrap:wrap; gap:24px;">
              <!-- LEFT SIDE: ZONES LIST -->
              <div style="flex:1; min-width:280px;">
                <div style="display:flex; justify-content:space-between; align-items:end; margin-bottom:8px;">
                    <div class="setup-subtitle">Zones</div>
                </div>
                
                <div style="background:white; padding:10px; border-radius:12px; border:1px solid #E5E7EB; margin-bottom:12px; display:flex; gap:8px;">
                  <input id="new-zone-input" placeholder="New Zone (e.g., Lake Area)" class="loc-input" style="flex:1; border:none;">
                  <button id="add-zone-btn" style="background:#111; color:white; border:none; border-radius:6px; padding:6px 12px; font-size:0.8rem; cursor:pointer;">Add</button>
                </div>

                <div id="zones-master-list" class="locations-master-list" style="max-height:500px; overflow-y:auto;"></div>
              </div>

              <!-- RIGHT SIDE: ZONE DETAIL PANE -->
              <div style="flex:1.8; min-width:400px;">
                <div class="setup-subtitle">Zone Configuration</div>
                <div id="zones-detail-pane" style="margin-top:8px;"></div>
              </div>
            </div>
          </section>
        </div>`;

    container.appendChild(contentWrapper);

    zonesListEl = document.getElementById("zones-master-list");
    detailPaneEl = document.getElementById("zones-detail-pane");
    addZoneInput = document.getElementById("new-zone-input");

    document.getElementById("add-zone-btn").onclick = addZone;
    addZoneInput.onkeyup = e => { if(e.key === "Enter") addZone(); };

    renderZonesList();
    renderDetailPane();
}

//------------------------------------------------------------------
// DATA LOADING / SAVING
//------------------------------------------------------------------
function loadData(){
    const settings = window.loadGlobalSettings?.() || {};
    locationZones = settings.locationZones || {};

    // Create default "Main Campus" zone if none exist
    if(Object.keys(locationZones).length === 0){
        locationZones["Main Campus"] = {
            name: "Main Campus",
            isDefault: true,
            transition: { preMin: 0, postMin: 0 },  // DEFAULT = 0 for Main Campus
            maxConcurrent: 99,
            fields: [],
            locations: {}
        };
    }

    // Ensure all zones have required properties
    Object.values(locationZones).forEach(zone => {
        zone.transition = zone.transition || { preMin: 0, postMin: 0 };
        zone.maxConcurrent = zone.maxConcurrent ?? 99;
        zone.fields = zone.fields || [];
        zone.locations = zone.locations || {};
    });
}

function saveData(){
    const settings = window.loadGlobalSettings?.() || {};
    settings.locationZones = locationZones;
    window.saveGlobalSettings?.("locationZones", locationZones);
}

//------------------------------------------------------------------
// ZONES LIST (Left Panel)
//------------------------------------------------------------------
function renderZonesList(){
    zonesListEl.innerHTML = "";

    const zoneNames = Object.keys(locationZones).sort((a, b) => {
        // Default zone first
        if(locationZones[a].isDefault) return -1;
        if(locationZones[b].isDefault) return 1;
        return a.localeCompare(b);
    });

    if(zoneNames.length === 0){
        zonesListEl.innerHTML = `<div style="padding:20px; text-align:center; color:#9CA3AF;">No zones created yet.</div>`;
        return;
    }

    zoneNames.forEach(name => {
        const zone = locationZones[name];
        zonesListEl.appendChild(createZoneListItem(zone));
    });
}

function createZoneListItem(zone){
    const el = document.createElement("div");
    el.className = "locations-list-item" + (selectedZoneId === zone.name ? " selected" : "");
    el.onclick = ()=>{ selectedZoneId = zone.name; renderZonesList(); renderDetailPane(); };

    const infoDiv = document.createElement("div");
    infoDiv.style.display = "flex";
    infoDiv.style.alignItems = "center";
    
    const name = document.createElement("span");
    name.className = "locations-list-item-name";
    name.textContent = zone.name;
    
    if(zone.isDefault){
        const badge = document.createElement("span");
        badge.className = "locations-list-item-badge";
        badge.textContent = "Default";
        name.appendChild(badge);
    }
    
    infoDiv.appendChild(name);

    // Show summary
    const meta = document.createElement("div");
    meta.className = "locations-list-item-meta";
    const fieldCount = zone.fields?.length || 0;
    const locCount = Object.keys(zone.locations || {}).length;
    meta.textContent = `${fieldCount} field${fieldCount !== 1 ? 's' : ''} • ${locCount} location${locCount !== 1 ? 's' : ''}`;
    
    const wrapper = document.createElement("div");
    wrapper.appendChild(infoDiv);
    wrapper.appendChild(meta);
    
    el.appendChild(wrapper);

    // Transition time indicator
    const transDiv = document.createElement("div");
    transDiv.style.fontSize = "0.75rem";
    transDiv.style.color = "#6B7280";
    transDiv.style.textAlign = "right";
    transDiv.innerHTML = `${zone.transition.preMin}m / ${zone.transition.postMin}m`;
    el.appendChild(transDiv);

    return el;
}

//------------------------------------------------------------------
// DETAIL PANE (Right Panel)
//------------------------------------------------------------------
function renderDetailPane(){
    if(!selectedZoneId || !locationZones[selectedZoneId]){ 
        detailPaneEl.innerHTML = `
            <div style="height:300px; display:flex; align-items:center; justify-content:center; color:#9CA3AF; border:1px dashed #E5E7EB; border-radius:12px;">
                Select a zone to configure
            </div>`; 
        return; 
    }

    const zone = locationZones[selectedZoneId];
    detailPaneEl.innerHTML = "";

    // -- HEADER --
    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.alignItems = "center";
    header.style.marginBottom = "16px";

    const title = document.createElement("h2");
    title.textContent = zone.name;
    title.style.margin = "0";
    title.style.fontSize = "1.25rem";
    title.title = "Double click to rename";

    if(!zone.isDefault){
        makeEditable(title, newName => {
            if(!newName.trim()) return;
            if(locationZones[newName] && newName !== zone.name){
                alert("A zone with that name already exists.");
                return;
            }
            delete locationZones[zone.name];
            zone.name = newName;
            locationZones[newName] = zone;
            selectedZoneId = newName;
            saveData();
            renderZonesList();
            renderDetailPane();
        });
    }

    const btnGroup = document.createElement("div");
    btnGroup.style.display = "flex";
    btnGroup.style.gap = "8px";

    if(!zone.isDefault){
        const delBtn = document.createElement("button");
        delBtn.innerHTML = `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg> Delete`;
        delBtn.style.cssText = "color:#DC2626; background:#FEF2F2; border:1px solid #FECACA; padding:6px 12px; border-radius:6px; cursor:pointer; display:flex; gap:6px; align-items:center;";
        delBtn.onclick = () => {
            if(confirm(`Delete zone "${zone.name}"? Fields will be unassigned.`)){
                delete locationZones[zone.name];
                saveData();
                selectedZoneId = null;
                renderZonesList();
                renderDetailPane();
            }
        };
        btnGroup.appendChild(delBtn);
    }

    header.appendChild(title);
    header.appendChild(btnGroup);
    detailPaneEl.appendChild(header);

    // -- DEFAULT INDICATOR --
    if(zone.isDefault){
        const defaultStrip = document.createElement("div");
        defaultStrip.style.cssText = "padding:10px 14px; background:#DBEAFE; border:1px solid #93C5FD; border-radius:8px; margin-bottom:16px; color:#1E40AF; font-size:0.85rem;";
        defaultStrip.innerHTML = `<strong>Default Zone</strong> — Fields not assigned to any zone will use these settings.`;
        detailPaneEl.appendChild(defaultStrip);
    }

    // -- ACCORDION SECTIONS --
    detailPaneEl.appendChild(createSection("🚶 Transition Times", summaryTransition(zone), () => renderTransitionSection(zone)));
    detailPaneEl.appendChild(createSection("⚽ Fields in this Zone", summaryFields(zone), () => renderFieldsSection(zone)));
    detailPaneEl.appendChild(createSection("🏢 Locations / Facilities", summaryLocations(zone), () => renderLocationsSection(zone)));
}

//------------------------------------------------------------------
// ACCORDION SECTION BUILDER
//------------------------------------------------------------------
function createSection(title, summary, builder){
    const wrap = document.createElement("div"); 
    wrap.className = "loc-detail-section";

    const head = document.createElement("div");
    head.className = "loc-detail-section-header";

    const t = document.createElement("div");
    t.innerHTML = `<div class="loc-detail-section-title">${title}</div><div class="loc-detail-section-summary">${escapeHtml(summary)}</div>`;

    const caret = document.createElement("span");
    caret.innerHTML = `<svg width="20" height="20" fill="none" stroke="#9CA3AF" stroke-width="2" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"></path></svg>`;
    caret.style.transition = "transform 0.2s";

    head.appendChild(t);
    head.appendChild(caret);

    const body = document.createElement("div");
    body.className = "loc-detail-section-body";

    head.onclick = () => {
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
// SECTION SUMMARIES
//------------------------------------------------------------------
function summaryTransition(zone){
    if(zone.transition.preMin === 0 && zone.transition.postMin === 0){
        return "No transition time";
    }
    return `${zone.transition.preMin}m pre / ${zone.transition.postMin}m post`;
}

function summaryFields(zone){
    const count = zone.fields?.length || 0;
    if(count === 0) return "No fields assigned";
    return `${count} field${count !== 1 ? 's' : ''} assigned`;
}

function summaryLocations(zone){
    const count = Object.keys(zone.locations || {}).length;
    if(count === 0) return "No locations created";
    return `${count} location${count !== 1 ? 's' : ''}`;
}

//------------------------------------------------------------------
// TRANSITION TIMES SECTION
//------------------------------------------------------------------
function renderTransitionSection(zone){
    const container = document.createElement("div");
    
    const updateSummary = () => {
        const summaryEl = container.closest('.loc-detail-section')?.querySelector('.loc-detail-section-summary');
        if(summaryEl) summaryEl.textContent = summaryTransition(zone);
    };
    
    container.innerHTML = `
        <p class="loc-muted" style="margin-top:0; margin-bottom:16px;">
            Transition time adds buffer before/after activities in this zone for travel or setup.
        </p>
        <div style="display:flex; gap:20px; flex-wrap:wrap; margin-bottom:16px;">
            <div>
                <label style="display:block; font-size:0.85rem; font-weight:600; margin-bottom:4px;">Pre-Buffer (minutes)</label>
                <input type="number" id="zone-pre-min" class="loc-input loc-input-small" min="0" step="5" value="${zone.transition.preMin}">
            </div>
            <div>
                <label style="display:block; font-size:0.85rem; font-weight:600; margin-bottom:4px;">Post-Buffer (minutes)</label>
                <input type="number" id="zone-post-min" class="loc-input loc-input-small" min="0" step="5" value="${zone.transition.postMin}">
            </div>
            <div>
                <label style="display:block; font-size:0.85rem; font-weight:600; margin-bottom:4px;">Max Concurrent Activities</label>
                <input type="number" id="zone-max-concurrent" class="loc-input loc-input-small" min="1" value="${zone.maxConcurrent}">
            </div>
        </div>
        <p class="loc-muted" style="font-size:0.8rem;">
            <strong>Max Concurrent</strong> limits how many activities can happen in this zone at once 
            (e.g., bus capacity for off-site locations). Set to 99 for no limit.
        </p>
    `;
    
    container.querySelector('#zone-pre-min').onchange = (e) => {
        zone.transition.preMin = parseInt(e.target.value) || 0;
        saveData();
        renderZonesList();
        updateSummary();
    };
    
    container.querySelector('#zone-post-min').onchange = (e) => {
        zone.transition.postMin = parseInt(e.target.value) || 0;
        saveData();
        renderZonesList();
        updateSummary();
    };
    
    container.querySelector('#zone-max-concurrent').onchange = (e) => {
        zone.maxConcurrent = parseInt(e.target.value) || 99;
        saveData();
    };
    
    return container;
}

//------------------------------------------------------------------
// FIELDS SECTION (Multi-select dropdown)
//------------------------------------------------------------------
function renderFieldsSection(zone){
    const container = document.createElement("div");
    
    const updateSummary = () => {
        const summaryEl = container.closest('.loc-detail-section')?.querySelector('.loc-detail-section-summary');
        if(summaryEl) summaryEl.textContent = summaryFields(zone);
    };
    
    // Get all fields from fields.js
    const allFields = window.getFields?.() || [];
    const fieldNames = allFields.map(f => f.name);
    
    // Get fields already assigned to OTHER zones
    const assignedElsewhere = new Set();
    Object.entries(locationZones).forEach(([zoneName, z]) => {
        if(zoneName !== zone.name){
            (z.fields || []).forEach(f => assignedElsewhere.add(f));
        }
    });
    
    container.innerHTML = `
        <p class="loc-muted" style="margin-top:0; margin-bottom:16px;">
            Select which fields belong to this zone. Fields inherit the zone's transition times.
        </p>
        <div id="fields-multiselect" class="multi-select-dropdown"></div>
    `;
    
    const multiSelectContainer = container.querySelector('#fields-multiselect');
    
    // Build the multi-select
    const trigger = document.createElement("div");
    trigger.className = "multi-select-trigger";
    
    const renderTriggerContent = () => {
        trigger.innerHTML = "";
        
        if(zone.fields.length === 0){
            const placeholder = document.createElement("span");
            placeholder.className = "multi-select-placeholder";
            placeholder.textContent = "Click to select fields...";
            trigger.appendChild(placeholder);
        } else {
            zone.fields.forEach(fieldName => {
                const tag = document.createElement("span");
                tag.className = "multi-select-tag";
                tag.innerHTML = `${escapeHtml(fieldName)} <span class="multi-select-tag-remove" data-field="${escapeHtml(fieldName)}">×</span>`;
                trigger.appendChild(tag);
            });
        }
        
        // Add chevron
        const chevron = document.createElement("span");
        chevron.innerHTML = `<svg width="16" height="16" fill="none" stroke="#9CA3AF" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"></path></svg>`;
        chevron.style.marginLeft = "auto";
        trigger.appendChild(chevron);
    };
    
    renderTriggerContent();
    
    const optionsPanel = document.createElement("div");
    optionsPanel.className = "multi-select-options";
    
    const renderOptions = () => {
        optionsPanel.innerHTML = "";
        
        if(fieldNames.length === 0){
            optionsPanel.innerHTML = `<div style="padding:12px; color:#9CA3AF; text-align:center;">No fields created yet. Go to Fields tab to create some.</div>`;
            return;
        }
        
        fieldNames.forEach(fieldName => {
            const isSelected = zone.fields.includes(fieldName);
            const isAssignedElsewhere = assignedElsewhere.has(fieldName);
            
            const option = document.createElement("div");
            option.className = "multi-select-option" + (isSelected ? " selected" : "");
            
            if(isAssignedElsewhere){
                option.style.opacity = "0.5";
                option.style.cursor = "not-allowed";
            }
            
            option.innerHTML = `
                <input type="checkbox" class="multi-select-checkbox" ${isSelected ? 'checked' : ''} ${isAssignedElsewhere ? 'disabled' : ''}>
                <span>${escapeHtml(fieldName)}</span>
                ${isAssignedElsewhere ? '<span style="font-size:0.75rem; color:#DC2626; margin-left:auto;">(in another zone)</span>' : ''}
            `;
            
            if(!isAssignedElsewhere){
                option.onclick = (e) => {
                    e.stopPropagation();
                    if(isSelected){
                        zone.fields = zone.fields.filter(f => f !== fieldName);
                    } else {
                        zone.fields.push(fieldName);
                    }
                    saveData();
                    renderTriggerContent();
                    renderOptions();
                    updateSummary();
                    renderZonesList();
                };
            }
            
            optionsPanel.appendChild(option);
        });
    };
    
    renderOptions();
    
    // Toggle dropdown
    trigger.onclick = (e) => {
        if(e.target.classList.contains('multi-select-tag-remove')){
            const fieldToRemove = e.target.dataset.field;
            zone.fields = zone.fields.filter(f => f !== fieldToRemove);
            saveData();
            renderTriggerContent();
            renderOptions();
            updateSummary();
            renderZonesList();
            return;
        }
        
        const isOpen = optionsPanel.classList.contains('show');
        optionsPanel.classList.toggle('show');
        trigger.classList.toggle('open');
    };
    
    // Close on click outside
    document.addEventListener('click', (e) => {
        if(!multiSelectContainer.contains(e.target)){
            optionsPanel.classList.remove('show');
            trigger.classList.remove('open');
        }
    });
    
    multiSelectContainer.appendChild(trigger);
    multiSelectContainer.appendChild(optionsPanel);
    
    return container;
}

//------------------------------------------------------------------
// LOCATIONS / FACILITIES SECTION
//------------------------------------------------------------------
function renderLocationsSection(zone){
    const container = document.createElement("div");
    
    const updateSummary = () => {
        const summaryEl = container.closest('.loc-detail-section')?.querySelector('.loc-detail-section-summary');
        if(summaryEl) summaryEl.textContent = summaryLocations(zone);
    };
    
    const renderContent = () => {
        container.innerHTML = `
            <p class="loc-muted" style="margin-top:0; margin-bottom:16px;">
                Locations are physical spaces (Pool, Lunchroom, Gym) that activities use. 
                <strong>Only one activity can occupy a location at a time</strong> — but unlimited bunks 
                can participate in that activity.
            </p>
            <div id="locations-list"></div>
            <div style="display:flex; gap:8px; margin-top:12px; padding-top:12px; border-top:1px dashed #E5E7EB;">
                <input type="text" id="new-location-input" class="loc-input" placeholder="New location name (e.g., Lunchroom)" style="flex:1;">
                <button id="add-location-btn" style="background:#3B82F6; color:white; border:none; border-radius:6px; padding:8px 16px; cursor:pointer; font-weight:500;">Add Location</button>
            </div>
        `;
        
        const listEl = container.querySelector('#locations-list');
        const locationNames = Object.keys(zone.locations || {}).sort();
        
        if(locationNames.length === 0){
            listEl.innerHTML = `<div class="loc-muted" style="text-align:center; padding:20px; background:#F9FAFB; border-radius:8px;">No locations created yet</div>`;
        } else {
            locationNames.forEach(locName => {
                const item = document.createElement("div");
                item.className = "location-item";
                item.innerHTML = `
                    <div class="location-item-name">
                        <span style="margin-right:8px;">📍</span>${escapeHtml(locName)}
                    </div>
                    <div class="location-item-actions">
                        <span class="loc-muted" style="font-size:0.8rem;">1 activity at a time</span>
                        <button class="location-delete-btn" data-loc="${escapeHtml(locName)}">Delete</button>
                    </div>
                `;
                
                item.querySelector('.location-delete-btn').onclick = () => {
                    if(confirm(`Delete location "${locName}"?`)){
                        delete zone.locations[locName];
                        saveData();
                        renderContent();
                        updateSummary();
                    }
                };
                
                listEl.appendChild(item);
            });
        }
        
        // Add location handler
        const addBtn = container.querySelector('#add-location-btn');
        const addInput = container.querySelector('#new-location-input');
        
        const doAdd = () => {
            const name = addInput.value.trim();
            if(!name){
                alert("Please enter a location name.");
                return;
            }
            if(zone.locations[name]){
                alert("A location with that name already exists in this zone.");
                return;
            }
            zone.locations[name] = { capacity: 1 };  // Always 1 activity at a time
            saveData();
            addInput.value = "";
            renderContent();
            updateSummary();
        };
        
        addBtn.onclick = doAdd;
        addInput.onkeyup = (e) => { if(e.key === "Enter") doAdd(); };
    };
    
    renderContent();
    return container;
}

//------------------------------------------------------------------
// ADD ZONE
//------------------------------------------------------------------
function addZone(){
    const name = addZoneInput.value.trim();
    if(!name){
        alert("Please enter a zone name.");
        return;
    }
    if(locationZones[name]){
        alert("A zone with that name already exists.");
        return;
    }
    
    locationZones[name] = {
        name: name,
        isDefault: false,
        transition: { preMin: 0, postMin: 0 },
        maxConcurrent: 99,
        fields: [],
        locations: {}
    };
    
    addZoneInput.value = "";
    saveData();
    selectedZoneId = name;
    renderZonesList();
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

function makeEditable(el, save){
    el.ondblclick = () => {
        const inp = document.createElement("input"); 
        inp.value = el.textContent.replace(/Default$/, '').trim();
        inp.style.cssText = "font-size:inherit; font-weight:inherit; border:1px solid #3B82F6; outline:none; border-radius:4px; padding:2px 6px; width:" + Math.max(100, el.offsetWidth + 20) + "px;";

        el.replaceWith(inp); 
        inp.focus();
        inp.select();

        const finish = () => { 
            const newVal = inp.value.trim();
            if(newVal && newVal !== el.textContent.replace(/Default$/, '').trim()) {
                save(newVal); 
            } else {
                if(inp.parentNode) inp.replaceWith(el); 
            }
        };

        inp.onblur = finish;
        inp.onkeyup = e => { 
            if(e.key === "Enter") finish(); 
            if(e.key === "Escape") { inp.replaceWith(el); }
        };
    };
}

//------------------------------------------------------------------
// PUBLIC API
//------------------------------------------------------------------
window.initLocationsTab = initLocationsTab;

// Get all locations across all zones (for dropdowns in other modules)
window.getAllLocations = function(){
    const settings = window.loadGlobalSettings?.() || {};
    const zones = settings.locationZones || {};
    const locations = [];
    
    Object.entries(zones).forEach(([zoneName, zone]) => {
        Object.keys(zone.locations || {}).forEach(locName => {
            locations.push({
                name: locName,
                zone: zoneName,
                displayName: `${locName} (${zoneName})`
            });
        });
    });
    
    return locations;
};

// Get zone for a specific field
window.getZoneForField = function(fieldName){
    const settings = window.loadGlobalSettings?.() || {};
    const zones = settings.locationZones || {};
    
    for(const [zoneName, zone] of Object.entries(zones)){
        if((zone.fields || []).includes(fieldName)){
            return zone;
        }
    }
    
    // Return default zone if not found
    return Object.values(zones).find(z => z.isDefault) || null;
};

// Get zone by name
window.getZone = function(zoneName){
    const settings = window.loadGlobalSettings?.() || {};
    return settings.locationZones?.[zoneName] || null;
};

// Get all zones
window.getZones = function(){
    const settings = window.loadGlobalSettings?.() || {};
    return settings.locationZones || {};
};

// Check if a location is available at a given time
window.isLocationAvailable = function(locationName, slots, currentActivity){
    // This will be used by the scheduler to check conflicts
    // Returns true if no OTHER activity is using the location
    const usage = window.locationUsageBySlot || {};
    
    for(const slotIdx of slots){
        const slotUsage = usage[slotIdx];
        if(slotUsage && slotUsage[locationName]){
            // Location is in use - check if it's the same activity
            if(slotUsage[locationName].activity !== currentActivity){
                return false; // Different activity is using it
            }
        }
    }
    
    return true;
};

// Register location usage (called by scheduler)
window.registerLocationUsage = function(slotIndex, locationName, activity, division){
    window.locationUsageBySlot = window.locationUsageBySlot || {};
    
    if(!window.locationUsageBySlot[slotIndex]){
        window.locationUsageBySlot[slotIndex] = {};
    }
    
    window.locationUsageBySlot[slotIndex][locationName] = {
        activity: activity,
        division: division,
        timestamp: Date.now()
    };
};

// Reset location usage (called at start of schedule generation)
window.resetLocationUsage = function(){
    window.locationUsageBySlot = {};
};

console.log("[LOCATIONS] Location Zones module loaded");

})();
