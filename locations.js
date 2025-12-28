// ============================================================================
// locations.js — LOCATION ZONES & FACILITIES MANAGEMENT
// ============================================================================
// This module manages:
// 1. ZONES - Physical areas with transition times (Main Campus, #2 School, etc.)
// 2. FIELDS IN ZONE - Which sports fields belong to each zone
// 3. LOCATIONS/FACILITIES - Non-field spaces (Pool, Lunchroom, Gym, Auditorium)
// 4. PINNED TILE DEFAULTS - Default locations for Lunch, Swim, Snacks, etc.
//
// KEY CONCEPT: Location capacity = 1 ACTIVITY at a time (unlimited bunks)
// If Lunch is happening in Lunchroom, 20 bunks can be there.
// But Skits CANNOT happen there at the same time because it's a different activity.
// ============================================================================
(function(){
'use strict';

let locationZones = {};
let pinnedTileDefaults = {};  // { "Lunch": "Lunchroom", "Swim": "Pool", etc. }
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
        .locations-master-list { border: 1px solid #e5e7eb; border-radius: 12px; background: #fff; overflow: hidden; }
        .locations-list-item { padding: 12px 14px; border-bottom: 1px solid #f3f4f6; cursor: pointer; display: flex; justify-content: space-between; align-items: center; transition: background 0.15s, border-color 0.15s, box-shadow 0.18s, transform 0.08s; }
        .locations-list-item:last-child { border-bottom: none; }
        .locations-list-item:hover { background: #f9fafb; transform: translateY(-0.5px); }
        .locations-list-item.selected { background: #eff6ff; border-left: 3px solid #2563eb; }
        .locations-list-item-name { font-weight: 500; color: #111827; font-size: 0.9rem; }
        .locations-list-item-meta { font-size: 0.75rem; color: #6b7280; margin-left: 6px; }
        .locations-list-item-badge { font-size: 0.65rem; padding: 2px 8px; border-radius: 999px; background: linear-gradient(135deg, #2563eb, #0ea5e9); color: #fff; margin-left: 8px; font-weight: 500; }

        /* Detail Section Accordion */
        .loc-detail-section { margin-bottom: 12px; border: 1px solid #e5e7eb; border-radius: 12px; background: #fff; }
        .loc-detail-section-header { padding: 12px 16px; background: #f9fafb; cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none; border-radius: 11px; transition: background 0.15s; }
        .loc-detail-section-header:hover { background: #f3f4f6; }
        .loc-detail-section-title { font-size: 0.9rem; font-weight: 600; color: #111827; }
        .loc-detail-section-summary { font-size: 0.8rem; color: #6b7280; margin-top: 2px; }
        .loc-detail-section-body { display: none; padding: 16px; border-top: 1px solid #e5e7eb; }

        /* Multi-select dropdown trigger */
        .multi-select-dropdown { position: relative; }
        .multi-select-trigger { 
            width: 100%; 
            padding: 10px 14px; 
            border: 1px solid #d1d5db; 
            border-radius: 10px; 
            background: #fff; 
            cursor: pointer; 
            display: flex; 
            justify-content: space-between; 
            align-items: center; 
            min-height: 44px; 
            flex-wrap: wrap; 
            gap: 6px;
            transition: border-color 0.15s, box-shadow 0.15s;
        }
        .multi-select-trigger:hover { border-color: #9ca3af; }
        .multi-select-trigger.open { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.15); }
        .multi-select-placeholder { color: #9ca3af; font-size: 0.9rem; }
        .multi-select-tag { 
            background: #dbeafe; 
            color: #1e40af; 
            padding: 4px 10px; 
            border-radius: 6px; 
            font-size: 0.8rem; 
            font-weight: 500; 
            display: inline-flex; 
            align-items: center; 
            gap: 6px;
            border: 1px solid #bfdbfe;
        }
        .multi-select-tag-remove { 
            cursor: pointer; 
            opacity: 0.6; 
            font-size: 1rem; 
            line-height: 1;
            transition: opacity 0.15s;
        }
        .multi-select-tag-remove:hover { opacity: 1; }
        
        /* Multi-select dropdown panel - FIXED positioning */
        .multi-select-options { 
            position: fixed; 
            z-index: 999999;
            background: #fff; 
            border: 1px solid #e5e7eb; 
            border-radius: 12px; 
            overflow-y: auto;
            overflow-x: hidden;
            overscroll-behavior: contain;
            box-shadow: 0 20px 50px rgba(15,23,42,0.2), 0 0 0 1px rgba(0,0,0,0.05);
            display: none;
        }
        .multi-select-options.show { display: block; }
        .multi-select-option { 
            padding: 12px 14px; 
            cursor: pointer; 
            display: flex; 
            align-items: center; 
            gap: 10px;
            transition: background 0.1s;
            border-bottom: 1px solid #f3f4f6;
        }
        .multi-select-option:last-child { border-bottom: none; }
        .multi-select-option:hover { background: #f9fafb; }
        .multi-select-option.selected { background: #eff6ff; }
        .multi-select-option.disabled { opacity: 0.5; cursor: not-allowed; }
        .multi-select-option.disabled:hover { background: transparent; }
        .multi-select-checkbox { 
            width: 18px; 
            height: 18px; 
            accent-color: #2563eb; 
            flex-shrink: 0;
        }
        .multi-select-option-label { 
            flex: 1; 
            font-size: 0.9rem; 
            color: #111827;
        }
        .multi-select-option-badge {
            font-size: 0.7rem;
            color: #dc2626;
            background: #fef2f2;
            padding: 2px 8px;
            border-radius: 999px;
            border: 1px solid #fecaca;
        }

        /* Location item in list */
        .location-item { 
            display: flex; 
            justify-content: space-between; 
            align-items: center;
            padding: 12px 14px; 
            background: #f9fafb; 
            border: 1px solid #e5e7eb; 
            border-radius: 10px; 
            margin-bottom: 8px; 
            transition: all 0.15s;
        }
        .location-item:hover { background: #eff6ff; border-color: #bfdbfe; }
        .location-item-name { font-weight: 500; color: #111827; font-size: 0.9rem; }
        .location-item-actions { display: flex; gap: 8px; align-items: center; }
        .location-delete-btn { 
            background: transparent; 
            border: none; 
            color: #dc2626; 
            cursor: pointer;
            padding: 6px 10px; 
            border-radius: 6px; 
            font-size: 0.85rem; 
            transition: background 0.15s;
        }
        .location-delete-btn:hover { background: #fee2e2; }

        /* Form inputs */
        .loc-input {
            padding: 10px 14px; 
            border: 1px solid #d1d5db; 
            border-radius: 10px;
            font-size: 0.9rem; 
            transition: all 0.15s ease; 
            width: 100%; 
            box-sizing: border-box;
            background: #fff;
        }
        .loc-input:focus {
            outline: none; 
            border-color: #2563eb;
            box-shadow: 0 0 0 3px rgba(37,99,235,0.15);
        }
        .loc-input-small { width: 80px; text-align: center; }

        .loc-muted { color: #6b7280; font-size: 0.85rem; }
        
        /* Empty state */
        .loc-empty-state {
            text-align: center;
            padding: 24px 16px;
            background: #f9fafb;
            border: 1px dashed #d1d5db;
            border-radius: 10px;
            color: #6b7280;
            font-size: 0.9rem;
        }
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

            <!-- PINNED TILE DEFAULTS SECTION -->
            <div id="pinned-tile-defaults-section" style="margin-bottom:24px;">
              <div class="loc-detail-section">
                <div class="loc-detail-section-header" onclick="this.parentElement.classList.toggle('expanded'); this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'block' ? 'none' : 'block';">
                    <div>
                        <div class="loc-detail-section-title">📍 Pinned Tile Default Locations</div>
                        <div class="loc-detail-section-summary" id="pinned-defaults-summary">Set default locations for Lunch, Swim, Snacks, etc.</div>
                    </div>
                    <svg width="20" height="20" fill="none" stroke="#6B7280" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"></path></svg>
                </div>
                <div class="loc-detail-section-body" style="display:none;">
                    <p class="loc-muted" style="margin-top:0; margin-bottom:12px;">
                        Set default locations for pinned tiles. When Lunch, Swim, etc. are scheduled, 
                        the location is automatically assigned.
                    </p>
                    <div id="pinned-defaults-list"></div>
                    <div style="display:flex; gap:8px; margin-top:16px; padding-top:16px; border-top:1px solid #e5e7eb; align-items:center;">
                        <input id="new-pinned-tile-input" placeholder="Tile name (e.g., Lunch)" class="loc-input" style="flex:1;">
                        <select id="new-pinned-tile-location" class="loc-input" style="flex:1;"></select>
                        <button id="add-pinned-default-btn" style="background:#111827; color:white; border:none; border-radius:8px; padding:10px 16px; font-size:0.85rem; cursor:pointer; white-space:nowrap; font-weight:500;">Add</button>
                    </div>
                </div>
              </div>
            </div>

            <div style="display:flex; flex-wrap:wrap; gap:24px;">
              <!-- LEFT SIDE: ZONES LIST -->
              <div style="flex:1; min-width:280px;">
                <div style="display:flex; justify-content:space-between; align-items:end; margin-bottom:8px;">
                    <div class="setup-subtitle">Zones</div>
                </div>
                
                <div style="background:white; padding:8px 8px 8px 16px; border-radius:12px; border:1px solid #e5e7eb; margin-bottom:12px; display:flex; gap:8px; align-items:center;">
                  <input id="new-zone-input" placeholder="New Zone (e.g., Lake Area)" class="loc-input" style="flex:1; border:none; padding:8px 0;">
                  <button id="add-zone-btn" style="background:#111827; color:white; border:none; border-radius:8px; padding:8px 16px; font-size:0.85rem; cursor:pointer; font-weight:500;">Add</button>
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

    // Initialize pinned tile defaults section
    initPinnedTileDefaultsSection();

    renderZonesList();
    renderDetailPane();
}

//------------------------------------------------------------------
// DATA LOADING / SAVING
//------------------------------------------------------------------
function loadData(){
    const settings = window.loadGlobalSettings?.() || {};
    locationZones = settings.locationZones || {};
    pinnedTileDefaults = settings.pinnedTileDefaults || {};

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
    // ⭐ Save both at once - more efficient and ensures updated_at is set once
    const settings = window.loadGlobalSettings?.() || {};
    
    // Update the settings object
    settings.locationZones = locationZones;
    settings.pinnedTileDefaults = pinnedTileDefaults;
    
    // Save both keys (each call now updates updated_at properly with Fix 4)
    window.saveGlobalSettings?.("locationZones", locationZones);
    window.saveGlobalSettings?.("pinnedTileDefaults", pinnedTileDefaults);
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
        delBtn.style.cssText = "color:#dc2626; background:#fef2f2; border:1px solid #fecaca; padding:6px 12px; border-radius:999px; cursor:pointer; display:flex; gap:6px; align-items:center; font-size:0.85rem;";
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
        defaultStrip.style.cssText = "padding:10px 14px; background:linear-gradient(135deg, rgba(37,99,235,0.1), rgba(14,165,233,0.1)); border:1px solid rgba(59,130,246,0.3); border-radius:999px; margin-bottom:16px; color:#1d4ed8; font-size:0.85rem;";
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
            const emptyMsg = document.createElement("div");
            emptyMsg.style.cssText = "padding: 16px; color: #6b7280; text-align: center; font-size: 0.9rem;";
            emptyMsg.textContent = "No fields created yet. Go to Fields tab to create some.";
            optionsPanel.appendChild(emptyMsg);
            return;
        }
        
        // Add header
        const header = document.createElement("div");
        header.style.cssText = "padding: 10px 14px; background: #f9fafb; border-bottom: 1px solid #e5e7eb; font-size: 0.75rem; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.03em; position: sticky; top: 0; z-index: 1;";
        header.textContent = `${fieldNames.length} field${fieldNames.length !== 1 ? 's' : ''} available`;
        optionsPanel.appendChild(header);
        
        fieldNames.forEach(fieldName => {
            const isSelected = zone.fields.includes(fieldName);
            const isAssignedElsewhere = assignedElsewhere.has(fieldName);
            
            const option = document.createElement("div");
            option.className = "multi-select-option" + (isSelected ? " selected" : "") + (isAssignedElsewhere ? " disabled" : "");
            
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.className = "multi-select-checkbox";
            checkbox.checked = isSelected;
            checkbox.disabled = isAssignedElsewhere;
            
            const label = document.createElement("span");
            label.className = "multi-select-option-label";
            label.textContent = fieldName;
            
            option.appendChild(checkbox);
            option.appendChild(label);
            
            if(isAssignedElsewhere){
                const badge = document.createElement("span");
                badge.className = "multi-select-option-badge";
                badge.textContent = "In another zone";
                option.appendChild(badge);
            }
            
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
    
    // Position dropdown using fixed positioning to escape any overflow containers
    const positionDropdown = () => {
        const rect = trigger.getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        const spaceBelow = viewportHeight - rect.bottom - 20; // 20px padding from bottom
        const spaceAbove = rect.top - 20; // 20px padding from top
        
        // Determine max height based on available space
        let maxHeight = Math.min(300, Math.max(spaceBelow, spaceAbove));
        
        // Position below if enough space, otherwise above
        if(spaceBelow >= 150 || spaceBelow >= spaceAbove) {
            optionsPanel.style.top = (rect.bottom + 4) + 'px';
            optionsPanel.style.bottom = 'auto';
            maxHeight = Math.min(300, spaceBelow);
        } else {
            optionsPanel.style.bottom = (viewportHeight - rect.top + 4) + 'px';
            optionsPanel.style.top = 'auto';
            maxHeight = Math.min(300, spaceAbove);
        }
        
        optionsPanel.style.left = rect.left + 'px';
        optionsPanel.style.width = rect.width + 'px';
        optionsPanel.style.maxHeight = maxHeight + 'px';
    };
    
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
        
        if(!isOpen){
            positionDropdown();
        }
        
        optionsPanel.classList.toggle('show');
        trigger.classList.toggle('open');
    };
    
    // Reposition on scroll/resize while open
    const repositionHandler = () => {
        if(optionsPanel.classList.contains('show')){
            positionDropdown();
        }
    };
    window.addEventListener('scroll', repositionHandler, true);
    window.addEventListener('resize', repositionHandler);
    
    // Close on click outside
    document.addEventListener('click', (e) => {
        if(!multiSelectContainer.contains(e.target) && !optionsPanel.contains(e.target)){
            optionsPanel.classList.remove('show');
            trigger.classList.remove('open');
        }
    });
    
    multiSelectContainer.appendChild(trigger);
    
    // Append options panel to body so it escapes all containers
    document.body.appendChild(optionsPanel);
    
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
            <div id="locations-list"></div>
            <div style="display:flex; gap:8px; margin-top:16px; padding-top:16px; border-top:1px solid #e5e7eb; align-items:center;">
                <input type="text" id="new-location-input" class="loc-input" placeholder="New location (e.g., Lunchroom)" style="flex:1;">
                <button id="add-location-btn" style="background:#111827; color:white; border:none; border-radius:8px; padding:10px 16px; cursor:pointer; font-weight:500; font-size:0.85rem; white-space:nowrap;">Add</button>
            </div>
        `;
        
        const listEl = container.querySelector('#locations-list');
        const locationNames = Object.keys(zone.locations || {}).sort();
        
        if(locationNames.length === 0){
            listEl.innerHTML = `<div class="loc-empty-state">No locations created yet</div>`;
        } else {
            locationNames.forEach(locName => {
                const item = document.createElement("div");
                item.className = "location-item";
                item.innerHTML = `
                    <div class="location-item-name">
                        <span style="margin-right:6px;">📍</span>${escapeHtml(locName)}
                    </div>
                    <div class="location-item-actions">
                        <button class="location-delete-btn" data-loc="${escapeHtml(locName)}">✕ Remove</button>
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
// PINNED TILE DEFAULTS (Hub for managing default locations)
//------------------------------------------------------------------
function initPinnedTileDefaultsSection(){
    const listEl = document.getElementById("pinned-defaults-list");
    const tileInput = document.getElementById("new-pinned-tile-input");
    const locationSelect = document.getElementById("new-pinned-tile-location");
    const addBtn = document.getElementById("add-pinned-default-btn");
    
    if(!listEl || !tileInput || !locationSelect || !addBtn) return;
    
    // Populate location dropdown
    populateLocationDropdown(locationSelect);
    
    // Add button handler
    addBtn.onclick = () => {
        const tileName = tileInput.value.trim();
        const location = locationSelect.value;
        
        if(!tileName){
            alert("Please enter a tile name (e.g., Lunch, Swim, Assembly)");
            return;
        }
        if(!location){
            alert("Please select a location");
            return;
        }
        
        pinnedTileDefaults[tileName] = location;
        saveData();
        tileInput.value = "";
        renderPinnedTileDefaults();
    };
    
    tileInput.onkeyup = (e) => { if(e.key === "Enter") addBtn.click(); };
    
    // Initial render
    renderPinnedTileDefaults();
}

function populateLocationDropdown(selectEl){
    selectEl.innerHTML = '<option value="">-- Select Location --</option>';
    
    const allLocations = window.getAllLocations?.() || [];
    
    if(allLocations.length === 0){
        selectEl.innerHTML += '<option value="" disabled>(Create locations in zones below first)</option>';
        return;
    }
    
    allLocations.forEach(loc => {
        const opt = document.createElement("option");
        opt.value = loc.name;
        opt.textContent = loc.displayName;
        selectEl.appendChild(opt);
    });
}

function renderPinnedTileDefaults(){
    const listEl = document.getElementById("pinned-defaults-list");
    const summaryEl = document.getElementById("pinned-defaults-summary");
    const locationSelect = document.getElementById("new-pinned-tile-location");
    
    if(!listEl) return;
    
    // Re-populate location dropdown (in case new locations were added)
    if(locationSelect) populateLocationDropdown(locationSelect);
    
    const defaults = Object.entries(pinnedTileDefaults);
    
    // Update summary
    if(summaryEl){
        if(defaults.length === 0){
            summaryEl.textContent = "No defaults set yet";
        } else {
            summaryEl.textContent = defaults.map(([tile, loc]) => `${tile} → ${loc}`).join(", ");
        }
    }
    
    // Render list
    if(defaults.length === 0){
        listEl.innerHTML = `
            <div style="padding:16px; text-align:center; color:#9CA3AF; border:1px dashed #E5E7EB; border-radius:8px;">
                No defaults configured yet. Add common pinned tiles like Lunch, Swim, Snacks above.
            </div>`;
        return;
    }
    
    listEl.innerHTML = "";
    
    defaults.sort((a, b) => a[0].localeCompare(b[0])).forEach(([tileName, location]) => {
        const row = document.createElement("div");
        row.className = "location-item";
        row.innerHTML = `
            <div style="display:flex; align-items:center; gap:12px;">
                <span class="location-item-name">${escapeHtml(tileName)}</span>
                <span style="color:#6B7280;">→</span>
                <span style="color:#3B82F6; font-weight:500;">${escapeHtml(location)}</span>
            </div>
            <div class="location-item-actions">
                <select class="loc-input" style="width:auto; padding:4px 8px; font-size:0.85rem;" data-tile="${escapeHtml(tileName)}">
                    ${generateLocationOptions(location)}
                </select>
                <button class="location-delete-btn" data-tile="${escapeHtml(tileName)}">✕</button>
            </div>
        `;
        
        // Change location handler
        const select = row.querySelector("select");
        select.onchange = () => {
            pinnedTileDefaults[tileName] = select.value;
            saveData();
            renderPinnedTileDefaults();
        };
        
        // Delete handler
        const delBtn = row.querySelector(".location-delete-btn");
        delBtn.onclick = () => {
            delete pinnedTileDefaults[tileName];
            saveData();
            renderPinnedTileDefaults();
        };
        
        listEl.appendChild(row);
    });
}

function generateLocationOptions(selectedLocation){
    const allLocations = window.getAllLocations?.() || [];
    let html = '<option value="">-- None --</option>';
    
    allLocations.forEach(loc => {
        const selected = loc.name === selectedLocation ? 'selected' : '';
        html += `<option value="${escapeHtml(loc.name)}" ${selected}>${escapeHtml(loc.displayName)}</option>`;
    });
    
    return html;
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

// Get default location for a pinned tile type
window.getPinnedTileDefaultLocation = function(tileType){
    const settings = window.loadGlobalSettings?.() || {};
    return settings.pinnedTileDefaults?.[tileType] || null;
};

// Get all pinned tile defaults
window.getPinnedTileDefaults = function(){
    const settings = window.loadGlobalSettings?.() || {};
    return settings.pinnedTileDefaults || {};
};

// Set a pinned tile default location (can be called from other modules)
window.setPinnedTileDefaultLocation = function(tileType, locationName){
    const settings = window.loadGlobalSettings?.() || {};
    settings.pinnedTileDefaults = settings.pinnedTileDefaults || {};
    settings.pinnedTileDefaults[tileType] = locationName;
    window.saveGlobalSettings?.("pinnedTileDefaults", settings.pinnedTileDefaults);
};

// Refresh pinned tile defaults UI (call after adding locations)
window.refreshPinnedTileDefaultsUI = renderPinnedTileDefaults;

console.log("[LOCATIONS] Location Zones module loaded");

})();
