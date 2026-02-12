// ============================================================================
// special_activities.js — PRODUCTION-READY v3.1
// ============================================================================
// v3.1: Teal theme unification, prep duration, field loading fix
// v3.0: Grade restrictions, same-division sharing
// v2.5: Field/Location assignment
// v2.4: CRITICAL FIX - Always set type:'Special' for scheduler filtering
// v2.3: Indoor/Outdoor availability section (matches fields.js pattern)
// v2.2: Comprehensive debug logging for rainy day activity tracking
// v2.1: Enhanced rainy day filtering with multiple flag support
// v2.0: Cloud sync, tab refresh, data validation, RBAC
// ============================================================================
(function() {
'use strict';

console.log("[SPECIAL_ACTIVITIES] Module v3.1 loading...");

// =========================================================================
// STATE
// =========================================================================
let specialActivities = [];
let rainyDayActivities = [];
let selectedItemId = null;
let specialsListEl = null;
let rainyDayListEl = null;
let detailPaneEl = null;
let addSpecialInput = null;
let addRainyDayInput = null;
let _isInitialized = false;
let _refreshTimeout = null;
let activeEventListeners = [];
let _cloudSyncCallback = null;

// =========================================================================
// EVENT LISTENER CLEANUP
// =========================================================================
function cleanupEventListeners() {
    activeEventListeners.forEach(({ type, handler, options, target }) => {
        const eventTarget = target || window;
        try { eventTarget.removeEventListener(type, handler, options); } catch (e) {}
    });
    activeEventListeners = [];
    if (_cloudSyncCallback && window.SupabaseSync?.removeStatusCallback) {
        window.SupabaseSync.removeStatusCallback(_cloudSyncCallback);
        _cloudSyncCallback = null;
    }
    if (_refreshTimeout) { clearTimeout(_refreshTimeout); _refreshTimeout = null; }
}

// =========================================================================
// TAB VISIBILITY
// =========================================================================
let _visibilityHandler = null;
let _focusHandler = null;

function setupTabListeners() {
    cleanupTabListeners();
    _visibilityHandler = () => {
        if (document.visibilityState === 'visible' && _isInitialized) {
            if (_refreshTimeout) clearTimeout(_refreshTimeout);
            _refreshTimeout = setTimeout(() => {
                console.log("[SPECIAL_ACTIVITIES] Tab visible - refreshing data...");
                refreshFromStorage();
            }, 300);
        }
    };
    document.addEventListener('visibilitychange', _visibilityHandler);
    activeEventListeners.push({ type: 'visibilitychange', handler: _visibilityHandler, target: document });

    _focusHandler = () => {
        if (_isInitialized) {
            if (_refreshTimeout) clearTimeout(_refreshTimeout);
            _refreshTimeout = setTimeout(() => {
                console.log("[SPECIAL_ACTIVITIES] Window focused - refreshing data...");
                refreshFromStorage();
            }, 300);
        }
    };
    window.addEventListener('focus', _focusHandler);
    activeEventListeners.push({ type: 'focus', handler: _focusHandler, target: window });
}

function cleanupTabListeners() {
    if (_visibilityHandler) { document.removeEventListener('visibilitychange', _visibilityHandler); _visibilityHandler = null; }
    if (_focusHandler) { window.removeEventListener('focus', _focusHandler); _focusHandler = null; }
    if (_refreshTimeout) { clearTimeout(_refreshTimeout); _refreshTimeout = null; }
}

// =========================================================================
// CLOUD SYNC LISTENER
// =========================================================================
function setupCloudSyncListener() {
    if (_cloudSyncCallback && window.SupabaseSync?.removeStatusCallback) {
        window.SupabaseSync.removeStatusCallback(_cloudSyncCallback);
    }
    if (window.SupabaseSync?.onStatusChange) {
        _cloudSyncCallback = (status) => {
            if (status === 'idle' && _isInitialized) {
                console.log("[SPECIAL_ACTIVITIES] Cloud sync complete - refreshing...");
                refreshFromStorage();
            }
        };
        window.SupabaseSync.onStatusChange(_cloudSyncCallback);
    }
    const handleRemoteChange = (event) => {
        if (_isInitialized && event.detail?.key === 'specialActivities') {
            console.log("[SPECIAL_ACTIVITIES] Remote specialActivities change detected");
            refreshFromStorage();
        }
    };
    window.addEventListener('campistry-remote-change', handleRemoteChange);
    activeEventListeners.push({ type: 'campistry-remote-change', handler: handleRemoteChange, target: window });
}

// =========================================================================
// BEFOREUNLOAD
// =========================================================================
let _beforeUnloadHandler = null;
function setupBeforeUnloadHandler() {
    if (_beforeUnloadHandler) window.removeEventListener('beforeunload', _beforeUnloadHandler);
    _beforeUnloadHandler = () => {
        if (window._specialActivitiesSyncTimeout) {
            clearTimeout(window._specialActivitiesSyncTimeout);
            window._specialActivitiesSyncTimeout = null;
            window.forceSyncToCloud?.();
        }
    };
    window.addEventListener('beforeunload', _beforeUnloadHandler);
    activeEventListeners.push({ type: 'beforeunload', handler: _beforeUnloadHandler, target: window });
}

// =========================================================================
// DATA VALIDATION
// =========================================================================
function validateSpecialActivity(activity, activityName) {
    if (!activity || typeof activity !== 'object') {
        return createDefaultActivity(activityName || 'Unknown');
    }

    let validDivisions = null;
    try {
        const settings = window.loadGlobalSettings?.() || {};
        const divisions = settings.divisions || {};
        validDivisions = new Set(Object.keys(divisions));
    } catch (e) { validDivisions = null; }

    // Validate sharableWith
    let sharableWith = activity.sharableWith;
    if (!sharableWith || typeof sharableWith !== 'object') {
        sharableWith = { type: 'not_sharable', divisions: [], capacity: 2 };
    } else {
        if (!['not_sharable', 'same_division', 'custom', 'all'].includes(sharableWith.type)) sharableWith.type = 'not_sharable';
        if (!Array.isArray(sharableWith.divisions)) {
            sharableWith.divisions = [];
        } else if (validDivisions && validDivisions.size > 0) {
            const originalLength = sharableWith.divisions.length;
            sharableWith.divisions = sharableWith.divisions.filter(d => typeof d === 'string' && validDivisions.has(d));
            if (sharableWith.divisions.length < originalLength) {
                console.warn(`[SPECIAL_ACTIVITIES] "${activity.name}": Removed ${originalLength - sharableWith.divisions.length} orphaned division(s) from sharableWith`);
            }
        }
        sharableWith.capacity = parseInt(sharableWith.capacity, 10) || 2;
    }

    // Validate limitUsage
    let limitUsage = activity.limitUsage;
    if (!limitUsage || typeof limitUsage !== 'object') {
        limitUsage = { enabled: false, divisions: {}, priorityList: [] };
    } else {
        limitUsage.enabled = limitUsage.enabled === true;
        if (typeof limitUsage.divisions !== 'object' || limitUsage.divisions === null) {
            limitUsage.divisions = {};
        } else if (validDivisions && validDivisions.size > 0) {
            const divKeys = Object.keys(limitUsage.divisions);
            divKeys.forEach(divKey => {
                if (!validDivisions.has(divKey)) {
                    delete limitUsage.divisions[divKey];
                    console.warn(`[SPECIAL_ACTIVITIES] "${activity.name}": Removed orphaned division "${divKey}" from limitUsage`);
                }
            });
        }
        if (!Array.isArray(limitUsage.priorityList)) {
            limitUsage.priorityList = Object.keys(limitUsage.divisions);
        } else if (validDivisions && validDivisions.size > 0) {
            limitUsage.priorityList = limitUsage.priorityList.filter(d => validDivisions.has(d));
        }
        if (limitUsage.usePriority === undefined) limitUsage.usePriority = false;
    }

    // Validate timeRules
    let timeRules = activity.timeRules;
    if (!Array.isArray(timeRules)) {
        timeRules = [];
    } else {
        timeRules = timeRules.map(rule => ({
            type: rule.type || 'Available',
            start: rule.start || '',
            end: rule.end || '',
            startMin: rule.startMin ?? parseTimeToMinutes(rule.start),
            endMin: rule.endMin ?? parseTimeToMinutes(rule.end),
            ...(rule.divisions && rule.divisions.length > 0 ? { divisions: [...rule.divisions] } : {})
        })).filter(rule => rule.start && rule.end);
    }

    // Determine isIndoor
    let isIndoor = activity.isIndoor;
    if (isIndoor === undefined) {
        if (activity.rainyDayAvailable === true || activity.availableOnRainyDay === true) isIndoor = true;
        else if (activity.rainyDayAvailable === false || activity.availableOnRainyDay === false) isIndoor = false;
        else isIndoor = true;
    }

    return {
        name: activity.name || activityName || 'Unknown',
        type: 'Special',
        available: activity.available !== false,
        sharableWith: sharableWith,
        limitUsage: limitUsage,
        timeRules: timeRules,
        maxUsage: (() => {
            if (activity.maxUsage == null || activity.maxUsage === "") return null;
            const parsed = parseInt(activity.maxUsage, 10);
            return (!isNaN(parsed) && parsed > 0) ? parsed : null;
        })(),
        frequencyWeeks: parseInt(activity.frequencyWeeks, 10) || 0,
        rainyDayExclusive: activity.rainyDayExclusive === true,
        rainyDayOnly: activity.rainyDayOnly === true,
        prepDuration: parseInt(activity.prepDuration, 10) || 0,
        location: activity.location || null,
        isIndoor: isIndoor,
        rainyDayAvailable: isIndoor,
        availableOnRainyDay: isIndoor
    };
}

function createDefaultActivity(name) {
    return {
        name: name,
        type: 'Special',
        available: true,
        sharableWith: { type: 'not_sharable', divisions: [], capacity: 2 },
        limitUsage: { enabled: false, divisions: {}, priorityList: [], usePriority: false },
        timeRules: [],
        maxUsage: null,
        frequencyWeeks: 0,
        rainyDayExclusive: false,
        prepDuration: 0,
        location: null,
        isIndoor: true,
        rainyDayAvailable: true,
        availableOnRainyDay: true
    };
}

function validateAllActivities(activities) {
    if (!Array.isArray(activities)) return [];
    return activities.map(a => validateSpecialActivity(a, a?.name));
}

// =========================================================================
// INIT
// =========================================================================
function initSpecialActivitiesTab() {
    const container = document.getElementById("special_activities");
    if (!container) { console.warn("[SPECIAL_ACTIVITIES] Container element not found"); return; }

    cleanupEventListeners();
    cleanupTabListeners();
    loadData();
    container.innerHTML = "";

    // ★ v3.1: Minimal scoped styles — teal theme matching fields.js
    const style = document.createElement('style');
    style.innerHTML = `
        #special_activities .list-item.selected { background: var(--teal-tint-bg, #f0f9fb); border-left: 3px solid var(--teal-primary, #147D91); }
        #special_activities .chip.active { background: var(--teal-primary, #147D91); color: white; border-color: var(--teal-primary, #147D91); box-shadow: 0 2px 5px rgba(20, 125, 145, 0.3); }
        #special_activities input:checked + .slider { background-color: var(--teal-primary, #147D91); }
        .rainy-list { background: linear-gradient(to bottom, #f0f9ff, #fff) !important; border-color: #7dd3fc !important; }
        .rainy-badge { display: inline-flex; align-items: center; gap: 3px; font-size: 0.7rem; color: #0284c7; background: #e0f2fe; padding: 2px 8px; border-radius: 999px; margin-left: 8px; }
        .weather-badge { display: inline-flex; align-items: center; gap: 3px; font-size: 0.65rem; padding: 2px 6px; border-radius: 999px; margin-left: 6px; }
        .weather-badge.indoor { color: #0A4A56; background: #e6f4f7; }
        .weather-badge.outdoor { color: #92400e; background: #fef3c7; }
    `;
    container.appendChild(style);

    const contentWrapper = document.createElement('div');
    contentWrapper.innerHTML = `
        <div class="setup-panel">
          <section>
            <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:16px; margin-bottom:24px;">
              <div>
                <div class="setup-title">Special Activities</div>
                <p class="setup-description">Manage special camp programs and their availability, sharing, division access, and rotation rules.</p>
              </div>
            </div>
            <div style="display:flex; flex-wrap:wrap; gap:24px;">
              <div style="flex:1; min-width:280px;">
                <div style="display:flex; justify-content:space-between; align-items:end; margin-bottom:8px;">
                    <div class="setup-subtitle">All Specials</div>
                </div>
                <div style="background:white; padding:10px; border-radius:12px; border:1px solid #E5E7EB; margin-bottom:12px; display:flex; gap:8px;">
                  <input id="new-special-input" placeholder="New Special (e.g., Canteen)" style="flex:1; border:none; outline:none; font-size:0.9rem;">
                  <button id="add-special-btn" style="background:#111; color:white; border:none; border-radius:6px; padding:6px 12px; font-size:0.8rem; cursor:pointer;">Add</button>
                </div>
                <div id="specials-master-list" class="master-list" style="max-height:280px; overflow-y:auto;"></div>
                <div style="margin-top:24px;">
                  <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                    
                    <div class="setup-subtitle" style="margin:0;">Rainy Day Activities</div>
                  </div>
                  <p style="font-size:0.75rem; color:#6B7280; margin:0 0 8px 0;">Exclusively available during rainy days</p>
                  <div style="background:linear-gradient(135deg, #e0f2fe 0%, #f0f9ff 100%); padding:10px; border-radius:12px; border:1px solid #7dd3fc; margin-bottom:12px; display:flex; gap:8px;">
                    <input id="new-rainy-day-input" placeholder="New Rainy Day Activity" style="flex:1; border:none; outline:none; font-size:0.9rem; background:transparent;">
                    <button id="add-rainy-day-btn" style="background:#0284c7; color:white; border:none; border-radius:6px; padding:6px 12px; font-size:0.8rem; cursor:pointer;">Add</button>
                  </div>
                  <div id="rainy-day-master-list" class="master-list rainy-list" style="max-height:200px; overflow-y:auto;"></div>
                </div>
              </div>
              <div style="flex:1.4; min-width:340px;">
                <div class="setup-subtitle">Special Configuration</div>
                <div id="specials-detail-pane" style="margin-top:8px;"></div>
              </div>
            </div>
          </section>
        </div>`;
    container.appendChild(contentWrapper);

    specialsListEl = document.getElementById("specials-master-list");
    rainyDayListEl = document.getElementById("rainy-day-master-list");
    detailPaneEl = document.getElementById("specials-detail-pane");
    addSpecialInput = document.getElementById("new-special-input");
    addRainyDayInput = document.getElementById("new-rainy-day-input");

    const addSpecialBtn = document.getElementById("add-special-btn");
    const addRainyDayBtn = document.getElementById("add-rainy-day-btn");
    if (addSpecialBtn) addSpecialBtn.onclick = addSpecial;
    if (addSpecialInput) addSpecialInput.onkeyup = e => { if (e.key === "Enter") addSpecial(); };
    if (addRainyDayBtn) addRainyDayBtn.onclick = addRainyDayActivity;
    if (addRainyDayInput) addRainyDayInput.onkeyup = e => { if (e.key === "Enter") addRainyDayActivity(); };

    setupTabListeners();
    setupCloudSyncListener();
    setupBeforeUnloadHandler();
    _isInitialized = true;

    renderMasterList();
    renderRainyDayList();
    renderDetailPane();
    console.log("[SPECIAL_ACTIVITIES] Initialized:", { specials: specialActivities.length, rainyDay: rainyDayActivities.length });
}

// =========================================================================
// DATA LOADING / SAVING
// =========================================================================
function loadData() {
    try {
        const settings = window.loadGlobalSettings?.() || {};
        const allActivities = settings.specialActivities || settings.app1?.specialActivities || [];

        const rawRainyOnly = allActivities.filter(s => s.rainyDayOnly === true || s.rainyDayExclusive === true);
        console.log(`[SPECIAL_ACTIVITIES] loadData: Found ${allActivities.length} total activities in storage`);
        console.log(`[SPECIAL_ACTIVITIES] loadData: ${rawRainyOnly.length} have rainyDayOnly/rainyDayExclusive=true`);
        if (rawRainyOnly.length > 0) console.log(`[SPECIAL_ACTIVITIES] loadData: Rainy-only names: ${rawRainyOnly.map(s => s.name).join(', ')}`);

        specialActivities = [];
        rainyDayActivities = [];

        allActivities.forEach(s => {
            const validated = validateSpecialActivity(s, s?.name);
            if (validated.rainyDayOnly === true) validated.rainyDayExclusive = true;
            if (validated.rainyDayExclusive) {
                rainyDayActivities.push(validated);
            } else {
                specialActivities.push(validated);
            }
        });

        console.log("[SPECIAL_ACTIVITIES] Data loaded:", {
            specials: specialActivities.length,
            rainyDay: rainyDayActivities.length,
            rainyDayNames: rainyDayActivities.map(s => s.name)
        });
    } catch (e) {
        console.error("[SPECIAL_ACTIVITIES] Error loading data:", e);
        specialActivities = [];
        rainyDayActivities = [];
    }
}

function refreshFromStorage() {
    const previousSpecialsJson = JSON.stringify(specialActivities);
    const previousRainyJson = JSON.stringify(rainyDayActivities);
    const previousSelected = selectedItemId;
    loadData();

    if (selectedItemId) {
        const [, name] = selectedItemId.split(/-(.+)/);
        const exists = specialActivities.some(s => s.name === name) || rainyDayActivities.some(s => s.name === name);
        if (!exists) selectedItemId = null;
    }

    const dataChanged = previousSpecialsJson !== JSON.stringify(specialActivities) ||
                        previousRainyJson !== JSON.stringify(rainyDayActivities) ||
                        previousSelected !== selectedItemId;

    if (dataChanged) {
        console.log("[SPECIAL_ACTIVITIES] Data changed - re-rendering UI");
        if (specialsListEl) renderMasterList();
        if (rainyDayListEl) renderRainyDayList();
        if (detailPaneEl) renderDetailPane();
    }
}

function saveData() {
    if (window.AccessControl?.canEditSetup && !window.AccessControl.canEditSetup()) {
        console.warn('[SPECIAL_ACTIVITIES] Save blocked - insufficient permissions');
        return;
    }
    try {
        const validatedSpecials = validateAllActivities(specialActivities);
        const validatedRainy = validateAllActivities(rainyDayActivities);
        specialActivities = validatedSpecials;
        rainyDayActivities = validatedRainy;
        const allActivities = [...specialActivities, ...rainyDayActivities];
        window.saveGlobalSpecialActivities?.(allActivities);
        if (typeof window.forceSyncToCloud === 'function') {
            if (window._specialActivitiesSyncTimeout) clearTimeout(window._specialActivitiesSyncTimeout);
            window._specialActivitiesSyncTimeout = setTimeout(() => {
                window.forceSyncToCloud();
                window._specialActivitiesSyncTimeout = null;
            }, 500);
        }
    } catch (e) {
        console.error("[SPECIAL_ACTIVITIES] Error saving data:", e);
    }
}

// =========================================================================
// LEFT LIST (Master List)
// =========================================================================
function renderMasterList() {
    if (!specialsListEl) return;
    specialsListEl.innerHTML = "";
    if (specialActivities.length === 0) {
        specialsListEl.innerHTML = `<div style="padding:20px; text-align:center; color:#9CA3AF;">No special activities yet.</div>`;
        return;
    }
    specialActivities.forEach(item => specialsListEl.appendChild(createMasterListItem(item, false)));
}

function renderRainyDayList() {
    if (!rainyDayListEl) return;
    rainyDayListEl.innerHTML = "";
    if (rainyDayActivities.length === 0) {
        rainyDayListEl.innerHTML = `<div style="padding:16px; text-align:center; color:#0369a1; font-size:0.85rem;">
No rainy day activities yet.<br>
            <span style="font-size:0.75rem; opacity:0.7;">Add activities that only appear during rainy days.</span></div>`;
        return;
    }
    rainyDayActivities.forEach(item => rainyDayListEl.appendChild(createMasterListItem(item, true)));
}

function createMasterListItem(item, isRainyDay = false) {
    if (!item || !item.name) return document.createElement('div');
    const id = `special-${item.name}`;
    const el = document.createElement("div");
    el.className = "list-item" + (id === selectedItemId ? " selected" : "");
    el.onclick = () => { selectedItemId = id; renderMasterList(); renderRainyDayList(); renderDetailPane(); };

    const infoDiv = document.createElement("div");
    const nameEl = document.createElement("div");
    nameEl.className = "list-item-name";
    nameEl.textContent = item.name;

    if (isRainyDay) {
        const badge = document.createElement("span");
        badge.className = "rainy-badge";
        badge.textContent = "Rainy Only";
        nameEl.appendChild(badge);
    } else {
        const weatherBadge = document.createElement("span");
        weatherBadge.className = `weather-badge ${item.isIndoor ? 'indoor' : 'outdoor'}`;
        weatherBadge.textContent = item.isIndoor ? 'In' : 'Out';
        nameEl.appendChild(weatherBadge);
    }

    infoDiv.appendChild(nameEl);
    el.appendChild(infoDiv);

    const tog = document.createElement("label");
    tog.className = "switch";
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

// =========================================================================
// RIGHT PANEL — COLLAPSIBLE SECTIONS
// =========================================================================
function renderDetailPane() {
    if (!detailPaneEl) return;
    if (!selectedItemId) {
        detailPaneEl.innerHTML = `<div style="height:300px; display:flex; align-items:center; justify-content:center; color:#9CA3AF; border:1px dashed #E5E7EB; border-radius:12px;">Select a special to edit details</div>`;
        return;
    }

    const [, name] = selectedItemId.split(/-(.+)/);
    if (!name) { detailPaneEl.innerHTML = `<p class='muted'>Invalid selection.</p>`; selectedItemId = null; return; }

    let item = specialActivities.find(s => s.name === name);
    let isRainyDayItem = false;
    if (!item) { item = rainyDayActivities.find(s => s.name === name); isRainyDayItem = true; }
    if (!item) { detailPaneEl.innerHTML = `<p class='muted'>Not found.</p>`; selectedItemId = null; return; }

    detailPaneEl.innerHTML = "";

    // -- HEADER --
    const header = document.createElement("div");
    header.style.display = "flex"; header.style.justifyContent = "space-between"; header.style.alignItems = "center"; header.style.marginBottom = "16px";

    const titleContainer = document.createElement("div");
    titleContainer.style.display = "flex"; titleContainer.style.alignItems = "center"; titleContainer.style.gap = "10px";

    const title = document.createElement("h2");
    title.textContent = item.name; title.style.margin = "0"; title.style.fontSize = "1.25rem"; title.title = "Double click to rename";
    makeEditable(title, newName => {
        if (!newName.trim()) return;
        const oldName = item.name;
        if (oldName === newName) return;
        if (specialActivities.some(s => s !== item && s.name.toLowerCase() === newName.toLowerCase()) ||
            rainyDayActivities.some(s => s !== item && s.name.toLowerCase() === newName.toLowerCase())) {
            alert(`A special activity named "${newName}" already exists.`); return;
        }
        item.name = newName;
        selectedItemId = `special-${newName}`;
        propagateSpecialActivityRename(oldName, newName);
        saveData(); renderMasterList(); renderRainyDayList(); renderDetailPane();
    });
    titleContainer.appendChild(title);

    if (isRainyDayItem) {
        const badge = document.createElement("span");
        badge.style.cssText = "display:inline-flex; align-items:center; gap:4px; padding:4px 10px; background:linear-gradient(135deg, #0ea5e9, #0284c7); color:white; border-radius:999px; font-size:0.75rem; font-weight:600;";
        badge.textContent = "Rainy Day Only";
        titleContainer.appendChild(badge);
    }

    const delBtn = document.createElement("button");
    delBtn.innerHTML = `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg> Delete`;
    delBtn.style.color = "#DC2626"; delBtn.style.background = "#FEF2F2"; delBtn.style.border = "1px solid #FECACA";
    delBtn.style.padding = "6px 12px"; delBtn.style.borderRadius = "6px"; delBtn.style.cursor = "pointer";
    delBtn.style.display = "flex"; delBtn.style.gap = "6px"; delBtn.style.alignItems = "center";
    delBtn.onclick = () => {
        if (window.AccessControl?.canEraseData && !window.AccessControl.canEraseData()) { window.AccessControl?.showPermissionDenied?.('delete special activities'); return; }
        if (!window.AccessControl?.checkSetupAccess?.('delete special activities')) return;
        if (confirm(`Delete "${escapeHtml(item.name)}"?\n\nThis will also remove references from all schedules.`)) {
            cleanupDeletedSpecialActivity(item.name);
            if (isRainyDayItem) rainyDayActivities = rainyDayActivities.filter(s => s.name !== item.name);
            else specialActivities = specialActivities.filter(s => s.name !== item.name);
            saveData(); selectedItemId = null; renderMasterList(); renderRainyDayList(); renderDetailPane();
        }
    };

    header.appendChild(titleContainer);
    header.appendChild(delBtn);
    detailPaneEl.appendChild(header);

    // -- SECTIONS --
    const sections = [
        { title: "Field / Location", summary: summaryLocation(item), render: () => renderLocationSettings(item) },
        { title: "Concurrent Use", summary: summarySharing(item), render: () => renderSharing(item) },
        { title: "Division Access", summary: summaryAccess(item), render: () => renderAccess(item) },
        { title: "Time Availability", summary: summaryTime(item), render: () => renderTimeRules(item) }
    ];

    if (!isRainyDayItem) {
        sections.push({ title: "Weather & Availability", summary: summaryWeather(item), render: () => renderWeatherSettings(item) });
    }

    // ★ v3.1: Prep Duration section
    sections.push({
        title: "Prep Duration",
        summary: (item.prepDuration > 0) ? item.prepDuration + 'min prep' : 'None',
        render: () => renderPrepDurationSettings(item)
    });

    sections.forEach(sec => {
        const section = document.createElement("div"); section.className = "detail-section";
        const hdr = document.createElement("div"); hdr.className = "detail-section-header";
        hdr.innerHTML = `<div><div class="detail-section-title">${escapeHtml(sec.title)}</div><div class="detail-section-summary">${escapeHtml(sec.summary)}</div></div><span style="font-size:1rem;">▸</span>`;
        const body = document.createElement("div"); body.className = "detail-section-body";
        body.appendChild(sec.render());
        hdr.onclick = () => {
            const isOpen = body.style.display === "block";
            body.style.display = isOpen ? "none" : "block";
            hdr.querySelector("span").textContent = isOpen ? "▸" : "▾";
        };
        section.appendChild(hdr); section.appendChild(body);
        detailPaneEl.appendChild(section);
    });
}

// =========================================================================
// SUMMARIES
// =========================================================================
function summarySharing(item) {
    if (!item.sharableWith || item.sharableWith.type === 'not_sharable') return "No sharing (1 bunk only)";
    return `Up to ${parseInt(item.sharableWith.capacity, 10) || 2} bunks (same grade)`;
}
function summaryAccess(item) {
    if (!item.limitUsage || !item.limitUsage.enabled) return "Open to all grades";
    const count = Object.keys(item.limitUsage.divisions || {}).length;
    if (count === 0) return "⚠ Restricted (none selected)";
    const pStr = item.limitUsage.usePriority ? " · prioritized" : "";
    return `${count} grade${count !== 1 ? 's' : ''} allowed${pStr}`;
}
function summaryTime(item) { const c = (item.timeRules || []).length; return c ? `${c} rule(s) active` : "Available all day"; }
function summaryWeather(item) { return item.isIndoor ? "Indoor - Available on rainy days" : "Outdoor - Disabled on rainy days"; }
function summaryLocation(item) { return item.location ? `${item.location}` : "No field assigned"; }

// =========================================================================
// CONTENT RENDERERS
// =========================================================================

// 1. SHARING RULES
function renderSharing(item) {
    const container = document.createElement("div");
    const updateSummary = () => {
        const summaryEl = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if (summaryEl) summaryEl.textContent = summarySharing(item);
    };
    const renderContent = () => {
        container.innerHTML = "";
        const rules = item.sharableWith || { type: 'not_sharable', divisions: [], capacity: 2 };

        const modeWrap = document.createElement("div"); modeWrap.style.display = "flex"; modeWrap.style.gap = "12px"; modeWrap.style.marginBottom = "16px";

        const btnNot = document.createElement("button"); btnNot.textContent = "Not Sharable";
        btnNot.style.cssText = `flex:1; padding:8px; border-radius:6px; border:1px solid #E5E7EB; cursor:pointer; background:${rules.type === 'not_sharable' ? '#e6f4f7' : '#fff'}; color:${rules.type === 'not_sharable' ? '#0F5F6E' : '#333'}; border-color:${rules.type === 'not_sharable' ? '#147D91' : '#E5E7EB'}; font-weight:${rules.type === 'not_sharable' ? '600' : '400'}; transition:all 0.2s;`;

        const btnSha = document.createElement("button"); btnSha.textContent = "Sharable";
        btnSha.style.cssText = `flex:1; padding:8px; border-radius:6px; border:1px solid #E5E7EB; cursor:pointer; background:${rules.type !== 'not_sharable' ? '#e6f4f7' : '#fff'}; color:${rules.type !== 'not_sharable' ? '#0F5F6E' : '#333'}; border-color:${rules.type !== 'not_sharable' ? '#147D91' : '#E5E7EB'}; font-weight:${rules.type !== 'not_sharable' ? '600' : '400'}; transition:all 0.2s;`;

        btnNot.onclick = () => { rules.type = 'not_sharable'; rules.divisions = []; saveData(); renderContent(); updateSummary(); };
        btnSha.onclick = () => { rules.type = 'custom'; saveData(); renderContent(); updateSummary(); };
        modeWrap.appendChild(btnNot); modeWrap.appendChild(btnSha); container.appendChild(modeWrap);

        if (rules.type !== 'not_sharable') {
            const det = document.createElement("div"); det.style.background = "#F9FAFB"; det.style.padding = "12px"; det.style.borderRadius = "8px";
            const capRow = document.createElement("div"); capRow.style.marginBottom = "12px";
            capRow.innerHTML = `<label style="font-size:0.85rem;font-weight:500;">Max Bunks Sharing at Once (Capacity)</label>`;
            const capIn = document.createElement("input"); capIn.type = "number"; capIn.min = "2"; capIn.max = "99";
            capIn.value = parseInt(rules.capacity, 10) || 2;
            capIn.style.cssText = "width:60px; padding:6px; margin-left:8px; border:1px solid #E5E7EB; border-radius:4px;";
            capIn.onchange = () => { rules.capacity = Math.max(2, parseInt(capIn.value, 10) || 2); saveData(); updateSummary(); };
            capRow.appendChild(capIn); det.appendChild(capRow);

            const chipLabel = document.createElement("div"); chipLabel.textContent = "Limit to Divisions (optional):";
            chipLabel.style.fontSize = "0.85rem"; chipLabel.style.fontWeight = "500"; chipLabel.style.marginBottom = "6px"; det.appendChild(chipLabel);

            const chipWrap = document.createElement("div");
            const availableDivisions = window.availableDivisions || Object.keys(window.divisions || {});
            availableDivisions.forEach(d => {
                const isActive = rules.divisions.includes(d);
                const chip = document.createElement("span"); chip.className = "chip " + (isActive ? "active" : "inactive"); chip.textContent = d;
                chip.onclick = () => {
                    if (isActive) rules.divisions = rules.divisions.filter(x => x !== d);
                    else rules.divisions.push(d);
                    rules.type = rules.divisions.length > 0 ? 'custom' : 'all';
                    saveData(); chip.className = "chip " + (rules.divisions.includes(d) ? "active" : "inactive");
                };
                chipWrap.appendChild(chip);
            });
            det.appendChild(chipWrap); container.appendChild(det);
        }
    };
    renderContent(); return container;
}

// 2. ACCESS & RESTRICTIONS
function renderAccess(item) {
    const container = document.createElement("div");
    const updateSummary = () => {
        const summaryEl = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if (summaryEl) summaryEl.textContent = summaryAccess(item);
    };
    const renderContent = () => {
        container.innerHTML = "";
        const rules = item.limitUsage || { enabled: false, divisions: {}, priorityList: [] };
        if (!rules.priorityList) rules.priorityList = Object.keys(rules.divisions || {});

        const modeWrap = document.createElement("div"); modeWrap.style.display = "flex"; modeWrap.style.gap = "12px"; modeWrap.style.marginBottom = "16px";

        const btnAll = document.createElement("button"); btnAll.textContent = "Open to All";
        btnAll.style.cssText = `flex:1; padding:8px; border-radius:6px; border:1px solid #E5E7EB; cursor:pointer; background:${!rules.enabled ? '#e6f4f7' : '#fff'}; color:${!rules.enabled ? '#0F5F6E' : '#333'}; border-color:${!rules.enabled ? '#147D91' : '#E5E7EB'}; font-weight:${!rules.enabled ? '600' : '400'}; transition:all 0.2s;`;

        const btnRes = document.createElement("button"); btnRes.textContent = "Restricted";
        btnRes.style.cssText = `flex:1; padding:8px; border-radius:6px; border:1px solid #E5E7EB; cursor:pointer; background:${rules.enabled ? '#e6f4f7' : '#fff'}; color:${rules.enabled ? '#0F5F6E' : '#333'}; border-color:${rules.enabled ? '#147D91' : '#E5E7EB'}; font-weight:${rules.enabled ? '600' : '400'}; transition:all 0.2s;`;

        btnAll.onclick = () => { rules.enabled = false; item.limitUsage = rules; saveData(); renderContent(); updateSummary(); };
        btnRes.onclick = () => { rules.enabled = true; item.limitUsage = rules; saveData(); renderContent(); updateSummary(); };
        modeWrap.appendChild(btnAll); modeWrap.appendChild(btnRes); container.appendChild(modeWrap);

        if (rules.enabled) {
            const body = document.createElement("div"); body.style.background = "#F9FAFB"; body.style.padding = "12px"; body.style.borderRadius = "8px";
            const listContainer = document.createElement("div"); listContainer.style.marginBottom = "16px";

            if (rules.priorityList.length === 0) {
                listContainer.innerHTML = `<div style="color:#9CA3AF; font-style:italic; font-size:0.85rem;">Click divisions below to allow access.</div>`;
            }

            rules.priorityList.forEach((divName, idx) => {
                const row = document.createElement("div");
                row.style.cssText = "display:flex; align-items:center; justify-content:space-between; padding:8px 10px; background:white; border:1px solid #E5E7EB; border-radius:6px; margin-bottom:6px;";
                row.innerHTML = `<span style="font-weight:bold; color:#147D91; width:20px;">${idx + 1}</span> <span style="flex:1;">${escapeHtml(divName)}</span>`;

                const ctrls = document.createElement("div"); ctrls.style.display = "flex"; ctrls.style.gap = "4px";
                const mkBtn = (txt, fn, dis) => {
                    const b = document.createElement("button");
                    b.style.cssText = "padding:4px 8px; border:1px solid #E5E7EB; border-radius:4px; background:white; cursor:pointer; font-size:0.8rem;";
                    b.textContent = txt;
                    if (dis) { b.disabled = true; b.style.opacity = "0.5"; b.style.cursor = "not-allowed"; } else b.onclick = fn;
                    return b;
                };
                ctrls.appendChild(mkBtn("↑", () => { [rules.priorityList[idx - 1], rules.priorityList[idx]] = [rules.priorityList[idx], rules.priorityList[idx - 1]]; saveData(); renderContent(); }, idx === 0));
                ctrls.appendChild(mkBtn("↓", () => { [rules.priorityList[idx + 1], rules.priorityList[idx]] = [rules.priorityList[idx], rules.priorityList[idx + 1]]; saveData(); renderContent(); }, idx === rules.priorityList.length - 1));
                const rm = mkBtn("✕", () => { rules.priorityList = rules.priorityList.filter(d => d !== divName); delete rules.divisions[divName]; saveData(); renderContent(); updateSummary(); }, false);
                rm.style.color = "#DC2626"; rm.style.borderColor = "#FECACA"; ctrls.appendChild(rm);
                row.appendChild(ctrls); listContainer.appendChild(row);
            });
            body.appendChild(listContainer);

            const divHeader = document.createElement("div"); divHeader.textContent = "Allowed Divisions (Click to add/remove):";
            divHeader.style.fontSize = "0.85rem"; divHeader.style.fontWeight = "600"; divHeader.style.marginTop = "16px"; divHeader.style.marginBottom = "6px"; body.appendChild(divHeader);

            const chipWrap = document.createElement("div");
            const availableDivisions = window.availableDivisions || Object.keys(window.divisions || {});
            availableDivisions.forEach(divName => {
                const isAllowed = divName in rules.divisions;
                const c = document.createElement("span"); c.className = "chip " + (isAllowed ? "active" : "inactive"); c.textContent = divName;
                c.onclick = () => {
                    if (isAllowed) { delete rules.divisions[divName]; rules.priorityList = rules.priorityList.filter(d => d !== divName); }
                    else { rules.divisions[divName] = []; if (!rules.priorityList.includes(divName)) rules.priorityList.push(divName); }
                    saveData(); renderContent(); updateSummary();
                };
                chipWrap.appendChild(c);
            });
            body.appendChild(chipWrap); container.appendChild(body);
        }
    };
    renderContent(); return container;
}

// 3. TIME RULES
function renderTimeRules(item) {
    const container = document.createElement("div");
    const updateSummary = () => {
        const summaryEl = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if (summaryEl) summaryEl.textContent = summaryTime(item);
    };
    const renderContent = () => {
        container.innerHTML = "";
        if (!Array.isArray(item.timeRules)) item.timeRules = [];

        if (item.timeRules.length > 0) {
            item.timeRules.forEach((r, i) => {
                const row = document.createElement("div");
                row.style.cssText = "display:flex; justify-content:space-between; align-items:center; background:#F9FAFB; padding:8px; margin-bottom:6px; border-radius:6px; border:1px solid #E5E7EB;";
                const leftSide = document.createElement("div"); leftSide.style.flex = "1";
                const txt = document.createElement("span");
                txt.innerHTML = `<strong style="color:${r.type === 'Available' ? '#147D91' : '#DC2626'}">${escapeHtml(r.type)}</strong> ${escapeHtml(r.start)} - ${escapeHtml(r.end)}`;
                leftSide.appendChild(txt);
                if (r.divisions && r.divisions.length > 0) {
                    const divInfo = document.createElement("div"); divInfo.style.cssText = "font-size:0.75rem; color:#6B7280; margin-top:4px;";
                    divInfo.innerHTML = r.divisions.map(d => '<span style="background:#e6f4f7;color:#0F5F6E;padding:2px 6px;border-radius:999px;font-size:0.7rem;margin-right:3px;">' + escapeHtml(d) + '</span>').join('');
                    leftSide.appendChild(divInfo);
                }
                row.appendChild(leftSide);
                const delBtn = document.createElement("button"); delBtn.textContent = "✕";
                delBtn.style.cssText = "background:none; border:none; color:#DC2626; cursor:pointer; font-size:1rem;";
                delBtn.onclick = () => { item.timeRules.splice(i, 1); saveData(); renderContent(); updateSummary(); };
                row.appendChild(delBtn); container.appendChild(row);
            });
        }

        const addSection = document.createElement("div"); addSection.style.cssText = "margin-top:12px;";
        const addRow = document.createElement("div"); addRow.style.cssText = "display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:8px;";
        const typeSel = document.createElement("select");
        typeSel.innerHTML = `<option value="Available">Available</option><option value="Unavailable">Unavailable</option>`;
        typeSel.style.cssText = "padding:6px; border:1px solid #E5E7EB; border-radius:4px;";
        const startIn = document.createElement("input"); startIn.type = "text"; startIn.placeholder = "9:00am";
        startIn.style.cssText = "width:80px; padding:6px; border:1px solid #E5E7EB; border-radius:4px;";
        const endIn = document.createElement("input"); endIn.type = "text"; endIn.placeholder = "10:00am";
        endIn.style.cssText = "width:80px; padding:6px; border:1px solid #E5E7EB; border-radius:4px;";
        addRow.appendChild(typeSel); addRow.appendChild(startIn); addRow.appendChild(document.createTextNode(" to ")); addRow.appendChild(endIn);
        addSection.appendChild(addRow);

        // Division restrictions
        const divRow = document.createElement("div"); divRow.style.cssText = "display:flex; align-items:center; gap:8px; margin-bottom:8px; flex-wrap:wrap;";
        const divLabel = document.createElement("span"); divLabel.style.cssText = "font-size:0.8rem; color:#6B7280; white-space:nowrap;"; divLabel.textContent = "Applies to:"; divRow.appendChild(divLabel);

        const allGradesBtn = document.createElement("button"); allGradesBtn.textContent = "All Grades";
        allGradesBtn.style.cssText = "padding:4px 10px; border-radius:6px; border:1px solid #147D91; background:#e6f4f7; color:#0F5F6E; font-size:0.8rem; cursor:pointer; font-weight:600;";
        const specificBtn = document.createElement("button"); specificBtn.textContent = "Specific Grades";
        specificBtn.style.cssText = "padding:4px 10px; border-radius:6px; border:1px solid #E5E7EB; background:#fff; color:#333; font-size:0.8rem; cursor:pointer;";

        let selectedDivisions = [];
        const divChipsWrap = document.createElement("div"); divChipsWrap.style.cssText = "display:none; flex-wrap:wrap; gap:4px; margin-top:6px; margin-bottom:8px; width:100%;";
        const allDivs = window.availableDivisions || Object.keys(window.loadGlobalSettings?.()?.divisions || {});

        function rebuildDivChips() {
            divChipsWrap.innerHTML = "";
            allDivs.forEach(d => {
                const isActive = selectedDivisions.includes(d);
                const c = document.createElement("span"); c.className = "chip " + (isActive ? "active" : "inactive"); c.textContent = d;
                c.onclick = () => { if (isActive) selectedDivisions = selectedDivisions.filter(x => x !== d); else selectedDivisions.push(d); rebuildDivChips(); };
                divChipsWrap.appendChild(c);
            });
        }

        allGradesBtn.onclick = () => {
            selectedDivisions = [];
            allGradesBtn.style.cssText = "padding:4px 10px; border-radius:6px; border:1px solid #147D91; background:#e6f4f7; color:#0F5F6E; font-size:0.8rem; cursor:pointer; font-weight:600;";
            specificBtn.style.cssText = "padding:4px 10px; border-radius:6px; border:1px solid #E5E7EB; background:#fff; color:#333; font-size:0.8rem; cursor:pointer;";
            divChipsWrap.style.display = "none";
        };
        specificBtn.onclick = () => {
            specificBtn.style.cssText = "padding:4px 10px; border-radius:6px; border:1px solid #147D91; background:#e6f4f7; color:#0F5F6E; font-size:0.8rem; cursor:pointer; font-weight:600;";
            allGradesBtn.style.cssText = "padding:4px 10px; border-radius:6px; border:1px solid #E5E7EB; background:#fff; color:#333; font-size:0.8rem; cursor:pointer;";
            divChipsWrap.style.display = "flex"; rebuildDivChips();
        };
        divRow.appendChild(allGradesBtn); divRow.appendChild(specificBtn);
        addSection.appendChild(divRow); addSection.appendChild(divChipsWrap);

        const btn = document.createElement("button"); btn.textContent = "+ Add";
        btn.style.cssText = "padding:6px 12px; background:#147D91; color:white; border:none; border-radius:4px; cursor:pointer;";
        btn.onclick = () => {
            if (!startIn.value.trim() || !endIn.value.trim()) { alert("Please enter both start and end times."); return; }
            const startMin = parseTimeToMinutes(startIn.value);
            const endMin = parseTimeToMinutes(endIn.value);
            if (startMin === null) { alert("Invalid Start Time format. Use format like 9:00am"); return; }
            if (endMin === null) { alert("Invalid End Time format. Use format like 10:00am"); return; }
            if (startMin >= endMin) { alert("End time must be after start time."); return; }
            const newRule = { type: typeSel.value, start: startIn.value, end: endIn.value, startMin, endMin };
            if (selectedDivisions.length > 0) newRule.divisions = [...selectedDivisions];
            item.timeRules.push(newRule); saveData(); renderContent(); updateSummary();
        };
        addSection.appendChild(btn); container.appendChild(addSection);
    };
    renderContent(); return container;
}

// 4. FIELD / LOCATION — ★ v3.1: Fixed to reliably load fields
function renderLocationSettings(item) {
    const container = document.createElement("div");
    const updateSummary = () => {
        const summaryEl = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if (summaryEl) summaryEl.textContent = summaryLocation(item);
    };
    const renderContent = () => {
        container.innerHTML = "";
        const desc = document.createElement("p"); desc.style.cssText = "font-size:0.85rem; color:#6b7280; margin:0 0 12px 0;";
        desc.textContent = "Assign a field or facility where this activity takes place. When scheduled, that field will be locked so no other activity can use it at the same time.";
        container.appendChild(desc);

        if (item.location) {
            const current = document.createElement("div");
            current.style.cssText = "display:flex; align-items:center; gap:10px; padding:12px; background:#f0f9fb; border:1px solid #b2dce6; border-radius:10px; margin-bottom:12px;";
            current.innerHTML = `<div style="flex:1;"><div style="font-weight:600; color:#0A4A56;">${escapeHtml(item.location)}</div><div style="font-size:0.8rem; color:#0F5F6E;">Field will be locked when this activity is scheduled</div></div>`;
            const clearBtn = document.createElement("button"); clearBtn.textContent = "✕ Remove";
            clearBtn.style.cssText = "padding:4px 10px; background:#fef2f2; color:#dc2626; border:1px solid #fecaca; border-radius:6px; cursor:pointer; font-size:0.8rem;";
            clearBtn.onclick = () => { item.location = null; saveData(); renderContent(); updateSummary(); renderMasterList(); };
            current.appendChild(clearBtn); container.appendChild(current);
        }

        const pickerLabel = document.createElement("div"); pickerLabel.style.cssText = "font-size:0.85rem; font-weight:500; margin-bottom:6px;";
        pickerLabel.textContent = item.location ? "Change field:" : "Select a field:"; container.appendChild(pickerLabel);

        const select = document.createElement("select");
        select.style.cssText = "width:100%; padding:8px 10px; border:1px solid #E5E7EB; border-radius:8px; font-size:0.9rem; background:white; cursor:pointer;";
        const defaultOpt = document.createElement("option"); defaultOpt.value = ""; defaultOpt.textContent = "-- None (no field assigned) --"; select.appendChild(defaultOpt);

        // ★ v3.1 FIX: Read fields directly from settings (works before fields tab opens)
        const settingsForFields = window.loadGlobalSettings?.() || {};
        const allFields = settingsForFields.app1?.fields || settingsForFields.fields || window.getFields?.() || [];
        if (allFields.length > 0) {
            const fieldGroup = document.createElement("optgroup"); fieldGroup.label = "Fields";
            allFields.sort((a, b) => (a.name || '').localeCompare(b.name || '')).forEach(field => {
                if (!field.name) return;
                const opt = document.createElement("option"); opt.value = field.name;
                opt.textContent = field.name + (field.rainyDayAvailable ? ' (indoor)' : '');
                if (item.location === field.name) opt.selected = true;
                fieldGroup.appendChild(opt);
            });
            select.appendChild(fieldGroup);
        }

        // Facilities from location zones
        const zones = settingsForFields.locationZones || {};
        const facilities = [];
        Object.entries(zones).forEach(([zoneName, zone]) => {
            if (!zone || typeof zone !== 'object') return;
            Object.keys(zone.locations || {}).forEach(locName => { facilities.push({ name: locName, zone: zoneName }); });
        });
        if (facilities.length > 0) {
            const facGroup = document.createElement("optgroup"); facGroup.label = "Facilities";
            facilities.sort((a, b) => a.name.localeCompare(b.name)).forEach(fac => {
                const opt = document.createElement("option"); opt.value = fac.name;
                opt.textContent = `${fac.name} (${fac.zone})`;
                if (item.location === fac.name) opt.selected = true;
                facGroup.appendChild(opt);
            });
            select.appendChild(facGroup);
        }

        select.onchange = () => { item.location = select.value || null; saveData(); renderContent(); updateSummary(); renderMasterList(); };
        container.appendChild(select);

        const infoBox = document.createElement("div");
        infoBox.style.cssText = "background:#f9fafb; border-radius:8px; padding:12px; font-size:0.85rem; color:#4b5563; margin-top:12px;";
        infoBox.innerHTML = `<strong>How it works:</strong> When the scheduler assigns this special activity to a bunk, the selected field will be automatically locked via Global Field Locks. No other sport or activity can use that field during the same time slots.`;
        container.appendChild(infoBox);
    };
    renderContent(); return container;
}

// 5. WEATHER & AVAILABILITY — ★ v3.1: Teal theme
function renderWeatherSettings(item) {
    const container = document.createElement("div");
    const isIndoor = item.isIndoor === true;
    const updateSummary = () => {
        const summaryEl = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if (summaryEl) summaryEl.textContent = summaryWeather(item);
    };
    container.innerHTML = `
        <div style="margin-bottom: 16px;">
            <p style="font-size: 0.85rem; color: #6b7280; margin: 0 0 12px 0;">
                Mark this special activity as indoor to keep it available during Rainy Day Mode.
                Outdoor activities will be automatically disabled when rainy weather is activated.
            </p>
            <div style="display: flex; align-items: center; gap: 12px; padding: 14px;
                        background: ${isIndoor ? '#e6f4f7' : '#fef3c7'};
                        border: 1px solid ${isIndoor ? '#b2dce6' : '#fcd34d'};
                        border-radius: 10px; transition: all 0.2s ease;">
                
                <div style="flex: 1;">
                    <div style="font-weight: 600; color: ${isIndoor ? '#0A4A56' : '#92400e'};">
                        ${isIndoor ? 'Indoor Activity' : 'Outdoor Activity'}
                    </div>
                    <div style="font-size: 0.85rem; color: ${isIndoor ? '#0F5F6E' : '#b45309'};">
                        ${isIndoor ? 'Available on rainy days' : 'Disabled during rainy days'}
                    </div>
                </div>
                <label class="switch">
                    <input type="checkbox" id="weather-toggle" ${isIndoor ? 'checked' : ''}>
                    <span class="slider"></span>
                </label>
            </div>
        </div>
        <div style="background: #f9fafb; border-radius: 8px; padding: 12px; font-size: 0.85rem; color: #4b5563;">
            <strong>Tip:</strong> Indoor activities like arts & crafts, canteen, game rooms, and
            indoor sports should be marked as indoor. Outdoor activities like nature walks,
            outdoor adventure courses, and field activities should remain as outdoor.
        </div>
    `;
    const toggle = container.querySelector('#weather-toggle');
    if (toggle) {
        toggle.onchange = function() {
            item.isIndoor = this.checked;
            item.rainyDayAvailable = this.checked;
            item.availableOnRainyDay = this.checked;
            saveData();
            const parentContainer = container.parentElement;
            if (parentContainer) { parentContainer.innerHTML = ''; parentContainer.appendChild(renderWeatherSettings(item)); }
            updateSummary(); renderMasterList();
        };
    }
    return container;
}

// 6. PREP DURATION — ★ v3.1 NEW
function renderPrepDurationSettings(item) {
    const container = document.createElement("div");
    const hasPrepTime = (item.prepDuration || 0) > 0;

    container.innerHTML = `
        <div style="margin-bottom: 16px;">
            <p style="font-size: 0.85rem; color: #6b7280; margin: 0 0 12px 0;">
                Some activities need preparation time before the main event.
                Example: <strong>Skits</strong> = 30min practice + 60min performance.
            </p>
            <div style="background: ${hasPrepTime ? '#faf5ff' : '#f9fafb'};
                        border: 1px solid ${hasPrepTime ? '#d8b4fe' : '#e5e7eb'};
                        border-radius: 10px; padding: 14px;">
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: ${hasPrepTime ? '12px' : '0'};">
                    
                    <div style="flex: 1;">
                        <div style="font-weight: 600; color: ${hasPrepTime ? '#6b21a8' : '#374151'};">
                            ${hasPrepTime ? 'Has Prep Phase' : 'Single Phase Activity'}
                        </div>
                        <div style="font-size: 0.8rem; color: ${hasPrepTime ? '#7c3aed' : '#6b7280'};">
                            ${hasPrepTime ? item.prepDuration + ' min prep + main activity' : 'No preparation time needed'}
                        </div>
                    </div>
                    <label class="switch">
                        <input type="checkbox" id="prep-duration-toggle" ${hasPrepTime ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                </div>
                <div id="prep-duration-config" style="display: ${hasPrepTime ? 'block' : 'none'};">
                    <div style="display: flex; align-items: center; gap: 10px; padding: 10px;
                                background: white; border-radius: 8px; border: 1px solid #e9d5ff;">
                        <label style="font-size: 0.85rem; color: #334155;">Prep time:</label>
                        <input type="number" id="prep-duration-input" min="5" max="120" step="5"
                               value="${item.prepDuration || 30}"
                               style="width: 70px; padding: 6px 10px; border: 1px solid #d8b4fe;
                                      border-radius: 6px; font-size: 0.9rem; text-align: center;">
                        <span style="font-size: 0.85rem; color: #64748b;">minutes</span>
                    </div>
                    <div style="font-size: 0.75rem; color: #7c3aed; margin-top: 8px;">
                        During mid-day rain, prep is placed first, then the main activity.
                    </div>
                </div>
            </div>
        </div>
    `;

    const toggle = container.querySelector("#prep-duration-toggle");
    if (toggle) {
        toggle.addEventListener("change", function() {
            const configEl = container.querySelector("#prep-duration-config");
            if (this.checked) {
                configEl.style.display = "block";
                item.prepDuration = parseInt(container.querySelector("#prep-duration-input").value, 10) || 30;
            } else {
                configEl.style.display = "none";
                item.prepDuration = 0;
            }
            saveData();
            const summaryEl = container.closest('.detail-section')?.querySelector('.detail-section-summary');
            if (summaryEl) summaryEl.textContent = (item.prepDuration > 0) ? item.prepDuration + 'min prep' : 'None';
        });
    }

    const durationInput = container.querySelector("#prep-duration-input");
    if (durationInput) {
        durationInput.addEventListener("change", function() {
            const val = parseInt(this.value, 10);
            if (!isNaN(val) && val >= 5 && val <= 120) {
                item.prepDuration = val;
                saveData();
                const summaryEl = container.closest('.detail-section')?.querySelector('.detail-section-summary');
                if (summaryEl) summaryEl.textContent = val + 'min prep';
            }
        });
    }

    return container;
}

// =========================================================================
// ADD SPECIAL
// =========================================================================
function addSpecial() {
    if (!window.AccessControl?.checkSetupAccess?.('add special activities')) return;
    if (!addSpecialInput) return;
    const n = addSpecialInput.value.trim();
    if (!n) return;
    if (specialActivities.some(s => s.name.toLowerCase() === n.toLowerCase()) ||
        rainyDayActivities.some(s => s.name.toLowerCase() === n.toLowerCase())) {
        alert("A special activity with that name already exists."); return;
    }
    specialActivities.push(createDefaultActivity(n));
    addSpecialInput.value = "";
    saveData(); selectedItemId = `special-${n}`; renderMasterList(); renderRainyDayList(); renderDetailPane();
}

// =========================================================================
// ADD RAINY DAY ACTIVITY
// =========================================================================
function addRainyDayActivity() {
    if (!window.AccessControl?.checkSetupAccess?.('add rainy day activities')) return;
    if (!addRainyDayInput) return;
    const n = addRainyDayInput.value.trim();
    if (!n) return;
    if (specialActivities.some(s => s.name.toLowerCase() === n.toLowerCase()) ||
        rainyDayActivities.some(s => s.name.toLowerCase() === n.toLowerCase())) {
        alert("A special activity with that name already exists."); return;
    }
    const newActivity = createDefaultActivity(n);
    newActivity.rainyDayExclusive = true;
    newActivity.rainyDayOnly = true;
    newActivity.isIndoor = true;
    rainyDayActivities.push(newActivity);
    addRainyDayInput.value = "";
    saveData(); selectedItemId = `special-${n}`; renderMasterList(); renderRainyDayList(); renderDetailPane();
}

// =========================================================================
// CLEANUP & RENAME HELPERS
// =========================================================================
function cleanupDeletedSpecialActivity(activityName) {
    if (!activityName) return;
    console.log(`[SPECIAL_ACTIVITIES] Cleaning up references to: "${activityName}"`);
    let cleanupCount = 0;
    try {
        const settings = window.loadGlobalSettings?.() || {};
        const dailySchedules = settings.daily_schedules || {};
        Object.keys(dailySchedules).forEach(dateKey => {
            const dayData = dailySchedules[dateKey];
            if (!dayData?.scheduleAssignments) return;
            Object.keys(dayData.scheduleAssignments).forEach(bunkKey => {
                const slots = dayData.scheduleAssignments[bunkKey];
                if (!Array.isArray(slots)) return;
                slots.forEach((slot, idx) => {
                    if (slot?._activity === activityName || slot?.activity === activityName || slot?.event === activityName) {
                        dayData.scheduleAssignments[bunkKey][idx] = null; cleanupCount++;
                    }
                });
            });
        });
        if (cleanupCount > 0) { window.saveGlobalSettings?.('daily_schedules', dailySchedules); console.log(`   Cleared ${cleanupCount} schedule references`); }
        if (window.scheduleAssignments) {
            Object.keys(window.scheduleAssignments).forEach(bunkKey => {
                const slots = window.scheduleAssignments[bunkKey];
                if (!Array.isArray(slots)) return;
                slots.forEach((slot, idx) => {
                    if (slot?._activity === activityName || slot?.activity === activityName || slot?.event === activityName) window.scheduleAssignments[bunkKey][idx] = null;
                });
            });
        }
        if (window.activityProperties?.[activityName]) { delete window.activityProperties[activityName]; console.log(`   Removed from activityProperties`); }
        console.log(`[SPECIAL_ACTIVITIES] Cleanup complete for "${activityName}"`);
    } catch (e) { console.error('[SPECIAL_ACTIVITIES] Error during cleanup:', e); }
}

function propagateSpecialActivityRename(oldName, newName) {
    if (!oldName || !newName || oldName === newName) return;
    console.log(`[SPECIAL_ACTIVITIES] Propagating rename: "${oldName}" → "${newName}"`);
    try {
        const settings = window.loadGlobalSettings?.() || {};
        const dailySchedules = settings.daily_schedules || {};
        let updateCount = 0;
        Object.keys(dailySchedules).forEach(dateKey => {
            const dayData = dailySchedules[dateKey];
            if (!dayData?.scheduleAssignments) return;
            Object.keys(dayData.scheduleAssignments).forEach(bunkKey => {
                const slots = dayData.scheduleAssignments[bunkKey];
                if (!Array.isArray(slots)) return;
                slots.forEach((slot, idx) => {
                    if (slot?._activity === oldName) { dayData.scheduleAssignments[bunkKey][idx]._activity = newName; updateCount++; }
                    if (slot?.activity === oldName) { dayData.scheduleAssignments[bunkKey][idx].activity = newName; updateCount++; }
                    if (slot?.event === oldName) { dayData.scheduleAssignments[bunkKey][idx].event = newName; updateCount++; }
                });
            });
        });
        if (updateCount > 0) { window.saveGlobalSettings?.('daily_schedules', dailySchedules); console.log(`   Updated ${updateCount} schedule references`); }
        if (window.activityProperties?.[oldName]) {
            window.activityProperties[newName] = { ...window.activityProperties[oldName] };
            delete window.activityProperties[oldName]; console.log(`   Updated activityProperties`);
        }
        console.log(`[SPECIAL_ACTIVITIES] Rename propagation complete`);
    } catch (e) { console.error('[SPECIAL_ACTIVITIES] Error during rename propagation:', e); }
}

// =========================================================================
// HELPERS
// =========================================================================
function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    const div = document.createElement("div"); div.textContent = String(str); return div.innerHTML;
}

function makeEditable(el, save) {
    if (!el) return;
    el.ondblclick = () => {
        const inp = document.createElement("input"); inp.value = el.textContent;
        inp.style.fontSize = "inherit"; inp.style.fontWeight = "inherit";
        inp.style.border = "1px solid #147D91"; inp.style.outline = "none";
        inp.style.borderRadius = "4px"; inp.style.padding = "2px 6px";
        inp.style.width = Math.max(100, el.offsetWidth + 20) + "px";
        el.replaceWith(inp); inp.focus(); inp.select();
        const finish = () => {
            const newVal = inp.value.trim();
            if (newVal && newVal !== el.textContent) save(newVal);
            else if (inp.parentNode) inp.replaceWith(el);
        };
        inp.onblur = finish;
        inp.onkeyup = e => { if (e.key === "Enter") finish(); if (e.key === "Escape") inp.replaceWith(el); };
    };
}

function parseTimeToMinutes(str) {
    if (!str || typeof str !== "string") return null;
    let s = str.trim().toLowerCase();
    let mer = null;
    if (s.endsWith("am") || s.endsWith("pm")) { mer = s.endsWith("am") ? "am" : "pm"; s = s.replace(/am|pm/g, "").trim(); }
    const m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
    if (!m) return null;
    let hh = parseInt(m[1], 10); const mm = parseInt(m[2], 10);
    if (Number.isNaN(hh) || Number.isNaN(mm) || mm < 0 || mm > 59) return null;
    if (mer) { if (hh === 12) hh = mer === "am" ? 0 : 12; else if (mer === "pm") hh += 12; }
    return hh * 60 + mm;
}

// =========================================================================
// EXPORTS
// =========================================================================
window.initSpecialActivitiesTab = initSpecialActivitiesTab;

Object.defineProperty(window, 'specialActivities', { get: () => specialActivities, set: v => { specialActivities = v; }, configurable: true });
Object.defineProperty(window, 'rainyDayActivities', { get: () => rainyDayActivities, set: v => { rainyDayActivities = v; }, configurable: true });

window.getSpecialActivities = () => [...specialActivities];
window.getRainyDayActivities = () => [...rainyDayActivities];

window.getAllSpecialActivities = function() {
    if ((!specialActivities || specialActivities.length === 0) && (!rainyDayActivities || rainyDayActivities.length === 0)) {
        console.log('[SPECIAL_ACTIVITIES] Arrays empty - auto-loading from storage...');
        const settings = window.loadGlobalSettings?.() || {};
        const allActivities = settings.specialActivities || settings.app1?.specialActivities || [];
        if (allActivities.length > 0) {
            specialActivities = []; rainyDayActivities = [];
            allActivities.forEach(s => {
                const validated = validateSpecialActivity(s, s?.name);
                if (validated.rainyDayExclusive || validated.rainyDayOnly) rainyDayActivities.push(validated);
                else specialActivities.push(validated);
            });
            console.log(`[SPECIAL_ACTIVITIES] Auto-loaded ${specialActivities.length} regular + ${rainyDayActivities.length} rainy-only`);
        }
    }
    const combined = [...specialActivities, ...rainyDayActivities];
    return combined;
};

window.getSpecialActivityByName = function(name) {
    if (!name) return null;
    const nameStr = String(name);
    let item = specialActivities.find(s => s.name === nameStr);
    if (!item) item = rainyDayActivities.find(s => s.name === nameStr);
    return item ? { ...item } : null;
};

// =========================================================================
// RAINY DAY MODE EXPORTS
// =========================================================================
window.isRainyDayModeActive = function() {
    try {
        const dailyData = window.loadCurrentDailyData?.() || {};
        return dailyData.rainyDayMode === true || dailyData.isRainyDay === true || window.isRainyDay === true;
    } catch (e) { return window.isRainyDay === true; }
};

window.getAvailableSpecialActivities = function() {
    const isRainy = window.isRainyDayModeActive?.() || false;
    if (isRainy) {
        const regularAvailable = specialActivities.filter(s => s.available && s.isIndoor === true);
        const rainyAvailable = rainyDayActivities.filter(s => s.available);
        return [...regularAvailable, ...rainyAvailable];
    }
    return specialActivities.filter(s => s.available);
};

window.getGlobalSpecialActivities = function(respectRainyDay = true) {
    const allActivities = [...specialActivities, ...rainyDayActivities];
    if (!respectRainyDay) return allActivities;
    const isRainyMode = window.isRainyDayModeActive?.() || window.isRainyDay === true;
    if (isRainyMode) {
        console.log('[SpecialActivities] Rainy mode - filtering for indoor/rainy activities');
        return allActivities.filter(s => s.rainyDayOnly === true || s.rainyDayExclusive === true || s.isIndoor === true);
    }
    console.log('[SpecialActivities] Normal mode - excluding rainy-day-only activities');
    return allActivities.filter(s => s.rainyDayOnly !== true && s.rainyDayExclusive !== true);
};

window.getRainyDayOnlySpecials = function() { return rainyDayActivities.filter(s => s.available !== false); };
window.getIndoorAvailableSpecials = function() { return specialActivities.filter(s => s.available !== false && s.isIndoor === true); };
window.getOutdoorSpecials = function() { return specialActivities.filter(s => s.isIndoor !== true); };

window.cleanupSpecialActivitiesModule = function() { cleanupEventListeners(); cleanupTabListeners(); _isInitialized = false; console.log("[SPECIAL_ACTIVITIES] Module cleaned up"); };
window.refreshSpecialActivitiesFromStorage = function() { if (_isInitialized) refreshFromStorage(); };

window.validateSpecialActivities = function() {
    const allActivities = window.getAllSpecialActivities?.() || [];
    const validated = validateAllActivities(allActivities);
    let issuesFixed = 0;
    allActivities.forEach((original, i) => { if (JSON.stringify(original) !== JSON.stringify(validated[i])) issuesFixed++; });
    if (issuesFixed > 0) {
        console.log(`[SPECIAL_ACTIVITIES] Validation fixed ${issuesFixed} issues`);
        loadData();
        if (_isInitialized) { renderMasterList(); renderRainyDayList(); renderDetailPane(); }
    }
    return { activitiesChecked: allActivities.length, issuesFixed };
};

window.diagnoseSpecialActivities = function() {
    console.log('\n' + '═'.repeat(60));
    console.log('🔍 SPECIAL ACTIVITIES DIAGNOSTICS');
    console.log('═'.repeat(60));

    const settings = window.loadGlobalSettings?.() || {};
    const storedActivities = settings.specialActivities || settings.app1?.specialActivities || [];
    const divisions = Object.keys(settings.divisions || {});
    const isRainyMode = window.isRainyDayModeActive?.() || false;
    const indoorCount = specialActivities.filter(s => s.isIndoor === true).length;
    const outdoorCount = specialActivities.filter(s => s.isIndoor !== true).length;

    console.log('\n📊 SUMMARY:');
    console.log('   Total activities: ' + storedActivities.length);
    console.log('   Regular specials: ' + specialActivities.length);
    console.log('      - Indoor: ' + indoorCount);
    console.log('      - Outdoor: ' + outdoorCount);
    console.log('   Rainy day specials: ' + rainyDayActivities.length);
    console.log('   Valid divisions: ' + (divisions.join(', ') || 'none'));
    console.log('   🌧️ Rainy Day Mode: ' + (isRainyMode ? 'ACTIVE' : 'INACTIVE'));

    if (isRainyMode) {
        var availableNow = window.getGlobalSpecialActivities?.() || [];
        console.log('   📋 Currently available specials: ' + availableNow.length);
    }

    var issues = [];

    storedActivities.forEach(function(a, idx) {
        var actIssues = [];

        // Check type property
        if (!a.type || a.type !== 'Special') {
            actIssues.push('Missing or incorrect type property (should be "Special")');
        }

        // Check sharableWith structure
        if (!a.sharableWith) {
            actIssues.push('Missing sharableWith');
        } else {
            if (!a.sharableWith.type) actIssues.push('sharableWith.type missing');
            if (!Array.isArray(a.sharableWith.divisions)) actIssues.push('sharableWith.divisions not array');
            if (a.sharableWith.capacity === undefined) actIssues.push('sharableWith.capacity missing');

            // Check for stale divisions in sharableWith
            if (Array.isArray(a.sharableWith.divisions)) {
                var staleSharable = a.sharableWith.divisions.filter(function(d) { return !divisions.includes(d); });
                if (staleSharable.length > 0) actIssues.push('Stale sharableWith.divisions: ' + staleSharable.join(', '));
            }
        }

        // Check limitUsage structure
        if (!a.limitUsage) {
            actIssues.push('Missing limitUsage');
        } else {
            if (a.limitUsage.enabled === undefined) actIssues.push('limitUsage.enabled missing');
            if (typeof a.limitUsage.divisions !== 'object') actIssues.push('limitUsage.divisions not object');
            if (!Array.isArray(a.limitUsage.priorityList)) actIssues.push('limitUsage.priorityList missing');

            // Check for stale divisions in limitUsage
            if (typeof a.limitUsage.divisions === 'object' && a.limitUsage.divisions !== null) {
                var staleLimit = Object.keys(a.limitUsage.divisions).filter(function(d) { return !divisions.includes(d); });
                if (staleLimit.length > 0) actIssues.push('Stale limitUsage.divisions: ' + staleLimit.join(', '));
            }
        }

        // Check timeRules
        if (!Array.isArray(a.timeRules)) {
            actIssues.push('timeRules not array');
        } else {
            a.timeRules.forEach(function(rule, rIdx) {
                if (rule.startMin === undefined) actIssues.push('timeRules[' + rIdx + '].startMin missing');
                if (rule.endMin === undefined) actIssues.push('timeRules[' + rIdx + '].endMin missing');
            });
        }

        // Check isIndoor property
        if (a.isIndoor === undefined && !a.rainyDayExclusive && !a.rainyDayOnly) {
            actIssues.push('isIndoor property missing (will default to true)');
        }

        if (actIssues.length > 0) {
            issues.push({ activity: a.name || '[index ' + idx + ']', issues: actIssues });
        }
    });

    if (issues.length === 0) {
        console.log('\n✅ All special activities have valid structure!');
    } else {
        console.log('\n⚠️ ISSUES FOUND (' + issues.length + ' activities):');
        issues.forEach(function(item) {
            console.log('\n   📁 ' + item.activity + ':');
            item.issues.forEach(function(issue) { console.log('      - ' + issue); });
        });
    }

    console.log('\n' + '═'.repeat(60));
    console.log('💡 Run validateSpecialActivities() to auto-fix issues');
    console.log('═'.repeat(60) + '\n');

    return { activities: storedActivities.length, issues: issues.length };
};

console.log("[SPECIAL_ACTIVITIES] Module v3.1 loaded");
})();
