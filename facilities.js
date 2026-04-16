// ============================================================================
// facilities.js — UNIFIED FACILITY MANAGEMENT v1.0
// ============================================================================
// Replaces Fields + Special Activities + Locations tabs with a single
// unified Facilities tab where users configure physical spaces.
//
// Each facility can be used for:
//   - Sports (field/court config)
//   - Special Activities (named specials hosted at this facility)
//   - General Activities (lunch, snacks, swim, etc.)
//
// Data is stored in settings.facilities (metadata) and synced to legacy
// structures (app1.fields, app1.specialActivities, pinnedTileDefaults)
// for backward compatibility with the scheduler engine.
// ============================================================================
(function(){
'use strict';

console.log("[FACILITIES] Facilities module v1.0 loading...");

// =========================================================================
// STATE
// =========================================================================
let facilities = [];
let selectedFacilityId = null;
let facilitiesListEl = null;
let detailPaneEl = null;
let addFacilityInput = null;

// Sport metadata (min/max players) - synced with app1.js
let sportMetaData = {};
// Combined fields state
let fieldCombos = {};
let _comboLookup = { combinedToSubs: {}, subToCombined: {}, allComboFields: new Set() };

// =========================================================================
// INIT
// =========================================================================
function initFacilitiesTab() {
    const container = document.getElementById("facilities");
    if (!container) return;

    loadData();
    container.innerHTML = "";

    const contentWrapper = document.createElement('div');
    contentWrapper.innerHTML = `
        <div class="setup-grid">
          <section class="setup-card setup-card-wide" style="border:none; box-shadow:none; background:transparent;">
            <div class="setup-card-header" style="margin-bottom:20px;">
              <span class="setup-step-pill">Facilities</span>
              <div class="setup-card-text">
                <h3>Manage Your Facilities</h3>
                <p>Add your physical spaces (courts, fields, rooms) and configure what each one is used for.</p>
              </div>
            </div>

            <div style="display:flex; flex-wrap:wrap; gap:24px;">
              <!-- LEFT SIDE: MASTER LIST -->
              <div style="flex:1; min-width:280px;">
                <div class="setup-subtitle" style="margin-bottom:8px;">All Facilities</div>

                <div style="background:white; padding:10px; border-radius:12px; border:1px solid #E5E7EB; margin-bottom:12px; display:flex; gap:8px;">
                  <input id="new-facility-input" placeholder="New Facility (e.g., Court 1, Gym, Lunchroom)" style="flex:1; border:none; outline:none; font-size:0.9rem;">
                  <button id="add-facility-btn" style="background:#111; color:white; border:none; border-radius:6px; padding:6px 12px; font-size:0.8rem; cursor:pointer;">Add</button>
                </div>

                <div id="facilities-master-list" style="max-height:600px; overflow-y:auto;"></div>
              </div>

              <!-- RIGHT SIDE: DETAIL PANE -->
              <div style="flex:1.4; min-width:340px; position:sticky; top:0; align-self:flex-start;">
                <div class="setup-subtitle">Facility Configuration</div>
                <div id="facilities-detail-pane" style="margin-top:8px; max-height:calc(100vh - 120px); overflow-y:auto; padding-right:4px;"></div>
              </div>
            </div>
          </section>
        </div>`;

    container.appendChild(contentWrapper);

    facilitiesListEl = document.getElementById("facilities-master-list");
    detailPaneEl = document.getElementById("facilities-detail-pane");
    addFacilityInput = document.getElementById("new-facility-input");

    document.getElementById("add-facility-btn").onclick = addFacility;
    addFacilityInput.onkeyup = e => { if (e.key === "Enter") addFacility(); };

    renderMasterList();
    renderDetailPane();
}

// =========================================================================
// DATA LOADING
// =========================================================================
function loadData() {
    const settings = window.loadGlobalSettings?.() || {};
    const app1 = settings.app1 || {};
    sportMetaData = app1.sportMetaData || {};
    fieldCombos = app1.fieldCombos || {};
    rebuildComboLookups();

    // Load facilities metadata
    facilities = settings.facilities || [];

    // If no facilities exist but legacy data does, migrate
    if (facilities.length === 0) {
        const legacyFields = app1.fields || [];
        const legacySpecials = settings.specialActivities || app1.specialActivities || [];
        const legacyZones = settings.locationZones || {};
        const legacyPinned = settings.pinnedTileDefaults || {};

        if (legacyFields.length > 0 || legacySpecials.length > 0 || Object.keys(legacyZones).length > 0) {
            migrateLegacyToFacilities(legacyFields, legacySpecials, legacyZones, legacyPinned);
        }
    }
}

// =========================================================================
// MIGRATION — One-time conversion from legacy data
// =========================================================================
function migrateLegacyToFacilities(legacyFields, legacySpecials, legacyZones, legacyPinned) {
    console.log("[FACILITIES] Migrating legacy data to facilities...");
    const newFacilities = [];
    const now = Date.now();

    // Build a map: location -> [special activity names]
    const specialsByLocation = {};
    legacySpecials.forEach(s => {
        if (s.location) {
            if (!specialsByLocation[s.location]) specialsByLocation[s.location] = [];
            specialsByLocation[s.location].push(s.name);
        }
    });

    // Build a map: location name -> general activities from pinned defaults
    const pinnedByLocation = {};
    Object.entries(legacyPinned).forEach(([actName, locName]) => {
        if (locName) {
            if (!pinnedByLocation[locName]) pinnedByLocation[locName] = [];
            pinnedByLocation[locName].push({ name: actName, quickType: actName.toLowerCase() });
        }
    });

    // 1. Convert each field to a facility
    legacyFields.forEach((f, i) => {
        const fac = {
            id: 'fac_' + (now + i),
            name: f.name,
            usedFor: ['sports'],
            specialActivityNames: specialsByLocation[f.name] || [],
            generalActivities: pinnedByLocation[f.name] || [],
            swimConfig: { preSwimMin: 5, postSwimMin: 5 },
            order: i
        };
        if (fac.specialActivityNames.length > 0) fac.usedFor.push('special');
        if (fac.generalActivities.length > 0) fac.usedFor.push('general');
        newFacilities.push(fac);
    });

    // 2. Create facilities for zone locations that aren't already fields
    const fieldNames = new Set(legacyFields.map(f => f.name));
    Object.values(legacyZones).forEach(zone => {
        if (zone.locations && typeof zone.locations === 'object') {
            Object.keys(zone.locations).forEach(locName => {
                if (!fieldNames.has(locName) && !newFacilities.some(f => f.name === locName)) {
                    const fac = {
                        id: 'fac_' + (now + newFacilities.length),
                        name: locName,
                        usedFor: [],
                        specialActivityNames: specialsByLocation[locName] || [],
                        generalActivities: pinnedByLocation[locName] || [],
                        swimConfig: { preSwimMin: 5, postSwimMin: 5 },
                        order: newFacilities.length
                    };
                    if (fac.specialActivityNames.length > 0) fac.usedFor.push('special');
                    if (fac.generalActivities.length > 0) fac.usedFor.push('general');
                    if (fac.usedFor.length === 0) fac.usedFor.push('general');
                    newFacilities.push(fac);
                }
            });
        }
    });

    // 3. Create facilities for special activities with locations not yet covered
    legacySpecials.forEach(s => {
        if (s.location && !newFacilities.some(f => f.name === s.location)) {
            const fac = {
                id: 'fac_' + (now + newFacilities.length),
                name: s.location,
                usedFor: ['special'],
                specialActivityNames: [s.name],
                generalActivities: [],
                swimConfig: { preSwimMin: 5, postSwimMin: 5 },
                order: newFacilities.length
            };
            newFacilities.push(fac);
        }
    });

    facilities = newFacilities;
    saveFacilitiesMetadata();
    console.log(`[FACILITIES] Migrated ${facilities.length} facilities from legacy data`);
}

// =========================================================================
// SAVE — Facilities metadata + sync to legacy structures
// =========================================================================
function saveFacilitiesMetadata() {
    window.saveGlobalSettings?.("facilities", facilities);
}

function saveData() {
    if (!window.AccessControl?.canEditSetup?.()) {
        console.warn('[FACILITIES] Save blocked - insufficient permissions');
        return;
    }

    saveFacilitiesMetadata();

    // Sync each facility to legacy structures
    syncAllToLegacy();

    if (typeof window.requestCloudSync === 'function') {
        window.requestCloudSync();
    }

    console.log('☁️ [FACILITIES] Saved', facilities.length, 'facilities');
}

function syncAllToLegacy() {
    const settings = window.loadGlobalSettings?.() || {};
    const app1 = settings.app1 || {};

    // Rebuild fields array from facilities with "sports" usage
    const newFields = [];
    const existingFields = app1.fields || [];

    facilities.forEach(fac => {
        if (fac.usedFor.includes('sports')) {
            // Find existing field data or create new
            let fieldData = existingFields.find(f => f.name === fac.name);
            if (!fieldData) {
                fieldData = {
                    name: fac.name,
                    activities: [],
                    available: true,
                    sharableWith: { type: 'not_sharable', divisions: [], capacity: 1 },
                    limitUsage: { enabled: false, divisions: {}, priorityList: [], usePriority: false },
                    timeRules: [],
                    rainyDayAvailable: false
                };
            }
            newFields.push(fieldData);
        }
    });

    // Save fields
    app1.fields = newFields;
    app1.sportMetaData = sportMetaData;
    app1.fieldCombos = fieldCombos;
    window.saveGlobalSettings?.("app1", app1);
    window.saveGlobalSettings?.("fields", newFields);

    // Rebuild special activities from facilities with "special" usage
    const existingSpecials = window.getAllSpecialActivities?.() || [];
    const newSpecials = [];
    const processedSpecialNames = new Set();

    facilities.forEach(fac => {
        if (fac.usedFor.includes('special')) {
            (fac.specialActivityNames || []).forEach(saName => {
                if (processedSpecialNames.has(saName)) return;
                processedSpecialNames.add(saName);

                let existing = existingSpecials.find(s => s.name === saName);
                if (!existing) {
                    existing = createDefaultSpecialActivity(saName);
                }
                existing.location = fac.name;
                newSpecials.push(existing);
            });
        }
    });

    // Keep specials not tied to any facility
    existingSpecials.forEach(s => {
        if (!processedSpecialNames.has(s.name)) {
            newSpecials.push(s);
        }
    });

    window.saveGlobalSpecialActivities?.(newSpecials);

    // Update pinned tile defaults for general activities
    const pinned = window.getPinnedTileDefaults?.() || {};
    facilities.forEach(fac => {
        if (fac.usedFor.includes('general')) {
            (fac.generalActivities || []).forEach(ga => {
                pinned[ga.name] = fac.name;
            });
        }
    });
    window.savePinnedTileDefaults?.(pinned);

    // Refresh activity properties for scheduler
    if (typeof window.refreshActivityPropertiesFromFields === 'function') {
        setTimeout(() => window.refreshActivityPropertiesFromFields(), 50);
    }
}

function createDefaultSpecialActivity(name) {
    return {
        name: name,
        type: 'Special',
        available: true,
        sharableWith: { type: 'not_sharable', divisions: [], capacity: 2 },
        limitUsage: { enabled: false, divisions: {}, priorityList: [], usePriority: false },
        timeRules: [],
        maxUsage: null,
        maxUsagePeriod: 'half',
        frequencyWeeks: 0,
        rainyDayExclusive: false,
        rainyDayOnly: false,
        prepDuration: 0,
        isIndoor: true,
        rainyDayAvailable: true,
        multiPart: { enabled: false, totalParts: 2, daysBetween: 3 },
        location: ''
    };
}

// =========================================================================
// ADD / DELETE FACILITY
// =========================================================================
function addFacility() {
    if (!window.AccessControl?.checkSetupAccess?.('add facilities')) return;

    const n = addFacilityInput.value.trim();
    if (!n) return;

    if (facilities.some(f => f.name.toLowerCase() === n.toLowerCase())) {
        alert("A facility with that name already exists.");
        return;
    }

    facilities.push({
        id: 'fac_' + Date.now(),
        name: n,
        usedFor: [],
        specialActivityNames: [],
        generalActivities: [],
        swimConfig: { preSwimMin: 5, postSwimMin: 5 },
        order: facilities.length
    });

    addFacilityInput.value = "";
    saveData();
    selectedFacilityId = `fac-${n}`;
    renderMasterList();
    renderDetailPane();
}

function deleteFacility(fac) {
    if (!window.AccessControl?.canEraseData?.()) {
        window.AccessControl?.showPermissionDenied?.('delete facilities');
        return;
    }
    if (!confirm(`Delete "${fac.name}"?\n\nThis will also remove associated field and activity data.`)) return;

    // Cleanup legacy data
    if (fac.usedFor.includes('sports')) {
        // Remove from fields
        const settings = window.loadGlobalSettings?.() || {};
        const app1 = settings.app1 || {};
        app1.fields = (app1.fields || []).filter(f => f.name !== fac.name);
        window.saveGlobalSettings?.("app1", app1);

        // Cleanup schedule references
        cleanupDeletedField(fac.name);
        handleComboFieldDeleted(fac.name);
    }

    if (fac.usedFor.includes('special')) {
        const allSpecials = window.getAllSpecialActivities?.() || [];
        const remaining = allSpecials.filter(s => !(fac.specialActivityNames || []).includes(s.name));
        window.saveGlobalSpecialActivities?.(remaining);
    }

    if (fac.usedFor.includes('general')) {
        const pinned = window.getPinnedTileDefaults?.() || {};
        (fac.generalActivities || []).forEach(ga => {
            delete pinned[ga.name];
        });
        window.savePinnedTileDefaults?.(pinned);
    }

    // Remove from zones
    const zones = window.getLocationZones?.() || {};
    let zonesChanged = false;
    Object.values(zones).forEach(zone => {
        if (zone.fields) {
            const idx = zone.fields.indexOf(fac.name);
            if (idx !== -1) { zone.fields.splice(idx, 1); zonesChanged = true; }
        }
        if (zone.specialActivities) {
            (fac.specialActivityNames || []).forEach(saName => {
                const idx = zone.specialActivities.indexOf(saName);
                if (idx !== -1) { zone.specialActivities.splice(idx, 1); zonesChanged = true; }
            });
        }
        if (zone.locations?.[fac.name]) {
            delete zone.locations[fac.name];
            zonesChanged = true;
        }
    });
    if (zonesChanged) window.saveLocationZones?.(zones);

    facilities = facilities.filter(f => f !== fac);
    saveFacilitiesMetadata();
    selectedFacilityId = null;
    renderMasterList();
    renderDetailPane();
}

// =========================================================================
// MASTER LIST (Left Pane)
// =========================================================================
function renderMasterList() {
    facilitiesListEl.innerHTML = "";

    if (facilities.length === 0) {
        facilitiesListEl.innerHTML = `<div style="padding:20px; text-align:center; color:#9CA3AF;">No facilities created yet.</div>`;
        return;
    }

    facilities.sort((a, b) => (a.order || 0) - (b.order || 0));
    facilities.forEach(fac => facilitiesListEl.appendChild(masterListItem(fac)));
}

function masterListItem(fac) {
    const id = `fac-${fac.name}`;
    const isSelected = id === selectedFacilityId;
    const el = document.createElement("div");
    el.style.cssText = `
        padding:12px 16px; margin:4px 0; border-radius:12px; cursor:pointer;
        display:flex; align-items:center; justify-content:space-between;
        transition:all 0.15s ease;
        background:${isSelected ? 'rgba(20,125,145,0.08)' : '#F9FAFB'};
        border:1px solid ${isSelected ? '#147D91' : '#E5E7EB'};
        ${isSelected ? 'box-shadow:0 0 0 1px rgba(20,125,145,0.3), 0 4px 12px rgba(20,125,145,0.1);' : ''}
    `;
    el.onmouseenter = () => { if (!isSelected) { el.style.background = '#F3F4F6'; el.style.borderColor = 'rgba(20,125,145,0.4)'; } };
    el.onmouseleave = () => { if (!isSelected) { el.style.background = '#F9FAFB'; el.style.borderColor = '#E5E7EB'; } };
    el.onclick = () => { selectedFacilityId = id; renderMasterList(); renderDetailPane(); };

    const name = document.createElement("div");
    name.style.cssText = "font-weight:500; font-size:0.9rem; color:#1F2937;";
    name.textContent = fac.name;
    el.appendChild(name);

    // Type badges
    if (fac.usedFor.length > 0) {
        const badgeWrap = document.createElement('div');
        badgeWrap.style.cssText = 'display:flex; gap:3px;';
        fac.usedFor.forEach(type => {
            const badge = document.createElement('span');
            const colors = { sports: '#147D91', special: '#7C3AED', general: '#D97706' };
            const labels = { sports: 'S', special: 'SA', general: 'G' };
            badge.style.cssText = `font-size:0.6rem; color:white; background:${colors[type] || '#6B7280'}; border-radius:3px; padding:2px 6px; font-weight:600; line-height:1;`;
            badge.textContent = labels[type] || type;
            badgeWrap.appendChild(badge);
        });
        el.appendChild(badgeWrap);
    }

    return el;
}

// =========================================================================
// DETAIL PANE (Right Pane)
// =========================================================================
function renderDetailPane() {
    if (!selectedFacilityId) {
        detailPaneEl.innerHTML = `
            <div style="height:300px; display:flex; align-items:center; justify-content:center; color:#9CA3AF; border:1px dashed #E5E7EB; border-radius:12px;">
                Select a facility to configure
            </div>`;
        return;
    }

    const name = selectedFacilityId.replace(/^fac-/, '');
    const fac = facilities.find(f => f.name === name);
    if (!fac) {
        detailPaneEl.innerHTML = `<p class='muted'>Not found.</p>`;
        return;
    }

    detailPaneEl.innerHTML = "";

    // -- HEADER --
    const header = document.createElement("div");
    header.style.cssText = "display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;";

    const title = document.createElement("h2");
    title.textContent = fac.name;
    title.style.cssText = "margin:0; font-size:1.25rem;";
    title.title = "Double click to rename";

    makeEditable(title, newName => {
        if (!newName.trim()) return;
        const oldName = fac.name;
        if (oldName === newName) return;
        if (facilities.some(f => f !== fac && f.name.toLowerCase() === newName.toLowerCase())) {
            alert(`A facility named "${newName}" already exists.`);
            return;
        }

        fac.name = newName;
        selectedFacilityId = `fac-${newName}`;

        // Propagate rename to legacy
        if (fac.usedFor.includes('sports')) {
            propagateFieldRename(oldName, newName);
            handleComboFieldRenamed(oldName, newName);
            // Rename in app1.fields
            const settings = window.loadGlobalSettings?.() || {};
            const field = (settings.app1?.fields || []).find(f => f.name === oldName);
            if (field) field.name = newName;
            if (settings.app1) window.saveGlobalSettings?.("app1", settings.app1);
        }

        saveData();
        renderMasterList();
        renderDetailPane();
    });

    const delBtn = document.createElement("button");
    delBtn.innerHTML = `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg> Delete`;
    delBtn.style.cssText = "color:#DC2626; background:#FEF2F2; border:1px solid #FECACA; padding:6px 12px; border-radius:6px; cursor:pointer; display:flex; gap:6px; align-items:center;";
    delBtn.onclick = () => deleteFacility(fac);

    header.appendChild(title);
    header.appendChild(delBtn);
    detailPaneEl.appendChild(header);

    // -- USED FOR SELECTOR --
    detailPaneEl.appendChild(renderUsedForSelector(fac));

    // -- CONDITIONAL CONFIG SECTIONS --
    if (fac.usedFor.includes('sports')) {
        detailPaneEl.appendChild(renderTypeGroup('sports', 'Sports Field Configuration', '#147D91', fac));
    }
    if (fac.usedFor.includes('special')) {
        detailPaneEl.appendChild(renderTypeGroup('special', 'Special Activities at this Facility', '#7C3AED', fac));
    }
    if (fac.usedFor.includes('general')) {
        detailPaneEl.appendChild(renderTypeGroup('general', 'General Activities', '#D97706', fac));
    }

    if (fac.usedFor.length === 0) {
        const hint = document.createElement("div");
        hint.style.cssText = "padding:24px; text-align:center; color:#9CA3AF; border:1px dashed #E5E7EB; border-radius:12px; margin-top:12px;";
        hint.textContent = "Select what this facility is used for above to see configuration options.";
        detailPaneEl.appendChild(hint);
    }
}

// =========================================================================
// USED FOR SELECTOR (Multi-select chips)
// =========================================================================
function renderUsedForSelector(fac) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "margin-bottom:20px; padding:16px; background:#F9FAFB; border-radius:12px; border:1px solid #E5E7EB;";

    const label = document.createElement("div");
    label.style.cssText = "font-weight:600; font-size:0.95rem; margin-bottom:10px; color:#374151;";
    label.textContent = "What is this facility used for?";
    wrap.appendChild(label);

    const hint = document.createElement("div");
    hint.style.cssText = "font-size:0.8rem; color:#6B7280; margin-bottom:12px;";
    hint.textContent = "Select one or more. You can choose multiple to indicate this space serves multiple purposes.";
    wrap.appendChild(hint);

    const chipRow = document.createElement("div");
    chipRow.style.cssText = "display:flex; gap:10px; flex-wrap:wrap;";

    const types = [
        { key: 'sports', label: 'Sports', color: '#147D91', desc: 'Courts, fields for sports games' },
        { key: 'special', label: 'Special Activity', color: '#7C3AED', desc: 'Hosts named special activities' },
        { key: 'general', label: 'General Activity', color: '#D97706', desc: 'Lunch, swim, snacks, etc.' }
    ];

    types.forEach(t => {
        const isActive = fac.usedFor.includes(t.key);
        const chip = document.createElement("button");
        chip.style.cssText = `
            display:flex; align-items:center; gap:8px; padding:10px 16px; border-radius:10px;
            cursor:pointer; transition:all 0.2s; font-size:0.9rem; font-weight:500;
            border:2px solid ${isActive ? t.color : '#E5E7EB'};
            background:${isActive ? t.color + '15' : 'white'};
            color:${isActive ? t.color : '#6B7280'};
        `;
        chip.textContent = t.label;
        chip.title = t.desc;

        chip.onclick = () => {
            if (isActive) {
                fac.usedFor = fac.usedFor.filter(u => u !== t.key);
            } else {
                fac.usedFor.push(t.key);
            }
            saveData();
            renderDetailPane();
        };

        chipRow.appendChild(chip);
    });

    wrap.appendChild(chipRow);
    return wrap;
}

// =========================================================================
// TYPE GROUP — Labeled section container with color accent
// =========================================================================
function renderTypeGroup(type, title, color, fac) {
    const group = document.createElement("div");
    group.className = "facility-type-group";
    group.style.cssText = `margin-bottom:20px; border-left:4px solid ${color}; border-radius:12px; background:white; border:1px solid #E5E7EB; border-left:4px solid ${color}; overflow:hidden;`;

    const header = document.createElement("div");
    header.style.cssText = `padding:14px 16px; background:${color}10; border-bottom:1px solid #E5E7EB; display:flex; align-items:center; justify-content:space-between; cursor:pointer; user-select:none;`;

    const titleEl = document.createElement("span");
    titleEl.style.cssText = `font-weight:600; font-size:0.95rem; color:${color};`;
    titleEl.textContent = title;

    const caret = document.createElement("span");
    caret.innerHTML = `<svg width="20" height="20" fill="none" stroke="${color}" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"></path></svg>`;
    caret.style.cssText = "transition:transform 0.2s; transform:rotate(0deg);";

    header.appendChild(titleEl);
    header.appendChild(caret);
    group.appendChild(header);

    const body = document.createElement("div");
    body.style.cssText = "padding:16px;";

    if (type === 'sports') {
        renderSportsConfig(body, fac);
    } else if (type === 'special') {
        renderSpecialConfig(body, fac);
    } else if (type === 'general') {
        renderGeneralConfig(body, fac);
    }

    header.onclick = () => {
        const isOpen = body.style.display !== "none";
        body.style.display = isOpen ? "none" : "block";
        caret.style.transform = isOpen ? "rotate(-90deg)" : "rotate(0deg)";
        header.style.borderBottom = isOpen ? "none" : "1px solid #E5E7EB";
    };

    group.appendChild(body);
    return group;
}

// =========================================================================
// SPORTS CONFIG — Ported from fields.js
// =========================================================================
function renderSportsConfig(container, fac) {
    // Get the field object from legacy data
    const settings = window.loadGlobalSettings?.() || {};
    const app1 = settings.app1 || {};
    let fieldData = (app1.fields || []).find(f => f.name === fac.name);

    if (!fieldData) {
        // Create it
        fieldData = {
            name: fac.name,
            activities: [],
            available: true,
            sharableWith: { type: 'not_sharable', divisions: [], capacity: 1 },
            limitUsage: { enabled: false, divisions: {}, priorityList: [], usePriority: false },
            timeRules: [],
            rainyDayAvailable: false
        };
        if (!app1.fields) app1.fields = [];
        app1.fields.push(fieldData);
        window.saveGlobalSettings?.("app1", app1);
    }

    const allSports = window.getAllGlobalSports?.() || [];

    // Availability strip
    const availability = document.createElement("div");
    availability.style.cssText = `padding:10px; border-radius:8px; margin-bottom:14px; font-size:0.85rem; display:flex; justify-content:space-between; align-items:center;
        background:${fieldData.available ? '#e6f4f7' : '#FEF2F2'}; border:1px solid ${fieldData.available ? '#b2dce6' : '#FECACA'}; color:${fieldData.available ? '#0A4A56' : '#991B1B'};`;
    availability.innerHTML = `<span>Field is <strong>${fieldData.available ? 'AVAILABLE' : 'UNAVAILABLE'}</strong></span>`;

    const availToggle = document.createElement("label");
    availToggle.className = "switch";
    availToggle.style.marginLeft = "8px";
    const availCb = document.createElement("input");
    availCb.type = "checkbox";
    availCb.checked = fieldData.available;
    availCb.onchange = () => { fieldData.available = availCb.checked; saveFieldData(); renderDetailPane(); };
    const availSlider = document.createElement("span");
    availSlider.className = "slider";
    availToggle.appendChild(availCb);
    availToggle.appendChild(availSlider);
    availability.appendChild(availToggle);
    container.appendChild(availability);

    // Accordion sections
    container.appendChild(section("Activities", summaryActivities(fieldData),
        () => renderActivities(fieldData, allSports)));

    container.appendChild(section("Access & Restrictions", summaryAccess(fieldData),
        () => renderAccess(fieldData)));

    container.appendChild(section("Sharing Rules", summarySharing(fieldData),
        () => renderSharing(fieldData)));

    container.appendChild(section("Time Rules", summaryTime(fieldData),
        () => renderTimeRules(fieldData)));

    container.appendChild(section("Weather & Availability", summaryWeather(fieldData),
        () => renderWeatherSettings(fieldData)));

    container.appendChild(section("Combined Field", summaryCombo(fieldData),
        () => renderComboSettings(fieldData)));
}

function saveFieldData() {
    const settings = window.loadGlobalSettings?.() || {};
    const app1 = settings.app1 || {};
    app1.sportMetaData = sportMetaData;
    app1.fieldCombos = fieldCombos;
    window.saveGlobalSettings?.("app1", app1);
    window.saveGlobalSettings?.("fields", app1.fields || []);
    saveFacilitiesMetadata();

    if (typeof window.refreshActivityPropertiesFromFields === 'function') {
        setTimeout(() => window.refreshActivityPropertiesFromFields(), 50);
    }
}

// =========================================================================
// SPECIAL ACTIVITY CONFIG
// =========================================================================
function renderSpecialConfig(container, fac) {
    if (!fac.specialActivityNames) fac.specialActivityNames = [];

    // Add special activity input
    const addRow = document.createElement("div");
    addRow.style.cssText = "display:flex; gap:8px; margin-bottom:16px;";

    const addInput = document.createElement("input");
    addInput.placeholder = "New special activity name (e.g., Skits, Drama)";
    addInput.style.cssText = "flex:1; padding:8px 12px; border:1px solid #D1D5DB; border-radius:8px; font-size:0.9rem; outline:none;";

    const addBtn = document.createElement("button");
    addBtn.textContent = "+ Add";
    addBtn.style.cssText = "background:#7C3AED; color:white; border:none; border-radius:8px; padding:8px 16px; cursor:pointer; font-weight:500; font-size:0.85rem;";

    const doAdd = () => {
        const name = addInput.value.trim();
        if (!name) return;
        if (fac.specialActivityNames.includes(name)) {
            alert("This activity already exists at this facility.");
            return;
        }
        fac.specialActivityNames.push(name);
        addInput.value = "";
        saveData();
        renderDetailPane();
    };

    addBtn.onclick = doAdd;
    addInput.onkeyup = e => { if (e.key === "Enter") doAdd(); };

    addRow.appendChild(addInput);
    addRow.appendChild(addBtn);
    container.appendChild(addRow);

    // List existing specials with config
    if (fac.specialActivityNames.length === 0) {
        const empty = document.createElement("div");
        empty.style.cssText = "text-align:center; padding:20px; color:#9CA3AF; font-size:0.85rem;";
        empty.textContent = "No special activities added yet. Add one above.";
        container.appendChild(empty);
        return;
    }

    const allSpecials = window.getAllSpecialActivities?.() || [];

    fac.specialActivityNames.forEach(saName => {
        let saData = allSpecials.find(s => s.name === saName);
        if (!saData) {
            saData = createDefaultSpecialActivity(saName);
            saData.location = fac.name;
        }

        const saCard = document.createElement("div");
        saCard.className = "special-sub-item";
        saCard.style.cssText = "border:1px solid #E5E7EB; border-radius:10px; margin-bottom:12px; overflow:hidden;";

        // Special activity header
        const saHeader = document.createElement("div");
        saHeader.style.cssText = "display:flex; justify-content:space-between; align-items:center; padding:12px 14px; background:#F9FAFB; border-bottom:1px solid #E5E7EB;";

        const saTitle = document.createElement("span");
        saTitle.style.cssText = "font-weight:600; font-size:0.95rem; color:#7C3AED; cursor:pointer;";
        saTitle.textContent = saName;
        saTitle.title = "Double click to rename";

        makeEditable(saTitle, newName => {
            if (!newName.trim()) return;
            const oldName = saName;
            if (oldName === newName) return;

            // Check for duplicates across all facilities
            const allSaNames = [];
            facilities.forEach(f => (f.specialActivityNames || []).forEach(n => allSaNames.push(n)));
            if (allSaNames.some(n => n.toLowerCase() === newName.toLowerCase() && n !== oldName)) {
                alert(`A special activity named "${newName}" already exists.`);
                return;
            }

            // 1. Update in this facility's specialActivityNames array
            const idx = fac.specialActivityNames.indexOf(oldName);
            if (idx !== -1) fac.specialActivityNames[idx] = newName;

            // 2. Update the global special activity object
            const allSpecials = window.getAllSpecialActivities?.() || [];
            const sa = allSpecials.find(s => s.name === oldName);
            if (sa) sa.name = newName;
            window.saveGlobalSpecialActivities?.(allSpecials);

            // 3. Update references in schedules
            const schedules = window.scheduleAssignments || {};
            for (const bunk of Object.keys(schedules)) {
                (schedules[bunk] || []).forEach(entry => {
                    if (!entry) return;
                    if (entry._activity === oldName) entry._activity = newName;
                    if (entry.field === oldName) entry.field = newName;
                    if (entry.sport === oldName) entry.sport = newName;
                });
            }

            // 4. Update references in zones
            const settings = window.loadGlobalSettings?.() || {};
            const zones = settings.locationZones || {};
            for (const zone of Object.values(zones)) {
                if (!zone || !Array.isArray(zone.specialActivities)) continue;
                const zIdx = zone.specialActivities.indexOf(oldName);
                if (zIdx !== -1) zone.specialActivities[zIdx] = newName;
            }
            if (Object.keys(zones).length > 0) {
                window.saveLocationZones?.(zones);
            }

            saveData();
            renderDetailPane();
        });

        const saDelBtn = document.createElement("button");
        saDelBtn.textContent = "Remove";
        saDelBtn.style.cssText = "color:#DC2626; background:none; border:1px solid #FECACA; padding:4px 10px; border-radius:6px; cursor:pointer; font-size:0.75rem;";
        saDelBtn.onclick = () => {
            fac.specialActivityNames = fac.specialActivityNames.filter(n => n !== saName);
            // Also remove from legacy specials
            const existing = window.getAllSpecialActivities?.() || [];
            const remaining = existing.filter(s => s.name !== saName);
            window.saveGlobalSpecialActivities?.(remaining);
            saveData();
            renderDetailPane();
        };

        saHeader.appendChild(saTitle);
        saHeader.appendChild(saDelBtn);
        saCard.appendChild(saHeader);

        // Special activity config sections
        const saBody = document.createElement("div");
        saBody.style.cssText = "padding:12px;";

        saBody.appendChild(section("Grade Access", summarySpecialAccess(saData),
            () => renderSpecialAccess(saData)));

        saBody.appendChild(section("Duration", summarySpecialDuration(saData),
            () => renderSpecialDuration(saData)));

        saBody.appendChild(section("Time Availability", summarySpecialTime(saData),
            () => renderSpecialTimeRules(saData)));

        saBody.appendChild(section("Day Availability", summarySpecialDays(saData),
            () => renderSpecialDayAvailability(saData)));

        saBody.appendChild(section("Weather & Rainy Day", summarySpecialWeather(saData),
            () => renderSpecialWeather(saData)));

        saBody.appendChild(section("Scheduling Mode", summarySpecialSchedulingMode(saData),
            () => renderSpecialSchedulingMode(saData)));

        saBody.appendChild(section("Usage & Frequency", summarySpecialUsage(saData),
            () => renderSpecialUsage(saData)));

        saBody.appendChild(section("Prep Duration", summarySpecialPrep(saData),
            () => renderSpecialPrep(saData)));

        saBody.appendChild(section("Multi-Part Activity", summarySpecialMultiPart(saData),
            () => renderSpecialMultiPart(saData)));

        saCard.appendChild(saBody);
        container.appendChild(saCard);
    });
}

// =========================================================================
// GENERAL ACTIVITY CONFIG
// =========================================================================
function renderGeneralConfig(container, fac) {
    if (!fac.generalActivities) fac.generalActivities = [];

    // Quick-push buttons
    const quickLabel = document.createElement("div");
    quickLabel.style.cssText = "font-weight:500; font-size:0.9rem; margin-bottom:10px; color:#374151;";
    quickLabel.textContent = "Quick Add:";
    container.appendChild(quickLabel);

    const quickRow = document.createElement("div");
    quickRow.style.cssText = "display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px;";

    const quickOptions = [
        { name: 'Lunch', quickType: 'lunch' },
        { name: 'Snacks', quickType: 'snacks' },
        { name: 'Dinner', quickType: 'dinner' },
        { name: 'Swim', quickType: 'swim' }
    ];

    quickOptions.forEach(opt => {
        const exists = fac.generalActivities.some(ga => ga.quickType === opt.quickType);
        const btn = document.createElement("button");
        btn.style.cssText = `padding:8px 14px; border-radius:8px; cursor:pointer; font-size:0.85rem; font-weight:500; transition:all 0.2s; display:flex; align-items:center; gap:6px;
            border:1px solid ${exists ? '#D97706' : '#E5E7EB'}; background:${exists ? '#FEF3C7' : 'white'}; color:${exists ? '#92400E' : '#6B7280'};`;
        btn.textContent = opt.name;

        btn.onclick = () => {
            if (exists) {
                fac.generalActivities = fac.generalActivities.filter(ga => ga.quickType !== opt.quickType);
            } else {
                fac.generalActivities.push({ name: opt.name, quickType: opt.quickType });
            }
            saveData();
            renderDetailPane();
        };

        quickRow.appendChild(btn);
    });

    container.appendChild(quickRow);

    // Custom input
    const customRow = document.createElement("div");
    customRow.style.cssText = "display:flex; gap:8px; margin-bottom:16px;";

    const customInput = document.createElement("input");
    customInput.placeholder = "Custom activity name...";
    customInput.style.cssText = "flex:1; padding:8px 12px; border:1px solid #D1D5DB; border-radius:8px; font-size:0.9rem; outline:none;";

    const customBtn = document.createElement("button");
    customBtn.textContent = "+ Add Custom";
    customBtn.style.cssText = "background:#D97706; color:white; border:none; border-radius:8px; padding:8px 14px; cursor:pointer; font-weight:500; font-size:0.85rem;";

    const doAddCustom = () => {
        const name = customInput.value.trim();
        if (!name) return;
        if (fac.generalActivities.some(ga => ga.name.toLowerCase() === name.toLowerCase())) {
            alert("This activity already exists at this facility.");
            return;
        }
        fac.generalActivities.push({ name: name, quickType: 'custom' });
        customInput.value = "";
        saveData();
        renderDetailPane();
    };

    customBtn.onclick = doAddCustom;
    customInput.onkeyup = e => { if (e.key === "Enter") doAddCustom(); };

    customRow.appendChild(customInput);
    customRow.appendChild(customBtn);
    container.appendChild(customRow);

    // List existing general activities
    if (fac.generalActivities.length > 0) {
        const listLabel = document.createElement("div");
        listLabel.style.cssText = "font-weight:500; font-size:0.85rem; margin-bottom:8px; color:#374151;";
        listLabel.textContent = "Configured Activities:";
        container.appendChild(listLabel);

        fac.generalActivities.forEach(ga => {
            const row = document.createElement("div");
            row.style.cssText = "display:flex; justify-content:space-between; align-items:center; padding:10px 12px; background:#FFFBEB; border:1px solid #FDE68A; border-radius:8px; margin-bottom:6px;";

            const info = document.createElement("div");
            const gaLabel = document.createElement("strong");
            gaLabel.textContent = ga.name;
            gaLabel.style.cursor = "pointer";
            gaLabel.title = "Double click to rename";
            info.appendChild(gaLabel);

            makeEditable(gaLabel, newName => {
                if (!newName.trim()) return;
                const oldName = ga.name;
                if (oldName === newName) return;
                if (fac.generalActivities.some(g => g !== ga && g.name.toLowerCase() === newName.toLowerCase())) {
                    alert(`"${newName}" already exists in this facility.`);
                    return;
                }
                // Update pinned tile defaults
                const pinned = window.getPinnedTileDefaults?.() || {};
                if (pinned[oldName] !== undefined) {
                    pinned[newName] = pinned[oldName];
                    delete pinned[oldName];
                    window.savePinnedTileDefaults?.(pinned);
                }
                ga.name = newName;
                saveData();
                renderDetailPane();
            });

            const removeBtn = document.createElement("button");
            removeBtn.textContent = "✕";
            removeBtn.style.cssText = "border:none; background:transparent; color:#9CA3AF; cursor:pointer; font-size:1rem;";
            removeBtn.onclick = () => {
                fac.generalActivities = fac.generalActivities.filter(g => g !== ga);
                saveData();
                renderDetailPane();
            };

            row.appendChild(info);
            row.appendChild(removeBtn);
            container.appendChild(row);
        });
    }

}

// =========================================================================
// SECTION BUILDER (Accordion UX) — Same pattern as fields.js
// =========================================================================
function section(title, summary, builder) {
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

// =========================================================================
// SPORTS CONFIG SECTIONS — Ported from fields.js
// =========================================================================

// -- Summaries --
function summaryActivities(f) { return f.activities?.length ? `${f.activities.length} sports selected` : "No sports selected"; }
function summarySharing(f) {
    const rules = f.sharableWith;
    if (!rules || rules.type === 'not_sharable') return "No sharing (1 bunk only)";
    return `Up to ${parseInt(rules.capacity) || 2} bunks (same grade)`;
}
function summaryAccess(f) {
    if (!f.limitUsage?.enabled) return "Open to all grades";
    const count = Object.keys(f.limitUsage.divisions || {}).length;
    if (count === 0) return "Restricted (none selected)";
    const pStr = f.limitUsage.usePriority ? " - prioritized" : "";
    return `${count} grade${count !== 1 ? 's' : ''} allowed${pStr}`;
}
function summaryTime(f) { return f.timeRules?.length ? `${f.timeRules.length} rule(s) active` : "Available all day"; }
function summaryWeather(f) { return f.rainyDayAvailable ? "Indoor (available on rain days)" : "Outdoor"; }
function summaryCombo(fieldItem) {
    const combo = getComboForField(fieldItem.name);
    if (!combo) return 'Not configured';
    const isCombined = combo.combinedField.toLowerCase().trim() === fieldItem.name.toLowerCase().trim();
    if (isCombined) return 'Made up of ' + combo.subFields.join(' + ');
    return 'Part of ' + combo.combinedField;
}

// -- Activities --
function renderActivities(item, allSports) {
    const box = document.createElement("div");
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px;";

    const globalSports = window.getAllGlobalSports?.() || [];

    allSports.forEach(s => {
        const b = document.createElement("button");
        b.textContent = s;
        b.className = "activity-button" + (item.activities.includes(s) ? " active" : "");

        b.onclick = () => {
            if (item.activities.includes(s)) item.activities = item.activities.filter(x => x !== s);
            else item.activities.push(s);
            saveFieldData();
            b.className = "activity-button" + (item.activities.includes(s) ? " active" : "");
            const summaryEl = b.closest('.detail-section')?.querySelector('.detail-section-summary');
            if (summaryEl) summaryEl.textContent = summaryActivities(item);
        };

        wrap.appendChild(b);
    });

    const add = document.createElement("input");
    add.placeholder = "Add new sport (Type & Enter)...";
    add.style.cssText = "width:100%; padding:8px; border-radius:6px; border:1px solid #D1D5DB;";

    add.onkeyup = e => {
        if (e.key === "Enter" && add.value.trim()) {
            const s = add.value.trim();
            window.addGlobalSport?.(s);
            if (!item.activities.includes(s)) item.activities.push(s);
            saveFieldData();
            const parentBody = box.parentElement;
            if (parentBody) {
                parentBody.innerHTML = '';
                parentBody.appendChild(renderActivities(item, window.getAllGlobalSports?.() || []));
            }
            const summaryEl = box.closest('.detail-section')?.querySelector('.detail-section-summary');
            if (summaryEl) summaryEl.textContent = summaryActivities(item);
        }
    };

    box.appendChild(wrap);
    box.appendChild(add);
    return box;
}

// -- Sharing --
function renderSharing(item) {
    const container = document.createElement("div");
    const updateSummary = () => {
        const summaryEl = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if (summaryEl) summaryEl.textContent = summarySharing(item);
    };

    const renderContent = () => {
        container.innerHTML = "";
        const rules = item.sharableWith || { type: 'not_sharable', divisions: [], capacity: 1 };
        const isSharable = rules.type !== 'not_sharable';

        const toggleRow = document.createElement("div");
        toggleRow.style.cssText = "display:flex; align-items:center; gap:10px; margin-bottom:16px;";

        const tog = document.createElement("label"); tog.className = "switch";
        const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = isSharable;
        cb.onchange = () => {
            if (cb.checked) { rules.type = 'same_division'; rules.capacity = rules.capacity > 1 ? rules.capacity : 2; }
            else { rules.type = 'not_sharable'; rules.capacity = 1; }
            rules.divisions = [];
            item.sharableWith = rules;
            saveFieldData(); renderContent(); updateSummary();
        };
        const sl = document.createElement("span"); sl.className = "slider";
        tog.appendChild(cb); tog.appendChild(sl);

        const label = document.createElement("span");
        label.style.cssText = "font-weight:500; font-size:0.9rem;";
        label.textContent = "Allow Sharing";

        toggleRow.appendChild(tog); toggleRow.appendChild(label);
        container.appendChild(toggleRow);

        if (!isSharable) {
            const note = document.createElement("div");
            note.style.cssText = "color:#6B7280; font-size:0.85rem; padding:10px; background:#F9FAFB; border-radius:8px;";
            note.textContent = "Only 1 bunk can use this field at a time.";
            container.appendChild(note);
        } else {
            const det = document.createElement("div");
            det.style.cssText = "margin-top:4px; padding-left:12px; border-left:2px solid #147D91;";

            const capRow = document.createElement("div");
            capRow.style.cssText = "display:flex; align-items:center; gap:8px; margin-bottom:12px;";
            capRow.innerHTML = `<span style="font-size:0.85rem;">Max bunks at once:</span>`;
            const capIn = document.createElement("input");
            capIn.type = "number"; capIn.min = "2"; capIn.max = "20"; capIn.value = rules.capacity || 2;
            capIn.style.cssText = "width:60px; padding:4px; border-radius:6px; border:1px solid #D1D5DB; text-align:center;";
            capIn.onchange = () => {
                rules.capacity = Math.min(20, Math.max(2, parseInt(capIn.value) || 2));
                capIn.value = rules.capacity;
                item.sharableWith = rules;
                saveFieldData(); updateSummary();
            };
            capRow.appendChild(capIn);
            det.appendChild(capRow);

            const note = document.createElement("div");
            note.style.cssText = "color:#6B7280; font-size:0.8rem; padding:10px; background:#f0f9fb; border-radius:8px; line-height:1.5;";
            note.innerHTML = `Up to <strong>${rules.capacity || 2}</strong> bunks <strong>within the same grade</strong> can use this simultaneously.`;
            det.appendChild(note);
            container.appendChild(det);
        }
    };
    renderContent();
    return container;
}

// -- Access & Restrictions --
function renderAccess(item) {
    const container = document.createElement("div");
    const updateSummary = () => {
        const summaryEl = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if (summaryEl) summaryEl.textContent = summaryAccess(item);
    };

    const renderContent = () => {
        container.innerHTML = "";
        const rules = item.limitUsage || { enabled: false, divisions: {}, priorityList: [], usePriority: false };
        if (!rules.priorityList) rules.priorityList = Object.keys(rules.divisions || {});
        if (rules.usePriority === undefined) rules.usePriority = false;

        const modeWrap = document.createElement("div");
        modeWrap.style.cssText = "display:flex; gap:12px; margin-bottom:16px;";

        const btnAll = document.createElement("button");
        btnAll.textContent = "Open to All Grades";
        btnAll.style.cssText = `flex:1; padding:8px; border-radius:6px; border:1px solid ${!rules.enabled ? '#147D91' : '#E5E7EB'}; cursor:pointer; background:${!rules.enabled ? '#e6f4f7' : '#fff'}; color:${!rules.enabled ? '#0F5F6E' : '#333'}; font-weight:${!rules.enabled ? '600' : '400'};`;

        const btnRes = document.createElement("button");
        btnRes.textContent = "Specific Grades Only";
        btnRes.style.cssText = `flex:1; padding:8px; border-radius:6px; border:1px solid ${rules.enabled ? '#147D91' : '#E5E7EB'}; cursor:pointer; background:${rules.enabled ? '#e6f4f7' : '#fff'}; color:${rules.enabled ? '#0F5F6E' : '#333'}; font-weight:${rules.enabled ? '600' : '400'};`;

        btnAll.onclick = () => { rules.enabled = false; item.limitUsage = rules; saveFieldData(); renderContent(); updateSummary(); };
        btnRes.onclick = () => { rules.enabled = true; item.limitUsage = rules; saveFieldData(); renderContent(); updateSummary(); };

        modeWrap.appendChild(btnAll); modeWrap.appendChild(btnRes);
        container.appendChild(modeWrap);

        const allDivs = Object.keys(window.loadGlobalSettings?.()?.divisions || {});

        if (rules.enabled) {
            const body = document.createElement("div");
            body.style.cssText = "padding-left:12px; border-left:2px solid #147D91; margin-bottom:16px;";

            const chipWrap = document.createElement("div");
            chipWrap.style.cssText = "display:flex; flex-wrap:wrap; gap:4px; margin-bottom:8px;";

            allDivs.forEach(divName => {
                const isAllowed = !!rules.divisions[divName];
                const c = document.createElement("span");
                c.className = "chip " + (isAllowed ? "active" : "inactive");
                c.textContent = divName;
                c.onclick = () => {
                    if (isAllowed) { delete rules.divisions[divName]; rules.priorityList = rules.priorityList.filter(d => d !== divName); }
                    else { rules.divisions[divName] = []; if (!rules.priorityList.includes(divName)) rules.priorityList.push(divName); }
                    item.limitUsage = rules;
                    saveFieldData(); renderContent(); updateSummary();
                };
                chipWrap.appendChild(c);
            });
            body.appendChild(chipWrap);

            if (Object.keys(rules.divisions).length === 0) {
                const warn = document.createElement("div");
                warn.style.cssText = "color:#DC2626; font-size:0.8rem; padding:8px; background:#FEF2F2; border-radius:6px;";
                warn.textContent = "No grades selected — no bunks will be able to use this field.";
                body.appendChild(warn);
            }
            container.appendChild(body);
        }

        // Priority order
        const availableGrades = rules.enabled ? Object.keys(rules.divisions) : allDivs;
        if (availableGrades.length >= 2) {
            const prioritySection = document.createElement("div");
            prioritySection.style.cssText = "border:1px solid #E5E7EB; border-radius:10px; padding:14px; background:#FAFAFA;";

            const priToggleRow = document.createElement("div");
            priToggleRow.style.cssText = "display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;";

            const priLabel = document.createElement("span");
            priLabel.style.cssText = "font-weight:600; font-size:0.9rem;";
            priLabel.textContent = "Priority Order";

            const priTog = document.createElement("label"); priTog.className = "switch";
            const priCb = document.createElement("input"); priCb.type = "checkbox"; priCb.checked = rules.usePriority === true;
            priCb.onchange = () => {
                rules.usePriority = priCb.checked;
                if (priCb.checked && rules.priorityList.length === 0) rules.priorityList = [...availableGrades];
                item.limitUsage = rules;
                saveFieldData(); renderContent(); updateSummary();
            };
            const priSl = document.createElement("span"); priSl.className = "slider";
            priTog.appendChild(priCb); priTog.appendChild(priSl);

            priToggleRow.appendChild(priLabel); priToggleRow.appendChild(priTog);
            prioritySection.appendChild(priToggleRow);

            if (rules.usePriority) {
                const validPriority = rules.priorityList.filter(d => availableGrades.includes(d));
                const missing = availableGrades.filter(d => !validPriority.includes(d));
                rules.priorityList = [...validPriority, ...missing];

                const listEl = document.createElement("div");
                listEl.style.cssText = "display:flex; flex-direction:column; gap:4px;";

                rules.priorityList.forEach((divName, idx) => {
                    const row = document.createElement("div");
                    row.style.cssText = "display:flex; align-items:center; gap:8px; padding:6px 10px; background:#fff; border:1px solid #E5E7EB; border-radius:6px;";

                    row.innerHTML = `<span style="width:20px; text-align:center; font-weight:600; color:#147D91; font-size:0.85rem;">${idx + 1}</span>
                        <span style="flex:1; font-size:0.85rem;">${escapeHtml(divName)}</span>`;

                    const btnUp = document.createElement("button");
                    btnUp.textContent = "\u2191";
                    btnUp.style.cssText = "border:1px solid #D1D5DB; background:#fff; border-radius:4px; width:24px; height:24px; cursor:pointer;";
                    btnUp.disabled = idx === 0;
                    if (idx === 0) btnUp.style.opacity = "0.3";
                    btnUp.onclick = () => {
                        [rules.priorityList[idx - 1], rules.priorityList[idx]] = [rules.priorityList[idx], rules.priorityList[idx - 1]];
                        item.limitUsage = rules; saveFieldData(); renderContent(); updateSummary();
                    };

                    const btnDown = document.createElement("button");
                    btnDown.textContent = "\u2193";
                    btnDown.style.cssText = "border:1px solid #D1D5DB; background:#fff; border-radius:4px; width:24px; height:24px; cursor:pointer;";
                    btnDown.disabled = idx === rules.priorityList.length - 1;
                    if (idx === rules.priorityList.length - 1) btnDown.style.opacity = "0.3";
                    btnDown.onclick = () => {
                        [rules.priorityList[idx], rules.priorityList[idx + 1]] = [rules.priorityList[idx + 1], rules.priorityList[idx]];
                        item.limitUsage = rules; saveFieldData(); renderContent(); updateSummary();
                    };

                    row.appendChild(btnUp); row.appendChild(btnDown);
                    listEl.appendChild(row);
                });
                prioritySection.appendChild(listEl);
            }
            container.appendChild(prioritySection);
        }
    };
    renderContent();
    return container;
}

// -- Time Rules --
function renderTimeRules(item) {
    const container = document.createElement("div");

    if (item.timeRules?.length > 0) {
        item.timeRules.forEach((r, i) => {
            const row = document.createElement("div");
            row.style.cssText = "display:flex; justify-content:space-between; align-items:center; background:#F9FAFB; padding:8px; margin-bottom:6px; border-radius:6px; border:1px solid #E5E7EB;";

            const txt = document.createElement("span");
            txt.innerHTML = `<strong style="color:${r.type === 'Available' ? '#0F6A7A' : '#DC2626'}">${escapeHtml(r.type)}</strong>: ${escapeHtml(r.start)} to ${escapeHtml(r.end)}`;

            const del = document.createElement("button");
            del.textContent = "\u2715";
            del.style.cssText = "border:none; background:transparent; color:#9CA3AF; cursor:pointer;";
            del.onclick = () => { item.timeRules.splice(i, 1); saveFieldData(); renderDetailPane(); };

            row.appendChild(txt); row.appendChild(del);
            container.appendChild(row);
        });
    } else {
        container.innerHTML = `<div class="muted" style="font-size:0.8rem; margin-bottom:10px;">No time rules. Available all day.</div>`;
    }

    // Add new
    const addSection = document.createElement("div");
    addSection.style.cssText = "margin-top:12px; padding-top:12px; border-top:1px dashed #E5E7EB;";

    const addRow = document.createElement("div");
    addRow.style.cssText = "display:flex; gap:8px; flex-wrap:wrap; align-items:center;";

    const typeSel = document.createElement("select");
    typeSel.innerHTML = `<option>Available</option><option>Unavailable</option>`;
    typeSel.style.cssText = "border-radius:6px; border:1px solid #D1D5DB; padding:4px;";

    const startIn = document.createElement("input");
    startIn.placeholder = "9:00am";
    startIn.style.cssText = "width:70px; padding:4px; border-radius:6px; border:1px solid #D1D5DB;";

    const endIn = document.createElement("input");
    endIn.placeholder = "10:00am";
    endIn.style.cssText = "width:70px; padding:4px; border-radius:6px; border:1px solid #D1D5DB;";

    const btn = document.createElement("button");
    btn.textContent = "Add";
    btn.style.cssText = "background:#111; color:white; border:none; border-radius:6px; padding:4px 12px; cursor:pointer;";
    btn.onclick = () => {
        if (!startIn.value || !endIn.value) { alert("Enter both start and end times."); return; }
        const startMinP = parseTimeToMinutes(startIn.value);
        const endMinP = parseTimeToMinutes(endIn.value);
        if (startMinP === null || endMinP === null) { alert("Invalid time format. Use e.g. 9:00am"); return; }
        item.timeRules.push({ type: typeSel.value, start: startIn.value, end: endIn.value, startMin: startMinP, endMin: endMinP });
        saveFieldData(); renderDetailPane();
    };

    addRow.appendChild(typeSel);
    addRow.appendChild(startIn);
    addRow.appendChild(document.createTextNode(" to "));
    addRow.appendChild(endIn);
    addRow.appendChild(btn);
    addSection.appendChild(addRow);
    container.appendChild(addSection);
    return container;
}

// -- Weather --
function renderWeatherSettings(item) {
    const container = document.createElement("div");
    const isIndoor = item.rainyDayAvailable === true;

    container.innerHTML = `
        <div style="margin-bottom:16px;">
            <p style="font-size:0.85rem; color:#6b7280; margin:0 0 12px 0;">
                Indoor/covered facilities stay available during Rainy Day Mode.
            </p>
            <div style="display:flex; align-items:center; gap:12px; padding:14px; background:${isIndoor ? '#e6f4f7' : '#fef3c7'}; border:1px solid ${isIndoor ? '#b2dce6' : '#fcd34d'}; border-radius:10px;">
                <div style="flex:1;">
                    <div style="font-weight:600; color:${isIndoor ? '#0a4a56' : '#92400e'};">${isIndoor ? 'Indoor / Covered' : 'Outdoor'}</div>
                    <div style="font-size:0.85rem; color:${isIndoor ? '#0F5F6E' : '#b45309'};">${isIndoor ? 'Available on rainy days' : 'Disabled during rainy days'}</div>
                </div>
                <label class="switch"><input type="checkbox" id="fac-rainy-toggle" ${isIndoor ? 'checked' : ''}><span class="slider"></span></label>
            </div>
        </div>`;

    container.querySelector('#fac-rainy-toggle').onchange = function () {
        item.rainyDayAvailable = this.checked;
        saveFieldData();
        const parentContainer = container.parentElement;
        parentContainer.innerHTML = '';
        parentContainer.appendChild(renderWeatherSettings(item));
        const summaryEl = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if (summaryEl) summaryEl.textContent = summaryWeather(item);
    };

    return container;
}

// -- Combined Fields --
function renderComboSettings(fieldItem) {
    const container = document.createElement('div');
    if (!fieldItem?.name) return container;
    const thisName = fieldItem.name;

    const settings = window.loadGlobalSettings?.() || {};
    const allFields = settings.app1?.fields || [];
    const allOtherFields = allFields.filter(f => f.name !== thisName);

    const updateSummary = () => {
        const s = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if (s) s.textContent = summaryCombo(fieldItem);
    };

    const renderContent = () => {
        container.innerHTML = '';
        const currentCombo = getComboForField(thisName);

        const info = document.createElement('div');
        info.style.cssText = 'color:#6B7280; font-size:0.85rem; line-height:1.5; margin-bottom:16px; padding:10px; background:#F9FAFB; border-radius:8px;';
        info.innerHTML = 'Define which smaller fields make up this larger field. Example: <strong>Gym A + Gym B = Main Gym</strong>.';
        container.appendChild(info);

        if (currentCombo) {
            const isCombined = currentCombo.combinedField.toLowerCase().trim() === thisName.toLowerCase().trim();

            const box = document.createElement('div');
            box.style.cssText = 'background:#e6f4f7; border:1px solid #b2dce6; border-radius:10px; padding:16px; margin-bottom:12px;';
            box.innerHTML = `<div style="font-size:1rem; font-weight:600; color:#0A4A56; text-align:center;">${currentCombo.subFields.join(' + ')}  =  ${currentCombo.combinedField}</div>
                <div style="font-size:0.82rem; color:#0F5F6E; text-align:center; margin-top:6px;">${isCombined ? 'This is the combined (full) field' : 'This field is part of "' + currentCombo.combinedField + '"'}</div>`;
            container.appendChild(box);

            const removeBtn = document.createElement('button');
            removeBtn.textContent = 'Remove relationship';
            removeBtn.style.cssText = 'background:#FEF2F2; color:#DC2626; border:1px solid #FECACA; border-radius:6px; padding:6px 14px; cursor:pointer; font-size:0.85rem;';
            removeBtn.onclick = () => {
                if (confirm('Remove the combined field relationship?')) {
                    delete fieldCombos[currentCombo.id];
                    rebuildComboLookups();
                    saveFieldData();
                    renderMasterList();
                    renderContent();
                    updateSummary();
                }
            };
            container.appendChild(removeBtn);
        } else {
            const availableFields = allOtherFields.filter(f => !getComboForField(f.name));
            if (availableFields.length === 0) {
                container.innerHTML += '<div style="color:#9CA3AF; font-size:0.85rem; padding:10px;">No other fields available.</div>';
                return;
            }

            const lbl = document.createElement('div');
            lbl.style.cssText = 'font-weight:500; font-size:0.9rem; margin-bottom:10px;';
            lbl.textContent = 'Select fields that make up "' + thisName + '":';
            container.appendChild(lbl);

            let selectedPartners = new Set();
            const chipWrap = document.createElement('div');
            chipWrap.style.cssText = 'display:flex; flex-wrap:wrap; gap:6px; margin-bottom:14px;';

            availableFields.forEach(f => {
                const chip = document.createElement('button');
                chip.textContent = f.name;
                chip.style.cssText = 'padding:6px 12px; border-radius:6px; border:1px solid #D1D5DB; background:#fff; cursor:pointer; font-size:0.85rem;';
                chip.onclick = () => {
                    if (selectedPartners.has(f.name)) {
                        selectedPartners.delete(f.name);
                        chip.style.background = '#fff'; chip.style.borderColor = '#D1D5DB';
                    } else {
                        selectedPartners.add(f.name);
                        chip.style.background = '#e6f4f7'; chip.style.borderColor = '#147D91';
                    }
                    saveBtn.style.display = selectedPartners.size > 0 ? '' : 'none';
                };
                chipWrap.appendChild(chip);
            });
            container.appendChild(chipWrap);

            const saveBtn = document.createElement('button');
            saveBtn.textContent = 'Save Relationship';
            saveBtn.style.cssText = 'background:#147D91; color:white; border:none; border-radius:8px; padding:10px 18px; cursor:pointer; font-size:0.9rem; font-weight:500; display:none;';
            saveBtn.onclick = () => {
                const subs = [...selectedPartners];
                if (subs.length === 0) return;
                const id = 'combo_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 5);
                fieldCombos[id] = { id, combinedField: thisName, subFields: subs };
                rebuildComboLookups();
                saveFieldData();
                renderMasterList();
                renderContent();
                updateSummary();
            };
            container.appendChild(saveBtn);
        }
    };
    renderContent();
    return container;
}

// =========================================================================
// SPECIAL ACTIVITY CONFIG SECTIONS
// =========================================================================

// -- Summaries --
function summarySpecialAccess(s) {
    if (!s.limitUsage?.enabled) return "Open to all grades";
    const count = Object.keys(s.limitUsage.divisions || {}).length;
    return count === 0 ? "Restricted (none selected)" : `${count} grade${count !== 1 ? 's' : ''} allowed`;
}
function summarySpecialTime(s) { return s.timeRules?.length ? `${s.timeRules.length} rule(s)` : "Available all day"; }
function summarySpecialDays(s) {
    if (!s.availableDays || s.availableDays.length === 0 || s.availableDays.length === 7) return "Every day";
    return s.availableDays.join(', ');
}
function summarySpecialWeather(s) {
    if (s.rainyDayExclusive || s.rainyDayOnly) return "Rainy day only";
    return s.isIndoor ? "Indoor (Rain OK)" : "Outdoor";
}
function summarySpecialSharing(s) {
    const rules = s.sharableWith;
    if (!rules || rules.type === 'not_sharable') return "No sharing (1 bunk)";
    return `Up to ${parseInt(rules.capacity) || 2} bunks`;
}
function summarySpecialSchedulingMode(s) {
    if (s.fullGrade) return "Full Grade — entire grade together";
    const rules = s.sharableWith;
    if (!rules || rules.type === 'not_sharable') return "Individual bunks — 1 at a time";
    return `Individual bunks — up to ${parseInt(rules.capacity) || 2} at once`;
}
function summarySpecialUsage(s) {
    if (!s.maxUsage) return "No limit";
    return `Max ${s.maxUsage} per ${s.maxUsagePeriod || 'half'}`;
}
function summarySpecialDuration(s) {
    const d = parseInt(s.duration) || 0;
    if (d <= 0) return "Uses block size";
    const prep = parseInt(s.prepDuration) || 0;
    if (prep > 0) return `${d} min (+${prep} prep = ${d + prep} total)`;
    return `${d} minutes`;
}
function summarySpecialPrep(s) { return s.prepDuration ? `${s.prepDuration} min` : "None"; }
function summarySpecialMultiPart(s) {
    if (!s.multiPart?.enabled) return "Single session";
    return `${s.multiPart.totalParts} parts, ${s.multiPart.daysBetween} days apart`;
}

function saveSpecialData(saData) {
    const allSpecials = window.getAllSpecialActivities?.() || [];
    const idx = allSpecials.findIndex(s => s.name === saData.name);
    if (idx >= 0) allSpecials[idx] = saData;
    else allSpecials.push(saData);

    // ★ FIX (reload persistence): Special activities live in TWO localStorage
    //   keys — root `specialActivities` AND nested `app1.specialActivities`.
    //   cloud_sync_helpers.js's saveGlobalSpecialActivities writes both, but
    //   app1.js loads later and overrides that function with a version that
    //   ONLY writes app1.specialActivities. Every reader checks the root key
    //   first (special_activities.js:289/1686, cloud_sync_helpers.js:124,
    //   facilities.js:109), so on reload the stale root snapshot wins and any
    //   setting just saved (duration etc.) appears to vanish. Write both keys
    //   directly here to guarantee both are in sync.
    const settings = window.loadGlobalSettings?.() || {};
    if (!settings.app1) settings.app1 = {};
    settings.app1.specialActivities = allSpecials;
    window.saveGlobalSettings?.('app1', settings.app1);
    window.saveGlobalSettings?.('specialActivities', allSpecials);

    // ★ FIX (in-memory cache): saveGlobalSettings writes localStorage but
    //   does NOT update special_activities.js's in-memory cache.
    //   getAllSpecialActivities only re-reads from storage when both
    //   in-memory arrays are empty (special_activities.js:1683), so
    //   freshly-added activities never enter the cache. Without this sync,
    //   switching to another activity re-renders from stale memory.
    if (window.specialActivities !== undefined) {
        window.specialActivities = allSpecials.filter(s => !s.rainyDayExclusive && !s.rainyDayOnly);
    }
    if (typeof window.refreshSpecialActivitiesFromStorage === 'function') {
        window.refreshSpecialActivitiesFromStorage();
    }

    saveFacilitiesMetadata();
}

// -- Grade Access --
function renderSpecialAccess(saData) {
    const container = document.createElement("div");
    const updateSummary = () => {
        const el = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if (el) el.textContent = summarySpecialAccess(saData);
    };
    const renderContent = () => {
        container.innerHTML = "";
        const rules = saData.limitUsage || { enabled: false, divisions: {}, priorityList: [] };

        const modeWrap = document.createElement("div");
        modeWrap.style.cssText = "display:flex; gap:12px; margin-bottom:16px;";

        const btnAll = document.createElement("button");
        btnAll.textContent = "Open to All";
        btnAll.style.cssText = `flex:1; padding:8px; border-radius:6px; border:1px solid ${!rules.enabled ? '#147D91' : '#E5E7EB'}; cursor:pointer; background:${!rules.enabled ? '#e6f4f7' : '#fff'}; font-weight:${!rules.enabled ? '600' : '400'};`;

        const btnRes = document.createElement("button");
        btnRes.textContent = "Specific Grades";
        btnRes.style.cssText = `flex:1; padding:8px; border-radius:6px; border:1px solid ${rules.enabled ? '#147D91' : '#E5E7EB'}; cursor:pointer; background:${rules.enabled ? '#e6f4f7' : '#fff'}; font-weight:${rules.enabled ? '600' : '400'};`;

        btnAll.onclick = () => { rules.enabled = false; saData.limitUsage = rules; saveSpecialData(saData); renderContent(); updateSummary(); };
        btnRes.onclick = () => { rules.enabled = true; saData.limitUsage = rules; saveSpecialData(saData); renderContent(); updateSummary(); };

        modeWrap.appendChild(btnAll); modeWrap.appendChild(btnRes);
        container.appendChild(modeWrap);

        if (rules.enabled) {
            const allDivs = Object.keys(window.loadGlobalSettings?.()?.divisions || {});
            const chipWrap = document.createElement("div");
            chipWrap.style.cssText = "display:flex; flex-wrap:wrap; gap:4px;";

            allDivs.forEach(divName => {
                const isAllowed = !!rules.divisions[divName];
                const c = document.createElement("span");
                c.className = "chip " + (isAllowed ? "active" : "inactive");
                c.textContent = divName;
                c.onclick = () => {
                    if (isAllowed) delete rules.divisions[divName];
                    else rules.divisions[divName] = [];
                    saData.limitUsage = rules;
                    saveSpecialData(saData); renderContent(); updateSummary();
                };
                chipWrap.appendChild(c);
            });
            container.appendChild(chipWrap);
        }
    };
    renderContent();
    return container;
}

// -- Time Rules --
function renderSpecialTimeRules(saData) {
    const container = document.createElement("div");

    if (saData.timeRules?.length > 0) {
        saData.timeRules.forEach((r, i) => {
            const row = document.createElement("div");
            row.style.cssText = "display:flex; justify-content:space-between; align-items:center; background:#F9FAFB; padding:8px; margin-bottom:6px; border-radius:6px; border:1px solid #E5E7EB;";
            row.innerHTML = `<span><strong style="color:${r.type === 'Available' ? '#0F6A7A' : '#DC2626'}">${escapeHtml(r.type)}</strong>: ${escapeHtml(r.start)} to ${escapeHtml(r.end)}</span>`;

            const del = document.createElement("button");
            del.textContent = "\u2715";
            del.style.cssText = "border:none; background:transparent; color:#9CA3AF; cursor:pointer;";
            del.onclick = () => { saData.timeRules.splice(i, 1); saveSpecialData(saData); renderDetailPane(); };

            row.appendChild(del);
            container.appendChild(row);
        });
    } else {
        container.innerHTML = `<div style="font-size:0.8rem; color:#9CA3AF; margin-bottom:10px;">Available all day.</div>`;
    }

    const addRow = document.createElement("div");
    addRow.style.cssText = "display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:12px; padding-top:12px; border-top:1px dashed #E5E7EB;";

    const typeSel = document.createElement("select");
    typeSel.innerHTML = `<option>Available</option><option>Unavailable</option>`;
    typeSel.style.cssText = "border-radius:6px; border:1px solid #D1D5DB; padding:4px;";

    const startIn = document.createElement("input");
    startIn.placeholder = "9:00am";
    startIn.style.cssText = "width:70px; padding:4px; border-radius:6px; border:1px solid #D1D5DB;";

    const endIn = document.createElement("input");
    endIn.placeholder = "10:00am";
    endIn.style.cssText = "width:70px; padding:4px; border-radius:6px; border:1px solid #D1D5DB;";

    const btn = document.createElement("button");
    btn.textContent = "Add";
    btn.style.cssText = "background:#111; color:white; border:none; border-radius:6px; padding:4px 12px; cursor:pointer;";
    btn.onclick = () => {
        if (!startIn.value || !endIn.value) return;
        const startMinP = parseTimeToMinutes(startIn.value);
        const endMinP = parseTimeToMinutes(endIn.value);
        if (startMinP === null || endMinP === null) { alert("Invalid time format."); return; }
        if (!saData.timeRules) saData.timeRules = [];
        saData.timeRules.push({ type: typeSel.value, start: startIn.value, end: endIn.value, startMin: startMinP, endMin: endMinP });
        saveSpecialData(saData); renderDetailPane();
    };

    addRow.appendChild(typeSel); addRow.appendChild(startIn);
    addRow.appendChild(document.createTextNode(" to "));
    addRow.appendChild(endIn); addRow.appendChild(btn);
    container.appendChild(addRow);
    return container;
}

// -- Day Availability --
function renderSpecialDayAvailability(saData) {
    const container = document.createElement("div");
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    if (!saData.availableDays) saData.availableDays = [...days];

    const chipWrap = document.createElement("div");
    chipWrap.style.cssText = "display:flex; flex-wrap:wrap; gap:6px;";

    days.forEach(day => {
        const isActive = saData.availableDays.includes(day);
        const c = document.createElement("span");
        c.className = "chip " + (isActive ? "active" : "inactive");
        c.textContent = day;
        c.onclick = () => {
            if (isActive) saData.availableDays = saData.availableDays.filter(d => d !== day);
            else saData.availableDays.push(day);
            saveSpecialData(saData);
            c.className = "chip " + (saData.availableDays.includes(day) ? "active" : "inactive");
            const el = container.closest('.detail-section')?.querySelector('.detail-section-summary');
            if (el) el.textContent = summarySpecialDays(saData);
        };
        chipWrap.appendChild(c);
    });

    container.appendChild(chipWrap);
    return container;
}

// -- Weather --
function renderSpecialWeather(saData) {
    const container = document.createElement("div");
    const isIndoor = saData.isIndoor !== false;

    container.innerHTML = `
        <div style="display:flex; align-items:center; gap:12px; padding:14px; background:${isIndoor ? '#e6f4f7' : '#fef3c7'}; border:1px solid ${isIndoor ? '#b2dce6' : '#fcd34d'}; border-radius:10px;">
            <div style="flex:1;">
                <div style="font-weight:600; color:${isIndoor ? '#0a4a56' : '#92400e'};">${isIndoor ? 'Indoor' : 'Outdoor'}</div>
                <div style="font-size:0.85rem; color:${isIndoor ? '#0F5F6E' : '#b45309'};">${isIndoor ? 'Available on rainy days' : 'Unavailable on rainy days'}</div>
            </div>
            <label class="switch"><input type="checkbox" id="fac-sa-indoor-toggle" ${isIndoor ? 'checked' : ''}><span class="slider"></span></label>
        </div>`;

    container.querySelector('#fac-sa-indoor-toggle').onchange = function () {
        saData.isIndoor = this.checked;
        saData.rainyDayAvailable = this.checked;
        saveSpecialData(saData);
        const parentContainer = container.parentElement;
        parentContainer.innerHTML = '';
        parentContainer.appendChild(renderSpecialWeather(saData));
        const el = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if (el) el.textContent = summarySpecialWeather(saData);
    };

    return container;
}

// -- Sharing --
function renderSpecialSharing(saData) {
    const container = document.createElement("div");
    const updateSummary = () => {
        const el = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if (el) el.textContent = summarySpecialSharing(saData);
    };

    const renderContent = () => {
        container.innerHTML = "";
        const rules = saData.sharableWith || { type: 'not_sharable', divisions: [], capacity: 2 };
        const isSharable = rules.type !== 'not_sharable';

        const toggleRow = document.createElement("div");
        toggleRow.style.cssText = "display:flex; align-items:center; gap:10px; margin-bottom:12px;";

        const tog = document.createElement("label"); tog.className = "switch";
        const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = isSharable;
        cb.onchange = () => {
            if (cb.checked) { rules.type = 'same_division'; rules.capacity = Math.max(2, rules.capacity || 2); }
            else { rules.type = 'not_sharable'; rules.capacity = 1; }
            saData.sharableWith = rules;
            saveSpecialData(saData); renderContent(); updateSummary();
        };
        const sl = document.createElement("span"); sl.className = "slider";
        tog.appendChild(cb); tog.appendChild(sl);

        toggleRow.appendChild(tog);
        toggleRow.innerHTML += '<span style="font-weight:500; font-size:0.9rem;">Allow Sharing</span>';
        container.appendChild(toggleRow);

        if (isSharable) {
            const capRow = document.createElement("div");
            capRow.style.cssText = "display:flex; align-items:center; gap:8px; padding-left:12px; border-left:2px solid #7C3AED;";
            capRow.innerHTML = '<span style="font-size:0.85rem;">Max bunks:</span>';
            const capIn = document.createElement("input");
            capIn.type = "number"; capIn.min = "2"; capIn.max = "20"; capIn.value = rules.capacity || 2;
            capIn.style.cssText = "width:60px; padding:4px; border-radius:6px; border:1px solid #D1D5DB; text-align:center;";
            capIn.onchange = () => {
                rules.capacity = Math.min(20, Math.max(2, parseInt(capIn.value) || 2));
                saData.sharableWith = rules;
                saveSpecialData(saData); updateSummary();
            };
            capRow.appendChild(capIn);
            container.appendChild(capRow);
        }
    };
    renderContent();
    return container;
}

// -- Scheduling Mode (Full Grade vs Individual + Sharing) --
function renderSpecialSchedulingMode(saData) {
    const container = document.createElement("div");
    const updateSummary = () => {
        const el = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if (el) el.textContent = summarySpecialSchedulingMode(saData);
    };

    const renderContent = () => {
        container.innerHTML = "";

        // Top-level toggle: Full Grade vs Individual Bunks
        const modeWrap = document.createElement("div");
        modeWrap.style.cssText = "display:flex; gap:0; margin-bottom:16px; border-radius:10px; overflow:hidden; border:1px solid #E5E7EB;";

        const btnFull = document.createElement("button");
        btnFull.innerHTML = '<strong>Full Grade</strong><span style="display:block;font-size:0.75rem;font-weight:400;margin-top:2px;opacity:0.8;">Entire grade together</span>';
        btnFull.style.cssText = 'flex:1; padding:12px 8px; border:none; cursor:pointer; text-align:center; font-size:0.85rem; transition:all 0.15s; line-height:1.3; '
            + (saData.fullGrade
                ? 'background:#0F5F6E; color:white;'
                : 'background:#fff; color:#6B7280;');

        const btnIndiv = document.createElement("button");
        btnIndiv.innerHTML = '<strong>Individual Bunks</strong><span style="display:block;font-size:0.75rem;font-weight:400;margin-top:2px;opacity:0.8;">Assigned per bunk</span>';
        btnIndiv.style.cssText = 'flex:1; padding:12px 8px; border:none; cursor:pointer; text-align:center; font-size:0.85rem; transition:all 0.15s; line-height:1.3; border-left:1px solid #E5E7EB; '
            + (!saData.fullGrade
                ? 'background:#0F5F6E; color:white;'
                : 'background:#fff; color:#6B7280;');

        btnFull.onclick = () => { saData.fullGrade = true; saveSpecialData(saData); renderContent(); updateSummary(); };
        btnIndiv.onclick = () => { saData.fullGrade = false; saveSpecialData(saData); renderContent(); updateSummary(); };

        modeWrap.appendChild(btnFull);
        modeWrap.appendChild(btnIndiv);
        container.appendChild(modeWrap);

        if (saData.fullGrade) {
            const infoBox = document.createElement("div");
            infoBox.style.cssText = "padding:14px; background:linear-gradient(135deg, #f0f9fb, #e6f4f7); border:1px solid #b2dce6; border-radius:8px; line-height:1.6;";
            infoBox.innerHTML =
                '<div style="font-weight:600; color:#0A4A56; margin-bottom:6px; font-size:0.9rem;">How it works</div>' +
                '<div style="color:#0F5F6E; font-size:0.84rem;">' +
                    'When the scheduler assigns this activity, <strong>every bunk in the grade</strong> will do it in the same time slot. ' +
                    'No sharing rules are needed — the entire grade participates together.' +
                '</div>';
            container.appendChild(infoBox);
            return;
        }

        // Individual bunks — show sharing controls
        const rules = saData.sharableWith || { type: 'not_sharable', divisions: [], capacity: 2 };
        const isSharable = rules.type !== 'not_sharable';

        const sharingLabel = document.createElement("div");
        sharingLabel.style.cssText = "font-size:0.85rem; font-weight:500; color:#374151; margin-bottom:10px;";
        sharingLabel.textContent = "Can multiple bunks do this at the same time?";
        container.appendChild(sharingLabel);

        const toggleRow = document.createElement("div");
        toggleRow.style.cssText = "display:flex; gap:0; margin-bottom:16px; border-radius:8px; overflow:hidden; border:1px solid #E5E7EB;";

        const btnNo = document.createElement("button");
        btnNo.textContent = "No — 1 bunk only";
        btnNo.style.cssText = 'flex:1; padding:10px 8px; border:none; cursor:pointer; font-size:0.84rem; transition:all 0.15s; '
            + (!isSharable ? 'background:#0F5F6E; color:white; font-weight:600;' : 'background:#fff; color:#6B7280;');

        const btnYes = document.createElement("button");
        btnYes.textContent = "Yes — multiple bunks";
        btnYes.style.cssText = 'flex:1; padding:10px 8px; border:none; cursor:pointer; font-size:0.84rem; transition:all 0.15s; border-left:1px solid #E5E7EB; '
            + (isSharable ? 'background:#0F5F6E; color:white; font-weight:600;' : 'background:#fff; color:#6B7280;');

        btnNo.onclick = () => {
            rules.type = 'not_sharable'; rules.capacity = 1; rules.divisions = [];
            saData.sharableWith = rules; saveSpecialData(saData); renderContent(); updateSummary();
        };
        btnYes.onclick = () => {
            rules.type = 'same_division'; rules.capacity = Math.max(2, rules.capacity || 2);
            saData.sharableWith = rules; saveSpecialData(saData); renderContent(); updateSummary();
        };

        toggleRow.appendChild(btnNo);
        toggleRow.appendChild(btnYes);
        container.appendChild(toggleRow);

        if (isSharable) {
            const capBox = document.createElement("div");
            capBox.style.cssText = "padding:14px; background:#F9FAFB; border:1px solid #E5E7EB; border-radius:8px;";

            const capLabel = document.createElement("div");
            capLabel.style.cssText = "font-size:0.84rem; font-weight:500; color:#374151; margin-bottom:10px;";
            capLabel.textContent = "How many bunks can do this at the same time?";
            capBox.appendChild(capLabel);

            const capRow = document.createElement("div");
            capRow.style.cssText = "display:flex; align-items:center; gap:12px; margin-bottom:10px;";

            const capIn = document.createElement("input");
            capIn.type = "number"; capIn.min = "2"; capIn.max = "20"; capIn.value = rules.capacity || 2;
            capIn.style.cssText = "width:64px; padding:8px; border-radius:6px; border:1px solid #D1D5DB; text-align:center; font-size:1rem; font-weight:600;";

            const capNote = document.createElement("div");
            capNote.style.cssText = "color:#6B7280; font-size:0.8rem; line-height:1.5;";
            capNote.innerHTML = 'Up to <strong>' + (rules.capacity || 2) + '</strong> bunks from the <strong>same grade</strong> can be scheduled here at the same time. Bunks from different grades cannot share.';

            capIn.onchange = () => {
                rules.capacity = Math.min(20, Math.max(2, parseInt(capIn.value) || 2));
                capIn.value = rules.capacity;
                saData.sharableWith = rules;
                saveSpecialData(saData); updateSummary();
                capNote.innerHTML = 'Up to <strong>' + rules.capacity + '</strong> bunks from the <strong>same grade</strong> can be scheduled here at the same time. Bunks from different grades cannot share.';
            };

            const capSuffix = document.createElement("span");
            capSuffix.style.cssText = "font-size:0.85rem; color:#6B7280;";
            capSuffix.textContent = "bunks at once";

            capRow.appendChild(capIn);
            capRow.appendChild(capSuffix);
            capBox.appendChild(capRow);
            capBox.appendChild(capNote);
            container.appendChild(capBox);
        } else {
            const noteBox = document.createElement("div");
            noteBox.style.cssText = "color:#6B7280; font-size:0.8rem; padding:12px; background:#F9FAFB; border-radius:8px; border:1px solid #E5E7EB; line-height:1.5;";
            noteBox.textContent = "Only 1 bunk can be assigned to this activity at a time. Other bunks will be scheduled for something else.";
            container.appendChild(noteBox);
        }
    };

    renderContent();
    return container;
}

// -- Usage & Frequency --
function renderSpecialUsage(saData) {
    const container = document.createElement("div");
    const updateSummary = () => {
        const el = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if (el) el.textContent = summarySpecialUsage(saData);
    };

    container.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">
            <span style="font-size:0.85rem;">Max usage per</span>
            <select id="fac-sa-usage-period" style="border-radius:6px; border:1px solid #D1D5DB; padding:4px;">
                <option value="half" ${saData.maxUsagePeriod === 'half' ? 'selected' : ''}>Half Summer</option>
                <option value="week" ${saData.maxUsagePeriod === 'week' ? 'selected' : ''}>Week</option>
            </select>
            <span style="font-size:0.85rem;">:</span>
            <input type="number" id="fac-sa-max-usage" min="0" placeholder="No limit" value="${saData.maxUsage || ''}"
                style="width:70px; padding:4px; border-radius:6px; border:1px solid #D1D5DB; text-align:center;">
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:0.85rem;">Min frequency (weeks between):</span>
            <input type="number" id="fac-sa-freq" min="0" value="${saData.frequencyWeeks || 0}"
                style="width:60px; padding:4px; border-radius:6px; border:1px solid #D1D5DB; text-align:center;">
        </div>`;

    const bindInputs = () => {
        const maxInput = container.querySelector('#fac-sa-max-usage');
        const periodSel = container.querySelector('#fac-sa-usage-period');
        const freqInput = container.querySelector('#fac-sa-freq');

        if (maxInput) maxInput.onchange = () => {
            const v = maxInput.value.trim();
            saData.maxUsage = v ? parseInt(v) || null : null;
            saveSpecialData(saData); updateSummary();
        };
        if (periodSel) periodSel.onchange = () => {
            saData.maxUsagePeriod = periodSel.value;
            saveSpecialData(saData); updateSummary();
        };
        if (freqInput) freqInput.onchange = () => {
            saData.frequencyWeeks = parseInt(freqInput.value) || 0;
            saveSpecialData(saData);
        };
    };
    setTimeout(bindInputs, 0);

    return container;
}

// -- Prep Duration --
function renderSpecialDuration(saData) {
    const container = document.createElement("div");
    const updateSummary = () => {
        const el = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if (el) el.textContent = summarySpecialDuration(saData);
    };

    const renderContent = () => {
        const hasDur = (parseInt(saData.duration) || 0) > 0;
        const cur = parseInt(saData.duration) || 30;
        container.innerHTML = `
            <p style="font-size:0.85rem; color:#6B7280; margin:0 0 10px 0;">
                Set a fixed duration for this activity. The auto-scheduler will use this instead of the layer's default block size.
            </p>
            <div style="display:flex; align-items:center; gap:10px; margin-bottom:${hasDur ? '10px' : '0'};">
                <span style="font-size:0.85rem; color:#374151; flex:1;">
                    ${hasDur ? `<strong>${cur} minutes</strong>` : 'Not set — uses skeleton block size'}
                </span>
                <label class="switch">
                    <input type="checkbox" id="fac-sa-dur-toggle" ${hasDur ? 'checked' : ''}>
                    <span class="slider"></span>
                </label>
            </div>
            <div id="fac-sa-dur-config" style="display:${hasDur ? 'flex' : 'none'}; align-items:center; gap:8px;">
                <span style="font-size:0.85rem;">Duration:</span>
                <input type="number" id="fac-sa-dur-input" min="5" max="180" step="5" value="${cur}"
                    style="width:70px; padding:4px; border-radius:6px; border:1px solid #D1D5DB; text-align:center;">
                <span style="font-size:0.8rem; color:#6B7280;">minutes</span>
            </div>`;

        const tog = container.querySelector('#fac-sa-dur-toggle');
        if (tog) tog.onchange = () => {
            saData.duration = tog.checked ? (parseInt(saData.duration) > 0 ? parseInt(saData.duration) : 30) : null;
            saveSpecialData(saData); updateSummary(); renderContent();
        };
        const input = container.querySelector('#fac-sa-dur-input');
        if (input) input.onchange = () => {
            const v = Math.max(5, Math.min(180, parseInt(input.value) || 30));
            saData.duration = v;
            saveSpecialData(saData); updateSummary();
        };
    };

    renderContent();
    return container;
}

function renderSpecialPrep(saData) {
    const container = document.createElement("div");
    const updateSummary = () => {
        const el = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if (el) el.textContent = summarySpecialPrep(saData);
    };

    container.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:0.85rem;">Setup time before activity:</span>
            <input type="number" id="fac-sa-prep" min="0" max="60" value="${saData.prepDuration || 0}"
                style="width:60px; padding:4px; border-radius:6px; border:1px solid #D1D5DB; text-align:center;">
            <span style="font-size:0.8rem; color:#6B7280;">minutes</span>
        </div>`;

    setTimeout(() => {
        const input = container.querySelector('#fac-sa-prep');
        if (input) input.onchange = () => {
            saData.prepDuration = Math.max(0, Math.min(60, parseInt(input.value) || 0));
            saveSpecialData(saData); updateSummary();
        };
    }, 0);

    return container;
}

// -- Multi-Part --
function renderSpecialMultiPart(saData) {
    const container = document.createElement("div");
    if (!saData.multiPart) saData.multiPart = { enabled: false, totalParts: 2, daysBetween: 3 };

    const updateSummary = () => {
        const el = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if (el) el.textContent = summarySpecialMultiPart(saData);
    };

    const renderContent = () => {
        container.innerHTML = "";

        const toggleRow = document.createElement("div");
        toggleRow.style.cssText = "display:flex; align-items:center; gap:10px; margin-bottom:12px;";

        const tog = document.createElement("label"); tog.className = "switch";
        const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = saData.multiPart.enabled;
        cb.onchange = () => {
            saData.multiPart.enabled = cb.checked;
            saveSpecialData(saData); renderContent(); updateSummary();
        };
        const sl = document.createElement("span"); sl.className = "slider";
        tog.appendChild(cb); tog.appendChild(sl);

        toggleRow.appendChild(tog);
        toggleRow.innerHTML += '<span style="font-weight:500; font-size:0.9rem;">Enable Multi-Part</span>';
        container.appendChild(toggleRow);

        if (saData.multiPart.enabled) {
            const config = document.createElement("div");
            config.style.cssText = "padding-left:12px; border-left:2px solid #7C3AED;";
            config.innerHTML = `
                <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
                    <span style="font-size:0.85rem;">Total parts:</span>
                    <input type="number" id="fac-mp-parts" min="2" max="10" value="${saData.multiPart.totalParts}"
                        style="width:60px; padding:4px; border-radius:6px; border:1px solid #D1D5DB; text-align:center;">
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                    <span style="font-size:0.85rem;">Days between parts:</span>
                    <input type="number" id="fac-mp-days" min="1" max="30" value="${saData.multiPart.daysBetween}"
                        style="width:60px; padding:4px; border-radius:6px; border:1px solid #D1D5DB; text-align:center;">
                </div>`;
            container.appendChild(config);

            setTimeout(() => {
                const partsIn = container.querySelector('#fac-mp-parts');
                const daysIn = container.querySelector('#fac-mp-days');
                if (partsIn) partsIn.onchange = () => {
                    saData.multiPart.totalParts = Math.max(2, Math.min(10, parseInt(partsIn.value) || 2));
                    saveSpecialData(saData); updateSummary();
                };
                if (daysIn) daysIn.onchange = () => {
                    saData.multiPart.daysBetween = Math.max(1, Math.min(30, parseInt(daysIn.value) || 3));
                    saveSpecialData(saData); updateSummary();
                };
            }, 0);
        }
    };
    renderContent();
    return container;
}


// =========================================================================
// COMBINED FIELD HELPERS
// =========================================================================
function rebuildComboLookups() {
    _comboLookup = { combinedToSubs: {}, subToCombined: {}, allComboFields: new Set() };
    for (const combo of Object.values(fieldCombos)) {
        if (!combo.combinedField || !Array.isArray(combo.subFields)) continue;
        const cNorm = combo.combinedField.toLowerCase().trim();
        _comboLookup.combinedToSubs[cNorm] = combo.subFields.map(s => s);
        _comboLookup.allComboFields.add(cNorm);
        for (const sub of combo.subFields) {
            const sNorm = sub.toLowerCase().trim();
            _comboLookup.subToCombined[sNorm] = combo.combinedField;
            _comboLookup.allComboFields.add(sNorm);
        }
    }
}

function getComboForField(fieldName) {
    if (!fieldName) return null;
    const norm = fieldName.toLowerCase().trim();
    for (const combo of Object.values(fieldCombos)) {
        if (combo.combinedField.toLowerCase().trim() === norm) return combo;
        if (combo.subFields.some(s => s.toLowerCase().trim() === norm)) return combo;
    }
    return null;
}

// =========================================================================
// FIELD CLEANUP HELPERS (delegated to fields.js via window exports)
// =========================================================================
function cleanupDeletedField(fieldName) {
    if (!fieldName) return;
    console.log(`[FACILITIES] Cleaning up deleted field: "${fieldName}"`);
    try {
        const settings = window.loadGlobalSettings?.() || {};
        const dailySchedules = settings.daily_schedules || {};
        let cleanupCount = 0;

        Object.keys(dailySchedules).forEach(dateKey => {
            const dayData = dailySchedules[dateKey];
            if (!dayData?.scheduleAssignments) return;
            Object.keys(dayData.scheduleAssignments).forEach(bunkKey => {
                const slots = dayData.scheduleAssignments[bunkKey];
                if (!Array.isArray(slots)) return;
                slots.forEach((slot, idx) => {
                    if (slot?.location === fieldName || slot?.field === fieldName) {
                        dayData.scheduleAssignments[bunkKey][idx] = { ...slot, location: null, field: null };
                        cleanupCount++;
                    }
                });
            });
        });

        if (cleanupCount > 0) window.saveGlobalSettings?.('daily_schedules', dailySchedules);
        if (window.activityProperties?.[fieldName]) delete window.activityProperties[fieldName];
    } catch (e) {
        console.error('[FACILITIES] Cleanup error:', e);
    }
}

function propagateFieldRename(oldName, newName) {
    if (!oldName || !newName || oldName === newName) return;
    try {
        const settings = window.loadGlobalSettings?.() || {};
        const dailySchedules = settings.daily_schedules || {};

        Object.keys(dailySchedules).forEach(dateKey => {
            const dayData = dailySchedules[dateKey];
            if (!dayData?.scheduleAssignments) return;
            Object.keys(dayData.scheduleAssignments).forEach(bunkKey => {
                const slots = dayData.scheduleAssignments[bunkKey];
                if (!Array.isArray(slots)) return;
                slots.forEach((slot) => {
                    if (slot?.location === oldName) slot.location = newName;
                    if (slot?.field === oldName) slot.field = newName;
                });
            });
        });
        window.saveGlobalSettings?.('daily_schedules', dailySchedules);

        const locationZones = settings.locationZones || {};
        Object.values(locationZones).forEach(zone => {
            if (zone.fields) {
                const idx = zone.fields.indexOf(oldName);
                if (idx !== -1) zone.fields[idx] = newName;
            }
            if (zone.locations?.[oldName]) {
                zone.locations[newName] = zone.locations[oldName];
                delete zone.locations[oldName];
            }
        });
        window.saveGlobalSettings?.('locationZones', locationZones);
    } catch (e) {
        console.error('[FACILITIES] Rename propagation error:', e);
    }
}

function handleComboFieldRenamed(oldName, newName) {
    if (!oldName || !newName) return;
    const oldNorm = oldName.toLowerCase().trim();
    let changed = false;
    for (const combo of Object.values(fieldCombos)) {
        if (combo.combinedField.toLowerCase().trim() === oldNorm) { combo.combinedField = newName; changed = true; }
        combo.subFields = combo.subFields.map(s => {
            if (s.toLowerCase().trim() === oldNorm) { changed = true; return newName; }
            return s;
        });
    }
    if (changed) rebuildComboLookups();
}

function handleComboFieldDeleted(fieldName) {
    if (!fieldName) return;
    const norm = fieldName.toLowerCase().trim();
    for (const [id, combo] of Object.entries(fieldCombos)) {
        if (combo.combinedField.toLowerCase().trim() === norm) { delete fieldCombos[id]; break; }
        const idx = combo.subFields.findIndex(s => s.toLowerCase().trim() === norm);
        if (idx !== -1) {
            combo.subFields.splice(idx, 1);
            if (combo.subFields.length === 0) delete fieldCombos[id];
            break;
        }
    }
    rebuildComboLookups();
}

// =========================================================================
// UTILITY HELPERS
// =========================================================================
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
        inp.style.cssText = "font-size:inherit; font-weight:inherit; border:1px solid #147D91; outline:none; border-radius:4px; padding:2px 6px;";
        inp.style.width = Math.max(100, el.offsetWidth + 20) + "px";
        el.replaceWith(inp);
        inp.focus();
        inp.select();
        const finish = () => {
            const newVal = inp.value.trim();
            if (newVal && newVal !== el.textContent) save(newVal);
            else if (inp.parentNode) inp.replaceWith(el);
        };
        inp.onblur = finish;
        inp.onkeyup = e => {
            if (e.key === "Enter") finish();
            if (e.key === "Escape") inp.replaceWith(el);
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

// =========================================================================
// EXPORTS
// =========================================================================
window.initFacilitiesTab = initFacilitiesTab;
window.getFacilities = function () {
    const settings = window.loadGlobalSettings?.() || {};
    return settings.facilities || [];
};
window.getFacilityByName = function (name) {
    const facs = window.getFacilities();
    return facs.find(f => f.name === name) || null;
};

})();
