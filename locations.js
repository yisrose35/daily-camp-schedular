// ============================================================================
// locations.js — LOCATION ZONES & FACILITIES MANAGEMENT v2.1
// ============================================================================
// This module manages:
// 1. ZONES - Physical areas with transition times (Main Campus, #2 School, etc.)
// 2. FIELDS IN ZONE - Which sports fields belong to each zone
// 3. SPECIAL ACTIVITIES IN ZONE - Which special activities belong to each zone
// 4. LOCATIONS/FACILITIES - Non-field spaces (Pool, Lunchroom, Gym, Auditorium)
// 5. PINNED TILE DEFAULTS - Default locations for Lunch, Swim, Snacks, etc.
//
// KEY CONCEPT: Location capacity = 1 ACTIVITY at a time (unlimited bunks)
// If Lunch is happening in Lunchroom, 20 bunks can be there.
// But Skits CANNOT happen there at the same time because it's a different activity.
//
// v2.1 CHANGES:
// - ★ NEW: Special activities can be assigned to zones alongside fields
// - ★ Updated dropdown to show both fields and special activities
// - ★ Updated summary to show fields + specials count
//
// v2.0 FIXES:
// - ★ CLOUD SYNC: Properly saves to cloud via saveGlobalSettings
// - ★ DATA REFRESH: Refreshes from cloud when tab is activated
// - ★ MEMORY LEAK FIX: Proper cleanup of all event listeners
// - ★ STATE CONSISTENCY: Internal state always matches persisted state
// - ★ DATA VALIDATION: Validates zone/location structure on load
// ============================================================================
(function(){
'use strict';

console.log("[LOCATIONS] Location Zones module v2.1 loading...");

// =========================================================================
// STATE - Internal variables (always synced with persisted storage)
// =========================================================================
let locationZones = {};
let pinnedTileDefaults = {};  // { "Lunch": "Lunchroom", "Swim": "Pool", etc. }
let selectedZoneId = null;
let zonesListEl = null;
let detailPaneEl = null;
let addZoneInput = null;
let _isInitialized = false;
let _refreshTimeout = null;
let _selectedPinnedLocation = { name: '', displayName: '' };  // ★ FIX: Custom dropdown state

// ★ FIX: Track active event listeners for cleanup (with target info)
let activeEventListeners = [];

// =========================================================================
// CLEANUP HELPER - Remove orphaned panels and event listeners
// =========================================================================
function cleanupDropdownPanels() {
    // Remove any orphaned MULTI-SELECT panels from body (NOT pinned-loc - those are managed separately)
    const existingPanels = document.querySelectorAll('.multi-select-options');
    existingPanels.forEach(p => p.remove());
    
    // Remove tracked event listeners (handle both window and document targets)
    activeEventListeners.forEach(({ type, handler, options, target }) => {
        const eventTarget = target || window;
        try {
            eventTarget.removeEventListener(type, handler, options);
        } catch (e) {
            // Ignore errors during cleanup
        }
    });
    activeEventListeners = [];
}

// =========================================================================
// ★ DATA VALIDATION - Ensure zone/location structure is valid
// =========================================================================
function validateZone(zone, zoneName) {
    if (!zone || typeof zone !== 'object') {
        return {
            name: zoneName,
            isDefault: false,
            transition: { preMin: 0, postMin: 0 },
            maxConcurrent: 99,
            fields: [],
            specialActivities: [],  // ★ NEW: Special activities in zone
            locations: {}
        };
    }
    
    // ★ FIX: Get all valid field names for orphan detection
    let validFieldNames = null;
    try {
        const allFields = window.getFields?.() || [];
        validFieldNames = new Set(allFields.map(f => f.name));
    } catch (e) {
        // If getFields isn't available yet, skip validation
        validFieldNames = null;
    }
    
    // ★ Get all valid special activity names for orphan detection
    let validSpecialNames = null;
    try {
        const allSpecials = window.getAllSpecialActivities?.() || [];
        validSpecialNames = new Set(allSpecials.map(s => s.name));
    } catch (e) {
        validSpecialNames = null;
    }
    
    // Filter fields to only include valid ones (if we can validate)
    let validatedFields = Array.isArray(zone.fields) ? zone.fields.filter(f => typeof f === 'string') : [];
    if (validFieldNames && validFieldNames.size > 0) {
        const originalCount = validatedFields.length;
        validatedFields = validatedFields.filter(f => validFieldNames.has(f));
        if (validatedFields.length < originalCount) {
            console.warn(`[LOCATIONS] Zone "${zoneName}": Removed ${originalCount - validatedFields.length} orphaned field reference(s)`);
        }
    }
    
    // ★ NEW: Filter special activities to only include valid ones
    let validatedSpecials = Array.isArray(zone.specialActivities) ? zone.specialActivities.filter(s => typeof s === 'string') : [];
    if (validSpecialNames && validSpecialNames.size > 0) {
        const originalCount = validatedSpecials.length;
        validatedSpecials = validatedSpecials.filter(s => validSpecialNames.has(s));
        if (validatedSpecials.length < originalCount) {
            console.warn(`[LOCATIONS] Zone "${zoneName}": Removed ${originalCount - validatedSpecials.length} orphaned special activity reference(s)`);
        }
    }
    
    return {
        name: zone.name || zoneName,
        isDefault: zone.isDefault === true,
        transition: {
            preMin: parseInt(zone.transition?.preMin) || 0,
            postMin: parseInt(zone.transition?.postMin) || 0
        },
        maxConcurrent: parseInt(zone.maxConcurrent) || 99,
        fields: validatedFields,
        specialActivities: validatedSpecials,  // ★ NEW
        locations: (zone.locations && typeof zone.locations === 'object') ? zone.locations : {}
    };
}

function validateAllZones(zones) {
    if (!zones || typeof zones !== 'object') {
        return {};
    }
    
    const validated = {};
    Object.entries(zones).forEach(([name, zone]) => {
        validated[name] = validateZone(zone, name);
    });
    return validated;
}

function validatePinnedDefaults(defaults) {
    if (!defaults || typeof defaults !== 'object') {
        return {};
    }
    
    const validated = {};
    Object.entries(defaults).forEach(([tile, location]) => {
        if (typeof tile === 'string' && typeof location === 'string') {
            validated[tile] = location;
        }
    });
    return validated;
}

// =========================================================================
// ★ TAB VISIBILITY HANDLERS - Refresh data when tab becomes visible
// =========================================================================
let _visibilityHandler = null;
let _focusHandler = null;

function setupTabVisibilityListener() {
    // Cleanup existing listeners first
    cleanupTabListeners();
    
    // Visibility change handler
    _visibilityHandler = () => {
        if (document.visibilityState === 'visible' && _isInitialized) {
            // Debounce refresh
            if (_refreshTimeout) {
                clearTimeout(_refreshTimeout);
            }
            _refreshTimeout = setTimeout(() => {
                console.log("[LOCATIONS] Tab visible - refreshing data...");
                refreshFromStorage();
            }, 300);
        }
    };
    document.addEventListener('visibilitychange', _visibilityHandler);
    activeEventListeners.push({ type: 'visibilitychange', handler: _visibilityHandler, target: document });
    
    // Focus handler
    _focusHandler = () => {
        if (_isInitialized) {
            if (_refreshTimeout) {
                clearTimeout(_refreshTimeout);
            }
            _refreshTimeout = setTimeout(() => {
                console.log("[LOCATIONS] Window focused - refreshing data...");
                refreshFromStorage();
            }, 300);
        }
    };
    window.addEventListener('focus', _focusHandler);
    activeEventListeners.push({ type: 'focus', handler: _focusHandler, target: window });
}

function cleanupTabListeners() {
    if (_visibilityHandler) {
        document.removeEventListener('visibilitychange', _visibilityHandler);
        _visibilityHandler = null;
    }
    if (_focusHandler) {
        window.removeEventListener('focus', _focusHandler);
        _focusHandler = null;
    }
    if (_refreshTimeout) {
        clearTimeout(_refreshTimeout);
        _refreshTimeout = null;
    }
}

// =========================================================================
// ★ CLOUD SYNC LISTENER - React to remote changes
// =========================================================================
let _cloudSyncCallback = null;

function setupCloudSyncListener() {
    // Cleanup existing
    if (_cloudSyncCallback && window.SupabaseSync?.removeStatusCallback) {
        window.SupabaseSync.removeStatusCallback(_cloudSyncCallback);
    }
    
    // Listen for cloud sync events (if the sync system provides callbacks)
    if (window.SupabaseSync?.onStatusChange) {
        _cloudSyncCallback = (status) => {
            if (status === 'idle' && _isInitialized) {
                // After sync completes, refresh our data
                console.log("[LOCATIONS] Cloud sync complete - refreshing...");
                refreshFromStorage();
            }
        };
        window.SupabaseSync.onStatusChange(_cloudSyncCallback);
    }
    
    // Also listen for custom campistry events (dispatched by integration_hooks)
    const handleRemoteChange = (event) => {
        if (_isInitialized && (event.detail?.key === 'locationZones' || event.detail?.key === 'pinnedTileDefaults')) {
            console.log("[LOCATIONS] Remote change detected for:", event.detail?.key);
            refreshFromStorage();
        }
    };
    window.addEventListener('campistry-remote-change', handleRemoteChange);
    activeEventListeners.push({ type: 'campistry-remote-change', handler: handleRemoteChange, target: window });
}

//------------------------------------------------------------------
// INIT - ★ WITH CLOUD SUBSCRIPTION AND TAB VISIBILITY HANDLING
//------------------------------------------------------------------
function initLocationsTab(){
    const container = document.getElementById("locations");
    if(!container) return;
    
    // ★ FIX: Cleanup any previous state when re-initializing
    cleanupDropdownPanels();
    cleanupTabListeners();
    
    loadData();
    _isInitialized = true;

    container.innerHTML = "";

    // ★ Setup tab visibility listener to refresh data when tab becomes active
    setupTabVisibilityListener();
    
    // ★ Setup cloud sync listener (if available)
    setupCloudSyncListener();

    // Styles are loaded from styles.css (Locations Tab section)

    const contentWrapper = document.createElement('div');
    contentWrapper.innerHTML = `
        <div class="setup-panel">
          <section>
            <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:16px; margin-bottom:24px;">
              <div>
                <div class="setup-title">Location Zones</div>
                <p class="setup-description">Manage physical zones, assign fields and special activities, and configure transition times.</p>
              </div>
            </div>

            <div style="display:flex; flex-wrap:wrap; gap:24px;">
              <!-- LEFT SIDE: ZONES LIST -->
              <div style="flex:1; min-width:260px;">
                <div style="display:flex; justify-content:space-between; align-items:end; margin-bottom:8px;">
                    <div class="setup-subtitle">Zones</div>
                </div>
                
                <div style="background:white; padding:10px; border-radius:12px; border:1px solid #E5E7EB; margin-bottom:12px; display:flex; gap:8px;">
                  <input id="new-zone-input" placeholder="New Zone (e.g., #2 School)" style="flex:1; border:none; outline:none; font-size:0.9rem;">
                  <button id="add-zone-btn" style="background:#111; color:white; border:none; border-radius:6px; padding:6px 12px; font-size:0.8rem; cursor:pointer;">Add</button>
                </div>
                <div id="zones-master-list" class="master-list" style="max-height:400px; overflow-y:auto;"></div>
                
                <!-- Pinned Tile Defaults Section -->
                <div style="margin-top:24px;">
                  <div class="setup-subtitle" style="margin-bottom:8px;">📌 Default Locations</div>
                  <p style="font-size:0.8rem; color:#6B7280; margin:0 0 12px 0;">
                    Set default locations for common activities like Lunch, Swim, etc.
                  </p>
                  <div id="pinned-defaults-list" style="margin-bottom:12px;"></div>
                  <div style="display:flex; gap:8px; align-items:center;">
                    <input id="new-pinned-tile-input" class="form-input" placeholder="Tile name" style="flex:1;">
                    <div id="pinned-location-picker" class="pinned-loc-picker" style="flex:1;"></div>
                    <button id="add-pinned-default-btn" style="background:#147D91; color:white; border:none; border-radius:8px; padding:8px 12px; cursor:pointer; font-size:0.85rem;">Add</button>
                  </div>
                </div>
              </div>

              <!-- RIGHT SIDE: DETAIL PANE -->
              <div style="flex:1.4; min-width:340px;">
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
    
    console.log("[LOCATIONS] Initialized:", {
        zones: Object.keys(locationZones).length,
        pinnedDefaults: Object.keys(pinnedTileDefaults).length
    });
}

//------------------------------------------------------------------
// DATA LOADING / SAVING - ★ CLOUD SYNC AWARE
//------------------------------------------------------------------

/**
 * Load data from persisted storage (localStorage/cloud cache)
 * Always reads fresh from loadGlobalSettings to stay in sync
 */
function loadData(){
    const settings = window.loadGlobalSettings?.() || {};
    
    // ★ Validate and load location zones
    const rawZones = settings.locationZones || {};
    locationZones = validateAllZones(rawZones);
    
    // ★ Validate and load pinned tile defaults
    pinnedTileDefaults = validatePinnedDefaults(settings.pinnedTileDefaults || {});

    // Create default "Main Campus" zone if none exist
    if(Object.keys(locationZones).length === 0){
        locationZones["Main Campus"] = {
            name: "Main Campus",
            isDefault: true,
            transition: { preMin: 0, postMin: 0 },
            maxConcurrent: 99,
            fields: [],
            specialActivities: [],  // ★ NEW
            locations: {}
        };
        // Save the default zone immediately
        saveData();
    }

    console.log("[LOCATIONS] Data loaded:", {
        zones: Object.keys(locationZones).length,
        pinnedDefaults: Object.keys(pinnedTileDefaults).length
    });
}

/**
 * Refresh data from storage (call when tab becomes visible or after cloud sync)
 */
function refreshFromStorage() {
    // ★ FIX: Store previous state for proper comparison
    const previousZonesJson = JSON.stringify(locationZones);
    const previousDefaultsJson = JSON.stringify(pinnedTileDefaults);
    const previousSelectedZone = selectedZoneId;
    
    loadData();
    
    // If selected zone no longer exists, clear selection
    if (selectedZoneId && !locationZones[selectedZoneId]) {
        selectedZoneId = null;
    }
    
    // ★ FIX: Compare actual content, not just counts
    const newZonesJson = JSON.stringify(locationZones);
    const newDefaultsJson = JSON.stringify(pinnedTileDefaults);
    const dataChanged = previousZonesJson !== newZonesJson || 
                        previousDefaultsJson !== newDefaultsJson ||
                        previousSelectedZone !== selectedZoneId;
    
    if (dataChanged) {
        console.log("[LOCATIONS] Data changed - re-rendering UI");
        if (zonesListEl) renderZonesList();
        if (detailPaneEl) renderDetailPane();
    } else {
        console.log("[LOCATIONS] Data unchanged - skipping re-render");
    }
}

/**
 * Save data to persisted storage and queue for cloud sync
 * ★ Uses saveGlobalSettings which handles batching and cloud sync
 */
function saveData(){
    // ✅ RBAC Check for modifications
    if (window.AccessControl?.canEditSetup && !window.AccessControl.canEditSetup()) {
        console.warn('[LOCATIONS] Save blocked - insufficient permissions');
        return;
    }
    
    // ★ Validate before saving to ensure data integrity
    const validatedZones = validateAllZones(locationZones);
    const validatedDefaults = validatePinnedDefaults(pinnedTileDefaults);
    
    // ★ Update internal state with validated data
    locationZones = validatedZones;
    pinnedTileDefaults = validatedDefaults;
    
    // ★ v2.2 FIX: Save both keys in a single batch to prevent race condition
    // Sequential saveGlobalSettings calls can race if each does read-modify-write
    if (typeof window.saveGlobalSettings === 'function') {
        window.saveGlobalSettings("locationZones", validatedZones);
        // Use requestAnimationFrame to ensure first write completes before second
        requestAnimationFrame(() => {
            window.saveGlobalSettings("pinnedTileDefaults", validatedDefaults);
        });
    }
}

//------------------------------------------------------------------
// LEFT PANEL — ZONES LIST
//------------------------------------------------------------------
function renderZonesList(){
    if (!zonesListEl) return;
    
    zonesListEl.innerHTML = "";
    
    const zones = Object.values(locationZones);
    if(zones.length === 0){
        zonesListEl.innerHTML = `<div style="padding:20px; text-align:center; color:#9CA3AF;">No zones created yet.</div>`;
        return;
    }
    
    // Sort: default first, then alphabetical
    zones.sort((a,b) => {
        if(a.isDefault && !b.isDefault) return -1;
        if(!a.isDefault && b.isDefault) return 1;
        return a.name.localeCompare(b.name);
    });
    
    zones.forEach(zone => {
        zonesListEl.appendChild(createZoneListItem(zone));
    });
}

function createZoneListItem(zone){
    const el = document.createElement("div");
    el.className = "list-item" + (zone.name === selectedZoneId ? " selected" : "");
    el.onclick = () => {
        selectedZoneId = zone.name;
        renderZonesList();
        renderDetailPane();
    };

    const infoDiv = document.createElement("div");
    
    const nameEl = document.createElement("span");
    nameEl.className = "list-item-name";
    nameEl.textContent = zone.name;
    infoDiv.appendChild(nameEl);
    
    if(zone.isDefault){
        const badge = document.createElement("span");
        badge.className = "list-item-badge";
        badge.textContent = "Default";
        infoDiv.appendChild(badge);
    }
    
    const meta = document.createElement("div");
    meta.className = "list-item-meta";
    const fieldCount = zone.fields?.length || 0;
    const specialCount = zone.specialActivities?.length || 0;  // ★ NEW
    const locCount = Object.keys(zone.locations || {}).length;
    meta.textContent = `${fieldCount} field${fieldCount !== 1 ? 's' : ''} • ${specialCount} special${specialCount !== 1 ? 's' : ''} • ${locCount} location${locCount !== 1 ? 's' : ''}`;
    
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
    if (!detailPaneEl) return; // ★ FIX: Null check
    
    // ★ FIX: Cleanup any orphaned panels when re-rendering detail pane
    cleanupDropdownPanels();
    
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
            if (!window.AccessControl?.checkSetupAccess('delete zones')) return;
            if(confirm(`Delete zone "${zone.name}"? Fields and special activities will be unassigned.`)){
                // ★ FIX: Also cleanup any pinnedTileDefaults that reference locations in this zone
                const locationsInZone = Object.keys(zone.locations || {});
                if (locationsInZone.length > 0) {
                    Object.entries(pinnedTileDefaults).forEach(([tileName, location]) => {
                        if (locationsInZone.includes(location)) {
                            delete pinnedTileDefaults[tileName];
                            console.log(`[LOCATIONS] Removed orphaned default: "${tileName}" → "${location}" (zone deleted)`);
                        }
                    });
                }
                
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
        defaultStrip.style.cssText = "padding:10px 14px; background:linear-gradient(135deg, rgba(20,125,145,0.1), rgba(10,74,86,0.1)); border:1px solid rgba(20,125,145,0.3); border-radius:999px; margin-bottom:16px; color:#0F5F6E; font-size:0.85rem;";
        defaultStrip.innerHTML = `<strong>Default Zone</strong> — Items not assigned to any zone will use these settings.`;
        detailPaneEl.appendChild(defaultStrip);
    }

    // -- ACCORDION SECTIONS --
    detailPaneEl.appendChild(createSection("🚶 Transition Times", summaryTransition(zone), () => renderTransitionSection(zone)));
    detailPaneEl.appendChild(createSection("⚽ Fields & Specials", summaryFieldsAndSpecials(zone), () => renderFieldsAndSpecialsSection(zone)));  // ★ UPDATED
    detailPaneEl.appendChild(createSection("🏢 Locations / Facilities", summaryLocations(zone), () => renderLocationsSection(zone)));
}

//------------------------------------------------------------------
// ACCORDION SECTION BUILDER
//------------------------------------------------------------------
function createSection(title, summary, builder){
    const wrap = document.createElement("div"); 
    wrap.className = "detail-section";

    const head = document.createElement("div");
    head.className = "detail-section-header";

    const t = document.createElement("div");
    t.innerHTML = `<div class="detail-section-title">${title}</div><div class="detail-section-summary">${escapeHtml(summary)}</div>`;

    const caret = document.createElement("span");
    caret.innerHTML = `<svg width="20" height="20" fill="none" stroke="#9CA3AF" stroke-width="2" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"></path></svg>`;
    caret.style.transition = "transform 0.2s";

    head.appendChild(t);
    head.appendChild(caret);

    const body = document.createElement("div");
    body.className = "detail-section-body";

    head.onclick = () => {
        const open = body.style.display === "block";
        body.style.display = open ? "none" : "block";
        caret.style.transform = open ? "rotate(0deg)" : "rotate(90deg)";

        // ★ FIX: Cleanup dropdowns when closing section
        if (open) {
            cleanupDropdownPanels();
        }

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

// ★ UPDATED: Combined summary for fields and specials
function summaryFieldsAndSpecials(zone){
    const fieldCount = zone.fields?.length || 0;
    const specialCount = zone.specialActivities?.length || 0;
    
    if(fieldCount === 0 && specialCount === 0) return "Nothing assigned";
    
    const parts = [];
    if (fieldCount > 0) parts.push(`${fieldCount} field${fieldCount !== 1 ? 's' : ''}`);
    if (specialCount > 0) parts.push(`${specialCount} special${specialCount !== 1 ? 's' : ''}`);
    return parts.join(', ');
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
        const summaryEl = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if(summaryEl) summaryEl.textContent = summaryTransition(zone);
    };
    
    container.innerHTML = `
        <p class="muted" style="margin-top:0; margin-bottom:16px;">
            Transition time adds buffer before/after activities in this zone for travel or setup.
        </p>
        <div style="display:flex; gap:20px; flex-wrap:wrap; margin-bottom:16px;">
            <div>
                <label style="display:block; font-size:0.85rem; font-weight:600; margin-bottom:4px;">Pre-Buffer (minutes)</label>
                <input type="number" id="zone-pre-min" class="form-input form-input-small" min="0" step="5" value="${zone.transition.preMin}">
            </div>
            <div>
                <label style="display:block; font-size:0.85rem; font-weight:600; margin-bottom:4px;">Post-Buffer (minutes)</label>
                <input type="number" id="zone-post-min" class="form-input form-input-small" min="0" step="5" value="${zone.transition.postMin}">
            </div>
            <div>
                <label style="display:block; font-size:0.85rem; font-weight:600; margin-bottom:4px;">Max Concurrent Activities</label>
                <input type="number" id="zone-max-concurrent" class="form-input form-input-small" min="1" value="${zone.maxConcurrent}">
            </div>
        </div>
        <p class="muted" style="font-size:0.8rem;">
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
// ★ FIELDS & SPECIAL ACTIVITIES SECTION (Combined Multi-select dropdown)
//------------------------------------------------------------------
function renderFieldsAndSpecialsSection(zone){
    // ★ FIX: Clean up any orphaned dropdown panels first
    cleanupDropdownPanels();

    const container = document.createElement("div");
    
    // Ensure arrays exist
    if (!zone.fields) zone.fields = [];
    if (!zone.specialActivities) zone.specialActivities = [];
    
    const updateSummary = () => {
        const summaryEl = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if(summaryEl) summaryEl.textContent = summaryFieldsAndSpecials(zone);
    };
    
    // Get all fields from fields.js
    const allFields = window.getFields?.() || [];
    const fieldNames = allFields.map(f => f.name);
    
    // ★ NEW: Get all special activities
    const allSpecials = window.getAllSpecialActivities?.() || [];
    const specialNames = allSpecials.map(s => s.name);
    
    // Get items already assigned to OTHER zones
    const fieldsAssignedElsewhere = new Set();
    const specialsAssignedElsewhere = new Set();
    
    Object.entries(locationZones).forEach(([zoneName, z]) => {
        if(zoneName !== zone.name){
            (z.fields || []).forEach(f => fieldsAssignedElsewhere.add(f));
            (z.specialActivities || []).forEach(s => specialsAssignedElsewhere.add(s));
        }
    });
    
    container.innerHTML = `
        <p class="muted" style="margin-top:0; margin-bottom:16px;">
            Select which fields and special activities belong to this zone. They inherit the zone's transition times.
        </p>
        <div id="fields-specials-multiselect" class="multi-select-dropdown"></div>
    `;
    
    const multiSelectContainer = container.querySelector('#fields-specials-multiselect');
    
    // Build the multi-select
    const trigger = document.createElement("div");
    trigger.className = "multi-select-trigger";
    
    const renderTriggerContent = () => {
        trigger.innerHTML = "";
        
        const totalSelected = zone.fields.length + zone.specialActivities.length;
        
        if(totalSelected === 0){
            const placeholder = document.createElement("span");
            placeholder.className = "multi-select-placeholder";
            placeholder.textContent = "Click to select fields & specials...";
            trigger.appendChild(placeholder);
        } else {
            // Show field tags
            zone.fields.forEach(fieldName => {
                const tag = document.createElement("span");
                tag.className = "multi-select-tag";
                tag.innerHTML = `⚽ ${escapeHtml(fieldName)} <span class="multi-select-tag-remove" data-item="${escapeHtml(fieldName)}" data-type="field">×</span>`;
                trigger.appendChild(tag);
            });
            
            // ★ Show special activity tags
            zone.specialActivities.forEach(specialName => {
                const tag = document.createElement("span");
                tag.className = "multi-select-tag special-tag";
                tag.innerHTML = `⭐ ${escapeHtml(specialName)} <span class="multi-select-tag-remove" data-item="${escapeHtml(specialName)}" data-type="special">×</span>`;
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
        
        const totalItems = fieldNames.length + specialNames.length;
        
        if(totalItems === 0){
            const emptyMsg = document.createElement("div");
            emptyMsg.style.cssText = "padding: 16px; color: #6b7280; text-align: center; font-size: 0.9rem;";
            emptyMsg.textContent = "No fields or special activities created yet.";
            optionsPanel.appendChild(emptyMsg);
            return;
        }
        
        // ★ FIELDS SECTION
        if (fieldNames.length > 0) {
            const fieldHeader = document.createElement("div");
            fieldHeader.className = "multi-select-section-header";
            fieldHeader.textContent = `⚽ Fields (${fieldNames.length})`;
            optionsPanel.appendChild(fieldHeader);
            
            fieldNames.forEach(fieldName => {
                const isSelected = zone.fields.includes(fieldName);
                const isAssignedElsewhere = fieldsAssignedElsewhere.has(fieldName);
                
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
        }
        
        // ★ SPECIAL ACTIVITIES SECTION
        if (specialNames.length > 0) {
            const specialHeader = document.createElement("div");
            specialHeader.className = "multi-select-section-header";
            specialHeader.style.background = "#fef3c7";
            specialHeader.style.color = "#92400e";
            specialHeader.textContent = `⭐ Special Activities (${specialNames.length})`;
            optionsPanel.appendChild(specialHeader);
            
            specialNames.forEach(specialName => {
                const isSelected = zone.specialActivities.includes(specialName);
                const isAssignedElsewhere = specialsAssignedElsewhere.has(specialName);
                
                const option = document.createElement("div");
                option.className = "multi-select-option" + (isSelected ? " selected" : "") + (isAssignedElsewhere ? " disabled" : "");
                
                const checkbox = document.createElement("input");
                checkbox.type = "checkbox";
                checkbox.className = "multi-select-checkbox";
                checkbox.checked = isSelected;
                checkbox.disabled = isAssignedElsewhere;
                
                const label = document.createElement("span");
                label.className = "multi-select-option-label";
                label.textContent = specialName;
                
                option.appendChild(checkbox);
                option.appendChild(label);
                
                // Add type indicator
                const typeTag = document.createElement("span");
                typeTag.className = "multi-select-option-type special";
                typeTag.textContent = "Special";
                option.appendChild(typeTag);
                
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
                            zone.specialActivities = zone.specialActivities.filter(s => s !== specialName);
                        } else {
                            zone.specialActivities.push(specialName);
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
        }
    };
    
    renderOptions();
    
    // Position dropdown using fixed positioning to escape any overflow containers
    const positionDropdown = () => {
        const rect = trigger.getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        const spaceBelow = viewportHeight - rect.bottom - 20;
        const spaceAbove = rect.top - 20;
        
        let maxHeight = Math.min(350, Math.max(spaceBelow, spaceAbove));
        
        if(spaceBelow >= 150 || spaceBelow >= spaceAbove) {
            optionsPanel.style.top = (rect.bottom + 4) + 'px';
            optionsPanel.style.bottom = 'auto';
            maxHeight = Math.min(350, spaceBelow);
        } else {
            optionsPanel.style.bottom = (viewportHeight - rect.top + 4) + 'px';
            optionsPanel.style.top = 'auto';
            maxHeight = Math.min(350, spaceAbove);
        }
        
        optionsPanel.style.left = rect.left + 'px';
        optionsPanel.style.width = rect.width + 'px';
        optionsPanel.style.maxHeight = maxHeight + 'px';
    };
    
    // Toggle dropdown
    trigger.onclick = (e) => {
        if(e.target.classList.contains('multi-select-tag-remove')){
            const itemToRemove = e.target.dataset.item;
            const itemType = e.target.dataset.type;
            
            if (itemType === 'field') {
                zone.fields = zone.fields.filter(f => f !== itemToRemove);
            } else if (itemType === 'special') {
                zone.specialActivities = zone.specialActivities.filter(s => s !== itemToRemove);
            }
            
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
    
    // ★ FIX: Track event listeners for proper cleanup
    const repositionHandler = () => {
        if(optionsPanel.classList.contains('show')){
            positionDropdown();
        }
    };
    
    window.addEventListener('scroll', repositionHandler, true);
    window.addEventListener('resize', repositionHandler);
    
    activeEventListeners.push({ type: 'scroll', handler: repositionHandler, options: true, target: window });
    activeEventListeners.push({ type: 'resize', handler: repositionHandler, options: undefined, target: window });
    
    // Close on click outside
    const closeOnClickOutside = (e) => {
        if(!multiSelectContainer.contains(e.target) && !optionsPanel.contains(e.target)){
            optionsPanel.classList.remove('show');
            trigger.classList.remove('open');
        }
    };
    
    document.addEventListener('click', closeOnClickOutside);
    activeEventListeners.push({ type: 'click', handler: closeOnClickOutside, options: undefined, target: document });
    
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
        const summaryEl = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if(summaryEl) summaryEl.textContent = summaryLocations(zone);
    };
    
    const renderContent = () => {
        container.innerHTML = `
            <div id="locations-list"></div>
            <div style="display:flex; gap:8px; margin-top:16px; padding-top:16px; border-top:1px solid #E5E7EB; align-items:center;">
                <input type="text" id="new-location-input" class="form-input" placeholder="New location (e.g., Lunchroom)" style="flex:1;">
                <button id="add-location-btn" style="background:#111827; color:white; border:none; border-radius:8px; padding:10px 16px; cursor:pointer; font-weight:500; font-size:0.85rem; white-space:nowrap;">Add</button>
            </div>
        `;
        
        const listEl = container.querySelector('#locations-list');
        const addInput = container.querySelector('#new-location-input');
        const addBtn = container.querySelector('#add-location-btn');
        
        // Render existing locations
        const locationNames = Object.keys(zone.locations || {});
        
        if(locationNames.length === 0){
            listEl.innerHTML = `<div class="muted" style="padding:16px; text-align:center; border:1px dashed #E5E7EB; border-radius:8px;">
                No locations in this zone yet.<br>
                <span style="font-size:0.8rem;">Add facilities like Pool, Lunchroom, Gym, etc.</span>
            </div>`;
        } else {
            locationNames.forEach(locName => {
                const item = document.createElement("div");
                item.className = "location-item";
                item.innerHTML = `
                    <span class="location-item-name">${escapeHtml(locName)}</span>
                    <button class="location-delete-btn" data-loc="${escapeHtml(locName)}">✕ Remove</button>
                `;
                
                item.querySelector('.location-delete-btn').onclick = () => {
                    if (!window.AccessControl?.checkSetupAccess('delete locations')) return;
                    if(confirm(`Remove "${locName}" from this zone?`)){
                        // ★ FIX: Also cleanup pinnedTileDefaults
                        Object.entries(pinnedTileDefaults).forEach(([tileName, location]) => {
                            if (location === locName) {
                                delete pinnedTileDefaults[tileName];
                                console.log(`[LOCATIONS] Removed orphaned default: "${tileName}" → "${locName}"`);
                            }
                        });
                        
                        delete zone.locations[locName];
                        saveData();
                        renderContent();
                        updateSummary();
                        renderZonesList();
                        
                        // Refresh pinned tile defaults UI
                        window.refreshPinnedTileDefaultsUI?.();
                    }
                };
                
                listEl.appendChild(item);
            });
        }
        
        // Add new location
        const doAdd = () => {
            if (!window.AccessControl?.checkSetupAccess('add locations')) return;
            
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
            renderZonesList();

            // Refresh pinned tile defaults dropdown
            window.refreshPinnedTileDefaultsUI?.();
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
    // ✅ RBAC Check
    if (!window.AccessControl?.checkSetupAccess('add zones')) return;

    if (!addZoneInput) {
        console.warn('[LOCATIONS] addZoneInput element not found');
        return;
    }

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
        specialActivities: [],  // ★ NEW
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
// ★ REWRITTEN: Uses custom dropdown instead of native <select>
//------------------------------------------------------------------
let _pinnedLocOptionsPanel = null;
let _pinnedLocListeners = [];  // ★ Separate from activeEventListeners to survive cleanupDropdownPanels  // Track the body-appended options panel

function initPinnedTileDefaultsSection(){
    const listEl = document.getElementById("pinned-defaults-list");
    const tileInput = document.getElementById("new-pinned-tile-input");
    const pickerContainer = document.getElementById("pinned-location-picker");
    const addBtn = document.getElementById("add-pinned-default-btn");
    
    if(!listEl || !tileInput || !pickerContainer || !addBtn) return;
    
    // Reset selected location
    _selectedPinnedLocation = { name: '', displayName: '' };
    
    // Build custom location picker
    buildPinnedLocationPicker(pickerContainer);
    
    // Add button handler
    addBtn.onclick = () => {
        const tileName = tileInput.value.trim();
        const location = _selectedPinnedLocation.name;
        
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
        _selectedPinnedLocation = { name: '', displayName: '' };
        renderPinnedTileDefaults();
        // Re-render the picker trigger to show placeholder again
        updatePinnedPickerTrigger();
    };
    
    tileInput.onkeyup = (e) => { if(e.key === "Enter") addBtn.click(); };
    
    // Initial render
    renderPinnedTileDefaults();
}

function buildPinnedLocationPicker(pickerContainer) {
    pickerContainer.innerHTML = '';
    
    // ★ Cleanup previous pinned picker listeners
    _pinnedLocListeners.forEach(({ type, handler, options, target }) => {
        const eventTarget = target || window;
        try { eventTarget.removeEventListener(type, handler, options); } catch (e) {}
    });
    _pinnedLocListeners = [];
    
    // Create trigger
    const trigger = document.createElement('div');
    trigger.className = 'pinned-loc-trigger';
    trigger.id = 'pinned-loc-trigger';
    
    const labelSpan = document.createElement('span');
    labelSpan.id = 'pinned-loc-label';
    labelSpan.className = 'ploc-placeholder';
    labelSpan.textContent = '-- Select Location --';
    trigger.appendChild(labelSpan);
    
    const chevron = document.createElement('span');
    chevron.innerHTML = `<svg width="16" height="16" fill="none" stroke="#9CA3AF" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"></path></svg>`;
    trigger.appendChild(chevron);
    
    pickerContainer.appendChild(trigger);
    
    // Create options panel (appended to body to escape overflow)
    if (_pinnedLocOptionsPanel) {
        _pinnedLocOptionsPanel.remove();
    }
    const optionsPanel = document.createElement('div');
    optionsPanel.className = 'pinned-loc-options';
    optionsPanel.id = 'pinned-loc-options';
    document.body.appendChild(optionsPanel);
    _pinnedLocOptionsPanel = optionsPanel;
    
    // Populate options
    renderPinnedLocationOptions(optionsPanel);
    
    // Position helper
    const positionPanel = () => {
        const rect = trigger.getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        const spaceBelow = viewportHeight - rect.bottom - 20;
        const spaceAbove = rect.top - 20;
        
        if (spaceBelow >= 120 || spaceBelow >= spaceAbove) {
            optionsPanel.style.top = (rect.bottom + 4) + 'px';
            optionsPanel.style.bottom = 'auto';
            optionsPanel.style.maxHeight = Math.min(260, spaceBelow) + 'px';
        } else {
            optionsPanel.style.bottom = (viewportHeight - rect.top + 4) + 'px';
            optionsPanel.style.top = 'auto';
            optionsPanel.style.maxHeight = Math.min(260, spaceAbove) + 'px';
        }
        
        optionsPanel.style.left = rect.left + 'px';
        optionsPanel.style.width = Math.max(rect.width, 220) + 'px';
    };
    
    // Toggle
    trigger.onclick = () => {
        const isOpen = optionsPanel.classList.contains('show');
        if (!isOpen) {
            // Refresh options in case locations changed
            renderPinnedLocationOptions(optionsPanel);
            positionPanel();
        }
        optionsPanel.classList.toggle('show');
        trigger.classList.toggle('open');
    };
    
    // Reposition on scroll/resize
    const repositionHandler = () => {
        if (optionsPanel.classList.contains('show')) {
            positionPanel();
        }
    };
    window.addEventListener('scroll', repositionHandler, true);
    window.addEventListener('resize', repositionHandler);
    _pinnedLocListeners.push({ type: 'scroll', handler: repositionHandler, options: true, target: window });
    _pinnedLocListeners.push({ type: 'resize', handler: repositionHandler, options: undefined, target: window });
    
    // Close on outside click
    const closeHandler = (e) => {
        if (!pickerContainer.contains(e.target) && !optionsPanel.contains(e.target)) {
            optionsPanel.classList.remove('show');
            trigger.classList.remove('open');
        }
    };
    document.addEventListener('click', closeHandler);
    _pinnedLocListeners.push({ type: 'click', handler: closeHandler, options: undefined, target: document });
}

function renderPinnedLocationOptions(optionsPanel) {
    if (!optionsPanel) return;
    optionsPanel.innerHTML = '';
    
    // ★ FIX: Read directly from local locationZones state (not window.getAllLocations which may be overridden)
    // ★ FIX: Filter out special activities — only show actual facilities (Pool, Lunchroom, Gym, etc.)
    const specialNames = new Set((window.getAllSpecialActivities?.() || []).map(s => s.name));
    const fieldNames = new Set((window.getFields?.() || []).map(f => f.name));
    
    const allLocations = [];
    Object.entries(locationZones).forEach(([zoneName, zone]) => {
        if (!zone || typeof zone !== 'object') return;
        Object.keys(zone.locations || {}).forEach(locName => {
            // Skip if this is actually a special activity or field name stored as a location
            if (specialNames.has(locName) || fieldNames.has(locName)) return;
            allLocations.push({
                name: locName,
                zone: zoneName,
                displayName: `${locName} (${zoneName})`
            });
        });
    });
    
    if (allLocations.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'pinned-loc-option-empty';
        empty.textContent = 'No locations created yet. Add locations inside a zone first.';
        optionsPanel.appendChild(empty);
        return;
    }
    
    // Group by zone
    const byZone = {};
    allLocations.forEach(loc => {
        if (!byZone[loc.zone]) byZone[loc.zone] = [];
        byZone[loc.zone].push(loc);
    });
    
    Object.entries(byZone).forEach(([zoneName, locs]) => {
        // Zone header
        const header = document.createElement('div');
        header.style.cssText = 'padding:8px 14px; background:#F9FAFB; border-bottom:1px solid #E5E7EB; font-size:0.75rem; font-weight:600; color:#6B7280; text-transform:uppercase; letter-spacing:0.03em; position:sticky; top:0; z-index:1;';
        header.textContent = `🏢 ${zoneName}`;
        optionsPanel.appendChild(header);
        
        locs.forEach(loc => {
            const option = document.createElement('div');
            option.className = 'pinned-loc-option' + (_selectedPinnedLocation.name === loc.name ? ' selected' : '');
            
            const nameSpan = document.createElement('span');
            nameSpan.textContent = loc.name;
            nameSpan.style.color = '#111827';
            option.appendChild(nameSpan);
            
            const zoneBadge = document.createElement('span');
            zoneBadge.className = 'ploc-zone-badge';
            zoneBadge.textContent = zoneName;
            option.appendChild(zoneBadge);
            
            option.onclick = (e) => {
                e.stopPropagation();
                _selectedPinnedLocation = { name: loc.name, displayName: loc.displayName };
                updatePinnedPickerTrigger();
                // Close panel
                optionsPanel.classList.remove('show');
                const trigger = document.getElementById('pinned-loc-trigger');
                if (trigger) trigger.classList.remove('open');
                // Re-render to update selected state
                renderPinnedLocationOptions(optionsPanel);
            };
            
            optionsPanel.appendChild(option);
        });
    });
}

function updatePinnedPickerTrigger() {
    const labelEl = document.getElementById('pinned-loc-label');
    if (!labelEl) return;
    
    if (_selectedPinnedLocation.name) {
        labelEl.textContent = _selectedPinnedLocation.displayName || _selectedPinnedLocation.name;
        labelEl.className = 'ploc-selected';
    } else {
        labelEl.textContent = '-- Select Location --';
        labelEl.className = 'ploc-placeholder';
    }
}

function renderPinnedTileDefaults(){
    const listEl = document.getElementById("pinned-defaults-list");
    
    if(!listEl) return;
    
    // ★ Refresh the custom picker options (in case locations changed)
    if (_pinnedLocOptionsPanel) {
        renderPinnedLocationOptions(_pinnedLocOptionsPanel);
    }
    
    const entries = Object.entries(pinnedTileDefaults);
    
    if(entries.length === 0){
        listEl.innerHTML = `<div class="muted" style="padding:12px; text-align:center; border:1px dashed #E5E7EB; border-radius:8px; font-size:0.85rem;">
            No defaults set yet.
        </div>`;
        return;
    }
    
    listEl.innerHTML = "";
    
    entries.forEach(([tileName, locationName]) => {
        const item = document.createElement("div");
        item.style.cssText = "display:flex; justify-content:space-between; align-items:center; padding:10px 12px; background:#F9FAFB; border:1px solid #E5E7EB; border-radius:8px; margin-bottom:6px;";
        item.innerHTML = `
            <div>
                <span style="font-weight:500; color:#111827;">${escapeHtml(tileName)}</span>
                <span style="color:#6B7280; margin:0 8px;">→</span>
                <span style="color:#147D91;">${escapeHtml(locationName)}</span>
            </div>
            <button style="background:transparent; border:none; color:#DC2626; cursor:pointer; padding:4px 8px; border-radius:4px;" data-tile="${escapeHtml(tileName)}">✕</button>
        `;
        
        item.querySelector('button').onclick = () => {
            delete pinnedTileDefaults[tileName];
            saveData();
            renderPinnedTileDefaults();
        };
        
        listEl.appendChild(item);
    });
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
        inp.style.cssText = "font-size:inherit; font-weight:inherit; border:1px solid #147D91; outline:none; border-radius:4px; padding:2px 6px; width:" + Math.max(100, el.offsetWidth + 20) + "px;";

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

function buildLocationOptions(selectedLocation = '') {
    const allLocations = window.getAllLocations?.() || [];
    let html = '<option value="">-- None --</option>';
    
    allLocations.forEach(loc => {
        const selected = loc.name === selectedLocation ? 'selected' : '';
        html += `<option value="${escapeHtml(loc.name)}" ${selected}>${escapeHtml(loc.displayName)}</option>`;
    });
    
    return html;
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
    
    // ★ FIX: Filter out special activities and fields — only return actual facilities
    const specialNames = new Set((window.getAllSpecialActivities?.() || []).map(s => s.name));
    const fieldNames = new Set((window.getFields?.() || []).map(f => f.name));
    
    Object.entries(zones).forEach(([zoneName, zone]) => {
        if (!zone || typeof zone !== 'object') return;
        Object.keys(zone.locations || {}).forEach(locName => {
            if (specialNames.has(locName) || fieldNames.has(locName)) return;
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
    if (!fieldName) return null;
    
    const settings = window.loadGlobalSettings?.() || {};
    const zones = settings.locationZones || {};
    
    for(const [zoneName, zone] of Object.entries(zones)){
        if (!zone || typeof zone !== 'object') continue;
        if(Array.isArray(zone.fields) && zone.fields.includes(fieldName)){
            return zone;
        }
    }
    
    return null;
};

// ★ NEW: Get zone for a specific special activity
window.getZoneForSpecialActivity = function(specialName){
    if (!specialName) return null;
    
    const settings = window.loadGlobalSettings?.() || {};
    const zones = settings.locationZones || {};
    
    for(const [zoneName, zone] of Object.entries(zones)){
        if (!zone || typeof zone !== 'object') continue;
        if(Array.isArray(zone.specialActivities) && zone.specialActivities.includes(specialName)){
            return zone;
        }
    }
    
    return null;
};

// Get default location for a pinned tile type (e.g., "Lunch" → "Lunchroom")
window.getPinnedTileDefaultLocation = function(tileType){
    if (!tileType) return null;
    
    const settings = window.loadGlobalSettings?.() || {};
    const defaults = settings.pinnedTileDefaults || {};
    
    // Try exact match first
    if (defaults[tileType]) {
        return defaults[tileType];
    }
    
    // ★ FIX: Case-insensitive lookup
    const lowerType = tileType.toLowerCase();
    for (const [key, value] of Object.entries(defaults)) {
        if (key.toLowerCase() === lowerType) {
            return value;
        }
    }
    
    // ★ FIX: Common alias patterns
    const ALIASES = {
        'swim': ['pool', 'swimming', 'aquatics'],
        'pool': ['swim', 'swimming', 'aquatics'],
        'lunch': ['lunchroom', 'dining', 'cafeteria'],
        'snacks': ['snack', 'snacktime'],
        'dismissal': ['dismiss', 'end']
    };
    
    const aliases = ALIASES[lowerType] || [];
    for (const alias of aliases) {
        for (const [key, value] of Object.entries(defaults)) {
            if (key.toLowerCase() === alias || key.toLowerCase().includes(alias)) {
                return value;
            }
        }
    }
    
    return null;
};

// Get all pinned tile defaults
window.getPinnedTileDefaults = function(){
    const settings = window.loadGlobalSettings?.() || {};
    return settings.pinnedTileDefaults || {};
};

// Set a pinned tile default location
window.setPinnedTileDefaultLocation = function(tileType, locationName){
    if (!tileType) return;
    
    const settings = window.loadGlobalSettings?.() || {};
    settings.pinnedTileDefaults = settings.pinnedTileDefaults || {};
    settings.pinnedTileDefaults[tileType] = locationName || null;
    
    window.saveGlobalSettings?.("pinnedTileDefaults", settings.pinnedTileDefaults);
    
    if (_isInitialized) {
        pinnedTileDefaults = settings.pinnedTileDefaults;
    }
};

// Refresh pinned tile defaults UI
window.refreshPinnedTileDefaultsUI = renderPinnedTileDefaults;

// ★ FIX: Export cleanup function
window.cleanupLocationsModule = function() {
    // Also cleanup the pinned location options panel
    if (_pinnedLocOptionsPanel) {
        _pinnedLocOptionsPanel.remove();
        _pinnedLocOptionsPanel = null;
    }
    // ★ Cleanup pinned picker listeners separately
    _pinnedLocListeners.forEach(({ type, handler, options, target }) => {
        const eventTarget = target || window;
        try { eventTarget.removeEventListener(type, handler, options); } catch (e) {}
    });
    _pinnedLocListeners = [];
    cleanupDropdownPanels();
    cleanupTabListeners();
    _isInitialized = false;
};

// ★ Force refresh from cloud/storage
window.refreshLocationsFromStorage = function() {
    if (_isInitialized) {
        refreshFromStorage();
    }
};

// ★ Get location zone for a location name (not field)
window.getZoneForLocation = function(locationName) {
    if (!locationName) return null;
    
    const settings = window.loadGlobalSettings?.() || {};
    const zones = settings.locationZones || {};
    
    for(const [zoneName, zone] of Object.entries(zones)){
        if (!zone || typeof zone !== 'object') continue;
        if (zone.locations && zone.locations[locationName]) {
            return zone;
        }
    }
    
    return null;
};

// ★ Check if location/zone system is ready
window.isLocationsSystemReady = function() {
    return _isInitialized;
};

// ★ Get transition times for a field
window.getTransitionForField = function(fieldName) {
    const zone = window.getZoneForField?.(fieldName);
    if (zone && zone.transition) {
        return {
            preMin: parseInt(zone.transition.preMin) || 0,
            postMin: parseInt(zone.transition.postMin) || 0
        };
    }
    return { preMin: 0, postMin: 0 };
};

// ★ NEW: Get transition times for a special activity
window.getTransitionForSpecialActivity = function(specialName) {
    const zone = window.getZoneForSpecialActivity?.(specialName);
    if (zone && zone.transition) {
        return {
            preMin: parseInt(zone.transition.preMin) || 0,
            postMin: parseInt(zone.transition.postMin) || 0
        };
    }
    return { preMin: 0, postMin: 0 };
};

// ★ Check zone capacity
window.getZoneMaxConcurrent = function(zoneName) {
    if (!zoneName) return 99;
    const settings = window.loadGlobalSettings?.() || {};
    const zone = settings.locationZones?.[zoneName];
    return parseInt(zone?.maxConcurrent) || 99;
};

// ★ Check if adding an activity to a zone would exceed capacity
window.checkZoneCapacity = function(zoneName, slotIndex, currentCount) {
    const maxConcurrent = window.getZoneMaxConcurrent(zoneName);
    return (currentCount || 0) < maxConcurrent;
};

// ★ Get all fields in a zone
window.getFieldsInZone = function(zoneName) {
    if (!zoneName) return [];
    const settings = window.loadGlobalSettings?.() || {};
    const zone = settings.locationZones?.[zoneName];
    return Array.isArray(zone?.fields) ? [...zone.fields] : [];
};

// ★ NEW: Get all special activities in a zone
window.getSpecialActivitiesInZone = function(zoneName) {
    if (!zoneName) return [];
    const settings = window.loadGlobalSettings?.() || {};
    const zone = settings.locationZones?.[zoneName];
    return Array.isArray(zone?.specialActivities) ? [...zone.specialActivities] : [];
};

// ★ Check if a field belongs to any zone
window.isFieldInAnyZone = function(fieldName) {
    if (!fieldName) return false;
    const settings = window.loadGlobalSettings?.() || {};
    const zones = settings.locationZones || {};
    
    for (const zone of Object.values(zones)) {
        if (!zone || typeof zone !== 'object') continue;
        if (Array.isArray(zone.fields) && zone.fields.includes(fieldName)) {
            return true;
        }
    }
    return false;
};

// ★ NEW: Check if a special activity belongs to any zone
window.isSpecialActivityInAnyZone = function(specialName) {
    if (!specialName) return false;
    const settings = window.loadGlobalSettings?.() || {};
    const zones = settings.locationZones || {};
    
    for (const zone of Object.values(zones)) {
        if (!zone || typeof zone !== 'object') continue;
        if (Array.isArray(zone.specialActivities) && zone.specialActivities.includes(specialName)) {
            return true;
        }
    }
    return false;
};

// ★ Batch check multiple fields for zone membership
window.getZonesForFields = function(fieldNames) {
    if (!Array.isArray(fieldNames)) return {};
    
    const result = {};
    const settings = window.loadGlobalSettings?.() || {};
    const zones = settings.locationZones || {};
    
    for (const fieldName of fieldNames) {
        result[fieldName] = null;
        for (const [zoneName, zone] of Object.entries(zones)) {
            if (!zone || typeof zone !== 'object') continue;
            if (Array.isArray(zone.fields) && zone.fields.includes(fieldName)) {
                result[fieldName] = zone;
                break;
            }
        }
    }
    
    return result;
};

console.log("[LOCATIONS] Location Zones module v2.1 loaded");

})();
