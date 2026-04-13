// ============================================================================
// zones.js — ZONE MANAGEMENT v1.0
// ============================================================================
// Simplified zone management tab. Users assign facilities to zones
// (Campus / Off Campus) and set travel times.
//
// Reads facilities from window.getFacilities() and writes to
// locationZones via window.saveLocationZones() for backward compatibility.
// ============================================================================
(function(){
'use strict';

console.log("[ZONES] Zones module v1.0 loading...");

// =========================================================================
// STATE
// =========================================================================
let locationZones = {};
let pinnedTileDefaults = {};
let selectedZoneId = null;
let zonesListEl = null;
let detailPaneEl = null;
let addZoneInput = null;

// =========================================================================
// INIT
// =========================================================================
function initZonesTab() {
    const container = document.getElementById("zones");
    if (!container) return;

    loadData();
    container.innerHTML = "";

    const contentWrapper = document.createElement('div');
    contentWrapper.innerHTML = `
        <div class="setup-grid">
          <section class="setup-card setup-card-wide" style="border:none; box-shadow:none; background:transparent;">
            <div class="setup-card-header" style="margin-bottom:20px;">
              <span class="setup-step-pill">Zones</span>
              <div class="setup-card-text">
                <h3>Manage Zones</h3>
                <p>Assign your facilities to zones and set travel times for off-campus locations.</p>
              </div>
            </div>

            <div style="display:flex; flex-wrap:wrap; gap:24px;">
              <!-- LEFT: ZONE LIST -->
              <div style="flex:1; min-width:280px;">
                <div class="setup-subtitle" style="margin-bottom:8px;">All Zones</div>

                <div style="background:white; padding:10px; border-radius:12px; border:1px solid #E5E7EB; margin-bottom:12px; display:flex; gap:8px;">
                  <input id="new-zone-input" placeholder="New Zone (e.g., Off Campus)" style="flex:1; border:none; outline:none; font-size:0.9rem;">
                  <button id="add-zone-btn" style="background:#111; color:white; border:none; border-radius:6px; padding:6px 12px; font-size:0.8rem; cursor:pointer;">Add</button>
                </div>

                <div id="zones-master-list" style="max-height:600px; overflow-y:auto;"></div>
              </div>

              <!-- RIGHT: ZONE DETAIL -->
              <div style="flex:1.4; min-width:340px; position:sticky; top:0; align-self:flex-start;">
                <div class="setup-subtitle">Zone Configuration</div>
                <div id="zones-detail-pane" style="margin-top:8px; max-height:calc(100vh - 120px); overflow-y:auto; padding-right:4px;"></div>
              </div>
            </div>
          </section>
        </div>`;

    container.appendChild(contentWrapper);

    zonesListEl = document.getElementById("zones-master-list");
    detailPaneEl = document.getElementById("zones-detail-pane");
    addZoneInput = document.getElementById("new-zone-input");

    document.getElementById("add-zone-btn").onclick = addZone;
    addZoneInput.onkeyup = e => { if (e.key === "Enter") addZone(); };

    // Ensure at least a default zone
    if (Object.keys(locationZones).length === 0) {
        locationZones["Main Campus"] = createDefaultZone("Main Campus", true);
        saveData();
    }

    renderZonesList();
    renderDetailPane();
}

// =========================================================================
// DATA
// =========================================================================
function loadData() {
    const settings = window.loadGlobalSettings?.() || {};
    locationZones = settings.locationZones || {};
    pinnedTileDefaults = settings.pinnedTileDefaults || {};

    // Validate zones
    Object.keys(locationZones).forEach(name => {
        locationZones[name] = validateZone(locationZones[name], name);
    });
}

function saveData() {
    window.saveLocationZones?.(locationZones);
    window.savePinnedTileDefaults?.(pinnedTileDefaults);

    if (typeof window.requestCloudSync === 'function') {
        window.requestCloudSync();
    }
}

function createDefaultZone(name, isDefault) {
    return {
        name: name,
        isDefault: isDefault || false,
        isOffCampus: false,
        travelTimeMin: 0,
        transition: { preMin: 0, postMin: 0 },
        maxConcurrent: 99,
        fields: [],
        specialActivities: [],
        locations: {}
    };
}

function validateZone(zone, zoneName) {
    if (!zone || typeof zone !== 'object') return createDefaultZone(zoneName, false);

    // Validate fields exist
    let validFieldNames = null;
    try {
        const allFields = window.getFields?.() || [];
        validFieldNames = new Set(allFields.map(f => f.name));
    } catch (e) { validFieldNames = null; }

    let validatedFields = Array.isArray(zone.fields) ? zone.fields.filter(f => typeof f === 'string') : [];
    if (validFieldNames && validFieldNames.size > 0) {
        validatedFields = validatedFields.filter(f => validFieldNames.has(f));
    }

    let validSpecialNames = null;
    try {
        const allSpecials = window.getAllSpecialActivities?.() || [];
        validSpecialNames = new Set(allSpecials.map(s => s.name));
    } catch (e) { validSpecialNames = null; }

    let validatedSpecials = Array.isArray(zone.specialActivities) ? zone.specialActivities.filter(s => typeof s === 'string') : [];
    if (validSpecialNames && validSpecialNames.size > 0) {
        validatedSpecials = validatedSpecials.filter(s => validSpecialNames.has(s));
    }

    return {
        name: zone.name || zoneName,
        isDefault: zone.isDefault === true,
        isOffCampus: zone.isOffCampus === true,
        travelTimeMin: parseInt(zone.travelTimeMin) || 0,
        transition: {
            preMin: parseInt(zone.transition?.preMin) || 0,
            postMin: parseInt(zone.transition?.postMin) || 0
        },
        maxConcurrent: parseInt(zone.maxConcurrent) || 99,
        fields: validatedFields,
        specialActivities: validatedSpecials,
        locations: (zone.locations && typeof zone.locations === 'object') ? zone.locations : {}
    };
}

// =========================================================================
// ADD / DELETE ZONE
// =========================================================================
function addZone() {
    if (!window.AccessControl?.checkSetupAccess?.('add zones')) return;

    const n = addZoneInput.value.trim();
    if (!n) return;

    if (locationZones[n]) {
        alert("A zone with that name already exists.");
        return;
    }

    locationZones[n] = createDefaultZone(n, false);
    addZoneInput.value = "";
    saveData();
    selectedZoneId = n;
    renderZonesList();
    renderDetailPane();
}

function deleteZone(zoneName) {
    if (!window.AccessControl?.canEraseData?.()) {
        window.AccessControl?.showPermissionDenied?.('delete zones');
        return;
    }

    const zone = locationZones[zoneName];
    if (zone?.isDefault) {
        alert("Cannot delete the default zone.");
        return;
    }

    if (!confirm(`Delete zone "${zoneName}"?\n\nFacilities in this zone will become unassigned.`)) return;

    delete locationZones[zoneName];
    selectedZoneId = null;
    saveData();
    renderZonesList();
    renderDetailPane();
}

// =========================================================================
// ZONE LIST (Left Pane)
// =========================================================================
function renderZonesList() {
    zonesListEl.innerHTML = "";

    const zoneNames = Object.keys(locationZones);
    if (zoneNames.length === 0) {
        zonesListEl.innerHTML = `<div style="padding:20px; text-align:center; color:#9CA3AF;">No zones created yet.</div>`;
        return;
    }

    // Sort: default first, then alphabetical
    zoneNames.sort((a, b) => {
        if (locationZones[a].isDefault && !locationZones[b].isDefault) return -1;
        if (!locationZones[a].isDefault && locationZones[b].isDefault) return 1;
        return a.localeCompare(b);
    });

    zoneNames.forEach(name => {
        const zone = locationZones[name];
        const isSelected = name === selectedZoneId;
        const el = document.createElement("div");
        el.style.cssText = `
            padding:12px 16px; margin:4px 0; border-radius:12px; cursor:pointer;
            transition:all 0.15s ease;
            background:${isSelected ? 'rgba(20,125,145,0.08)' : '#F9FAFB'};
            border:1px solid ${isSelected ? '#147D91' : '#E5E7EB'};
            ${isSelected ? 'box-shadow:0 0 0 1px rgba(20,125,145,0.3), 0 4px 12px rgba(20,125,145,0.1);' : ''}
        `;
        el.onmouseenter = () => { if (!isSelected) { el.style.background = '#F3F4F6'; el.style.borderColor = 'rgba(20,125,145,0.4)'; } };
        el.onmouseleave = () => { if (!isSelected) { el.style.background = '#F9FAFB'; el.style.borderColor = '#E5E7EB'; } };
        el.onclick = () => { selectedZoneId = name; renderZonesList(); renderDetailPane(); };

        const topRow = document.createElement("div");
        topRow.style.cssText = "display:flex; align-items:center; justify-content:space-between;";

        const nameEl = document.createElement("div");
        nameEl.style.cssText = "font-weight:500; font-size:0.9rem; color:#1F2937;";
        nameEl.textContent = name;
        topRow.appendChild(nameEl);

        const badgeWrap = document.createElement('div');
        badgeWrap.style.cssText = 'display:flex; gap:3px;';
        if (zone.isDefault) {
            const badge = document.createElement('span');
            badge.style.cssText = 'font-size:0.6rem; color:white; background:#147D91; border-radius:3px; padding:2px 6px; font-weight:600; line-height:1;';
            badge.textContent = 'DEFAULT';
            badgeWrap.appendChild(badge);
        }
        if (zone.isOffCampus) {
            const badge = document.createElement('span');
            badge.style.cssText = 'font-size:0.6rem; color:white; background:#D97706; border-radius:3px; padding:2px 6px; font-weight:600; line-height:1;';
            badge.textContent = 'OFF CAMPUS';
            badgeWrap.appendChild(badge);
        }
        topRow.appendChild(badgeWrap);
        el.appendChild(topRow);

        // Facility count
        const count = (zone.fields?.length || 0) + (zone.specialActivities?.length || 0) + Object.keys(zone.locations || {}).length;
        const countEl = document.createElement("div");
        countEl.style.cssText = "font-size:0.75rem; color:#9CA3AF; margin-top:2px;";
        countEl.textContent = `${count} facilit${count === 1 ? 'y' : 'ies'}`;
        el.appendChild(countEl);

        zonesListEl.appendChild(el);
    });
}

// =========================================================================
// DETAIL PANE (Right Pane)
// =========================================================================
function renderDetailPane() {
    if (!selectedZoneId || !locationZones[selectedZoneId]) {
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
    header.style.cssText = "display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;";

    const title = document.createElement("h2");
    title.textContent = zone.name;
    title.style.cssText = "margin:0; font-size:1.25rem;";

    if (!zone.isDefault) {
        title.title = "Double click to rename";
        makeEditable(title, newName => {
            if (!newName.trim() || newName === zone.name) return;
            if (locationZones[newName]) { alert("Zone name already exists."); return; }
            const oldName = zone.name;
            zone.name = newName;
            locationZones[newName] = zone;
            delete locationZones[oldName];
            if (selectedZoneId === oldName) selectedZoneId = newName;
            saveData();
            renderZonesList();
            renderDetailPane();
        });
    }

    header.appendChild(title);

    if (!zone.isDefault) {
        const delBtn = document.createElement("button");
        delBtn.innerHTML = `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg> Delete`;
        delBtn.style.cssText = "color:#DC2626; background:#FEF2F2; border:1px solid #FECACA; padding:6px 12px; border-radius:6px; cursor:pointer; display:flex; gap:6px; align-items:center;";
        delBtn.onclick = () => deleteZone(selectedZoneId);
        header.appendChild(delBtn);
    }

    detailPaneEl.appendChild(header);

    // -- DEFAULT / OFF-CAMPUS INDICATOR --
    if (zone.isDefault) {
        const defStrip = document.createElement("div");
        defStrip.style.cssText = "padding:10px; border-radius:8px; margin-bottom:16px; background:#e6f4f7; border:1px solid #b2dce6; color:#0A4A56; font-size:0.85rem;";
        defStrip.innerHTML = `<strong>Default Zone</strong> \u2014 Facilities not assigned to any zone belong here.`;
        detailPaneEl.appendChild(defStrip);
    }

    // -- OFF-CAMPUS TOGGLE --
    const offCampusSection = document.createElement("div");
    offCampusSection.style.cssText = "margin-bottom:20px; padding:16px; background:#F9FAFB; border-radius:12px; border:1px solid #E5E7EB;";

    const ocToggleRow = document.createElement("div");
    ocToggleRow.style.cssText = "display:flex; align-items:center; gap:10px; margin-bottom:12px;";

    const ocTog = document.createElement("label"); ocTog.className = "switch";
    const ocCb = document.createElement("input"); ocCb.type = "checkbox"; ocCb.checked = zone.isOffCampus;
    ocCb.onchange = () => {
        zone.isOffCampus = ocCb.checked;
        saveData();
        renderDetailPane();
        renderZonesList();
    };
    const ocSl = document.createElement("span"); ocSl.className = "slider";
    ocTog.appendChild(ocCb); ocTog.appendChild(ocSl);

    const ocLabel = document.createElement("span");
    ocLabel.style.cssText = "font-weight:600; font-size:0.95rem;";
    ocLabel.textContent = "Off Campus";

    ocToggleRow.appendChild(ocTog);
    ocToggleRow.appendChild(ocLabel);
    offCampusSection.appendChild(ocToggleRow);

    // Travel time (only for off-campus)
    if (zone.isOffCampus) {
        const travelRow = document.createElement("div");
        travelRow.style.cssText = "display:flex; align-items:center; gap:8px; padding:12px; background:#FFFBEB; border:1px solid #FDE68A; border-radius:8px;";
        travelRow.innerHTML = `<span style="font-size:0.9rem; font-weight:500;">Travel time:</span>`;

        const travelInput = document.createElement("input");
        travelInput.type = "number";
        travelInput.min = "0";
        travelInput.max = "120";
        travelInput.value = zone.travelTimeMin || 0;
        travelInput.style.cssText = "width:60px; padding:6px; border:1px solid #FCD34D; border-radius:6px; text-align:center;";
        travelInput.onchange = () => {
            zone.travelTimeMin = Math.max(0, Math.min(120, parseInt(travelInput.value) || 0));
            travelInput.value = zone.travelTimeMin;
            saveData();
        };

        travelRow.appendChild(travelInput);
        travelRow.innerHTML += `<span style="font-size:0.8rem; color:#92400E;">minutes each way</span>`;
        offCampusSection.appendChild(travelRow);
    }

    detailPaneEl.appendChild(offCampusSection);

    // -- ACCORDION SECTIONS --
    const transTime = zone.transition.preMin || zone.transition.postMin || 0;
    detailPaneEl.appendChild(section("Transition Time",
        transTime ? `${transTime} min` : "None",
        () => renderTransitionSection(zone)));

    detailPaneEl.appendChild(section("Assign Facilities",
        countFacilitiesInZone(zone),
        () => renderFacilityAssignment(zone)));

    detailPaneEl.appendChild(section("Max Concurrent Activities",
        zone.maxConcurrent === 99 ? "Unlimited" : `${zone.maxConcurrent} at a time`,
        () => renderMaxConcurrent(zone)));
}

function countFacilitiesInZone(zone) {
    const total = (zone.fields?.length || 0) + (zone.specialActivities?.length || 0) + Object.keys(zone.locations || {}).length;
    return total === 0 ? "None assigned" : `${total} facilit${total === 1 ? 'y' : 'ies'} assigned`;
}

// =========================================================================
// TRANSITION TIMES SECTION
// =========================================================================
function renderTransitionSection(zone) {
    const container = document.createElement("div");
    const currentVal = zone.transition.preMin || zone.transition.postMin || 0;

    container.innerHTML = `
        <p style="font-size:0.82rem; color:#6B7280; margin:0 0 12px 0;">
            Buffer time for activities in this zone (applied before and after each activity).
        </p>
        <div style="display:flex; align-items:center; gap:8px;">
            <label style="font-size:0.85rem; font-weight:500;">Transition time:</label>
            <input type="number" id="zone-transition-min" min="0" max="30" value="${currentVal}"
                style="width:60px; padding:6px; border:1px solid #D1D5DB; border-radius:6px; text-align:center;">
            <span style="font-size:0.8rem; color:#6B7280;">minutes</span>
        </div>`;

    setTimeout(() => {
        const input = container.querySelector('#zone-transition-min');
        if (input) input.onchange = () => {
            const val = Math.max(0, Math.min(30, parseInt(input.value) || 0));
            zone.transition.preMin = val;
            zone.transition.postMin = val;
            saveData();
            const el = container.closest('.detail-section')?.querySelector('.detail-section-summary');
            if (el) el.textContent = val ? `${val} min` : "None";
        };
    }, 0);

    return container;
}

// =========================================================================
// FACILITY ASSIGNMENT
// =========================================================================
function renderFacilityAssignment(zone) {
    const container = document.createElement("div");

    // Get all facilities
    const allFacilities = window.getFacilities?.() || [];

    if (allFacilities.length === 0) {
        container.innerHTML = `<div style="text-align:center; padding:20px; color:#9CA3AF; font-size:0.85rem;">
            No facilities created yet. Create facilities in the Facilities tab first.
        </div>`;
        return container;
    }

    container.innerHTML = `<p style="font-size:0.82rem; color:#6B7280; margin:0 0 12px 0;">
        Click facilities to assign or unassign them from this zone.
    </p>`;

    // Build a set of all facilities already in OTHER zones
    const inOtherZones = new Set();
    Object.entries(locationZones).forEach(([zName, z]) => {
        if (zName === selectedZoneId) return;
        (z.fields || []).forEach(f => inOtherZones.add(f));
        (z.specialActivities || []).forEach(s => inOtherZones.add(s));
        Object.keys(z.locations || {}).forEach(l => inOtherZones.add(l));
    });

    // Current zone's assigned facility names
    const assignedNames = new Set([
        ...(zone.fields || []),
        ...(zone.specialActivities || []),
        ...Object.keys(zone.locations || {})
    ]);

    const chipWrap = document.createElement("div");
    chipWrap.style.cssText = "display:flex; flex-wrap:wrap; gap:8px; margin-bottom:16px;";

    allFacilities.forEach(fac => {
        const isAssigned = assignedNames.has(fac.name);
        const inOther = inOtherZones.has(fac.name);

        const chip = document.createElement("button");
        const colors = { sports: '#147D91', special: '#7C3AED', general: '#D97706' };
        const primaryColor = colors[fac.usedFor[0]] || '#6B7280';

        chip.style.cssText = `padding:8px 14px; border-radius:8px; cursor:${inOther ? 'not-allowed' : 'pointer'}; font-size:0.85rem; font-weight:500; transition:all 0.2s;
            border:2px solid ${isAssigned ? primaryColor : (inOther ? '#E5E7EB' : '#E5E7EB')};
            background:${isAssigned ? primaryColor + '15' : (inOther ? '#F3F4F6' : 'white')};
            color:${isAssigned ? primaryColor : (inOther ? '#9CA3AF' : '#374151')};
            opacity:${inOther ? '0.6' : '1'};`;

        let labelText = escapeHtml(fac.name);
        if (fac.usedFor.length > 0) {
            const typeLabels = { sports: 'S', special: 'SA', general: 'G' };
            const badges = fac.usedFor.map(t => typeLabels[t] || t).join(',');
            labelText += ` <span style="font-size:0.7rem; opacity:0.7;">[${badges}]</span>`;
        }
        chip.innerHTML = labelText;

        if (inOther) {
            // Find which zone it's in
            let otherZoneName = '';
            Object.entries(locationZones).forEach(([zName, z]) => {
                if (zName === selectedZoneId) return;
                if ((z.fields || []).includes(fac.name) || (z.specialActivities || []).includes(fac.name) || z.locations?.[fac.name]) {
                    otherZoneName = zName;
                }
            });
            chip.title = `Already in "${otherZoneName}"`;
        } else {
            chip.onclick = () => {
                if (isAssigned) {
                    removeFacilityFromZone(zone, fac);
                } else {
                    addFacilityToZone(zone, fac);
                }
                saveData();
                // Re-render
                const parentBody = container.parentElement;
                if (parentBody) {
                    parentBody.innerHTML = '';
                    parentBody.appendChild(renderFacilityAssignment(zone));
                    parentBody.dataset.built = "1";
                }
                const el = container.closest('.detail-section')?.querySelector('.detail-section-summary');
                if (el) el.textContent = countFacilitiesInZone(zone);
                renderZonesList();
            };
        }

        chipWrap.appendChild(chip);
    });

    container.appendChild(chipWrap);

    return container;
}

function addFacilityToZone(zone, fac) {
    // Add based on facility's usedFor types
    if (fac.usedFor.includes('sports')) {
        if (!zone.fields) zone.fields = [];
        if (!zone.fields.includes(fac.name)) zone.fields.push(fac.name);
    }

    if (fac.usedFor.includes('special')) {
        if (!zone.specialActivities) zone.specialActivities = [];
        (fac.specialActivityNames || []).forEach(saName => {
            if (!zone.specialActivities.includes(saName)) zone.specialActivities.push(saName);
        });
    }

    if (fac.usedFor.includes('general')) {
        if (!zone.locations) zone.locations = {};
        zone.locations[fac.name] = zone.locations[fac.name] || {};
    }

    // If facility has no specific type, add as location
    if (fac.usedFor.length === 0) {
        if (!zone.locations) zone.locations = {};
        zone.locations[fac.name] = zone.locations[fac.name] || {};
    }
}

function removeFacilityFromZone(zone, fac) {
    if (zone.fields) zone.fields = zone.fields.filter(f => f !== fac.name);
    if (zone.specialActivities) {
        const saNames = new Set(fac.specialActivityNames || []);
        zone.specialActivities = zone.specialActivities.filter(s => !saNames.has(s));
    }
    if (zone.locations?.[fac.name]) delete zone.locations[fac.name];
}

// =========================================================================
// MAX CONCURRENT
// =========================================================================
function renderMaxConcurrent(zone) {
    const container = document.createElement("div");
    container.innerHTML = `
        <p style="font-size:0.82rem; color:#6B7280; margin:0 0 12px 0;">
            Maximum number of activities that can run simultaneously in this zone.
        </p>
        <div style="display:flex; align-items:center; gap:8px;">
            <input type="number" id="zone-max-concurrent" min="1" max="99" value="${zone.maxConcurrent}"
                style="width:70px; padding:6px; border:1px solid #D1D5DB; border-radius:6px; text-align:center;">
            <span style="font-size:0.8rem; color:#6B7280;">activities (99 = unlimited)</span>
        </div>`;

    setTimeout(() => {
        const input = container.querySelector('#zone-max-concurrent');
        if (input) input.onchange = () => {
            zone.maxConcurrent = Math.max(1, Math.min(99, parseInt(input.value) || 99));
            saveData();
            const el = container.closest('.detail-section')?.querySelector('.detail-section-summary');
            if (el) el.textContent = zone.maxConcurrent === 99 ? "Unlimited" : `${zone.maxConcurrent} at a time`;
        };
    }, 0);

    return container;
}

// =========================================================================
// SECTION BUILDER
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
// HELPERS
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

// =========================================================================
// EXPORTS
// =========================================================================
window.initZonesTab = initZonesTab;

})();
