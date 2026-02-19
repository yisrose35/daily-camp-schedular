// ============================================================================
// special_activities.js — PRODUCTION-READY v3.2
// ============================================================================
// v3.2: Visual parity with fields.js — setup-card layout, SVG accordions,
//       availability strip, scoped list/switch styles, toggle sharing pattern
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

console.log("[SPECIAL_ACTIVITIES] Module v3.2 loading...");

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

let _visibilityHandler = null;
let _focusHandler = null;

function setupTabListeners() {
    cleanupTabListeners();
    _visibilityHandler = () => {
        if (document.visibilityState === 'visible' && _isInitialized) {
            if (_refreshTimeout) clearTimeout(_refreshTimeout);
            _refreshTimeout = setTimeout(() => { refreshFromStorage(); }, 300);
        }
    };
    document.addEventListener('visibilitychange', _visibilityHandler);
    activeEventListeners.push({ type: 'visibilitychange', handler: _visibilityHandler, target: document });
    _focusHandler = () => {
        if (_isInitialized) {
            if (_refreshTimeout) clearTimeout(_refreshTimeout);
            _refreshTimeout = setTimeout(() => { refreshFromStorage(); }, 300);
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

function setupCloudSyncListener() {
    if (_cloudSyncCallback && window.SupabaseSync?.removeStatusCallback) window.SupabaseSync.removeStatusCallback(_cloudSyncCallback);
    if (window.SupabaseSync?.onStatusChange) {
        _cloudSyncCallback = (status) => { if (status === 'idle' && _isInitialized) refreshFromStorage(); };
        window.SupabaseSync.onStatusChange(_cloudSyncCallback);
    }
    const handleRemoteChange = (event) => { if (_isInitialized && event.detail?.key === 'specialActivities') refreshFromStorage(); };
    window.addEventListener('campistry-remote-change', handleRemoteChange);
    activeEventListeners.push({ type: 'campistry-remote-change', handler: handleRemoteChange, target: window });
}

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

function validateSpecialActivity(activity, activityName) {
    if (!activity || typeof activity !== 'object') return createDefaultActivity(activityName || 'Unknown');
    let validDivisions = null;
    try { const settings = window.loadGlobalSettings?.() || {}; validDivisions = new Set(Object.keys(settings.divisions || {})); } catch (e) { validDivisions = null; }

    let sharableWith = activity.sharableWith;
    if (!sharableWith || typeof sharableWith !== 'object') { sharableWith = { type: 'not_sharable', divisions: [], capacity: 2 }; }
    else {
        if (!['not_sharable','same_division','custom','all'].includes(sharableWith.type)) sharableWith.type = 'not_sharable';
        if (!Array.isArray(sharableWith.divisions)) sharableWith.divisions = [];
        else if (validDivisions && validDivisions.size > 0) {
            const ol = sharableWith.divisions.length;
            sharableWith.divisions = sharableWith.divisions.filter(d => typeof d === 'string' && validDivisions.has(d));
            if (sharableWith.divisions.length < ol) console.warn(`[SPECIAL_ACTIVITIES] "${activity.name}": Removed ${ol - sharableWith.divisions.length} orphaned division(s) from sharableWith`);
        }
        sharableWith.capacity = parseInt(sharableWith.capacity, 10) || 2;
    }

    let limitUsage = activity.limitUsage;
    if (!limitUsage || typeof limitUsage !== 'object') { limitUsage = { enabled: false, divisions: {}, priorityList: [] }; }
    else {
        limitUsage.enabled = limitUsage.enabled === true;
        if (typeof limitUsage.divisions !== 'object' || limitUsage.divisions === null) limitUsage.divisions = {};
        else if (validDivisions && validDivisions.size > 0) {
            Object.keys(limitUsage.divisions).forEach(divKey => { if (!validDivisions.has(divKey)) { delete limitUsage.divisions[divKey]; } });
        }
        if (!Array.isArray(limitUsage.priorityList)) limitUsage.priorityList = Object.keys(limitUsage.divisions);
        else if (validDivisions && validDivisions.size > 0) limitUsage.priorityList = limitUsage.priorityList.filter(d => validDivisions.has(d));
        if (limitUsage.usePriority === undefined) limitUsage.usePriority = false;
    }

    let timeRules = activity.timeRules;
    if (!Array.isArray(timeRules)) timeRules = [];
    else { timeRules = timeRules.map(rule => ({ type: rule.type || 'Available', start: rule.start || '', end: rule.end || '', startMin: rule.startMin ?? parseTimeToMinutes(rule.start), endMin: rule.endMin ?? parseTimeToMinutes(rule.end), ...(rule.divisions && rule.divisions.length > 0 ? { divisions: [...rule.divisions] } : {}) })).filter(rule => rule.start && rule.end); }

    let isIndoor = activity.isIndoor;
    if (isIndoor === undefined) {
        if (activity.rainyDayAvailable === true || activity.availableOnRainyDay === true) isIndoor = true;
        else if (activity.rainyDayAvailable === false || activity.availableOnRainyDay === false) isIndoor = false;
        else isIndoor = true;
    }

    return {
        name: activity.name || activityName || 'Unknown', type: 'Special', available: activity.available !== false,
        sharableWith, limitUsage, timeRules,
        maxUsage: (() => { if (activity.maxUsage == null || activity.maxUsage === "") return null; const p = parseInt(activity.maxUsage, 10); return (!isNaN(p) && p > 0) ? p : null; })(),
        maxUsagePeriod: activity.maxUsagePeriod || 'half',
        frequencyWeeks: parseInt(activity.frequencyWeeks, 10) || 0, rainyDayExclusive: activity.rainyDayExclusive === true,
        rainyDayOnly: activity.rainyDayOnly === true, prepDuration: parseInt(activity.prepDuration, 10) || 0,
        location: activity.location || null, isIndoor, rainyDayAvailable: isIndoor, availableOnRainyDay: isIndoor,
       ...(activity.rainyDayCapacity > 0 ? { rainyDayCapacity: parseInt(activity.rainyDayCapacity, 10) } : {}),
        ...(activity.rainyDayAvailableAllDay === true ? { rainyDayAvailableAllDay: true } : {}),
        fullGrade: activity.fullGrade === true
    };
}

function createDefaultActivity(name) {
    return { name, type: 'Special', available: true, sharableWith: { type: 'not_sharable', divisions: [], capacity: 2 },
        limitUsage: { enabled: false, divisions: {}, priorityList: [], usePriority: false }, timeRules: [],
        maxUsage: null, maxUsagePeriod: 'half', frequencyWeeks: 0, rainyDayExclusive: false, prepDuration: 0,
        location: null, isIndoor: true, rainyDayAvailable: true, availableOnRainyDay: true,
        rainyDayCapacity: null, rainyDayAvailableAllDay: false, fullGrade: false };
}

function validateAllActivities(activities) { if (!Array.isArray(activities)) return []; return activities.map(a => validateSpecialActivity(a, a?.name)); }

// =========================================================================
// INIT — v3.3: Consolidated accordion layout
// =========================================================================
function initSpecialActivitiesTab() {
    const container = document.getElementById("special_activities");
    if (!container) { console.warn("[SPECIAL_ACTIVITIES] Container element not found"); return; }
    cleanupEventListeners(); cleanupTabListeners(); loadData(); container.innerHTML = "";

    const style = document.createElement('style');
    style.innerHTML = `
        #special_activities .master-list { border: 1px solid var(--slate-200, #E5E7EB); border-radius: var(--radius-md, 12px); background: #fff; overflow: hidden; }
        #special_activities .list-item { padding: 12px 14px; border-bottom: 1px solid var(--slate-100, #F3F4F6); cursor: pointer; display: flex; justify-content: space-between; align-items: center; transition: background 0.15s; }
        #special_activities .list-item:last-child { border-bottom: none; }
        #special_activities .list-item:hover { background: var(--slate-50, #F9FAFB); }
        #special_activities .list-item.selected { background: var(--teal-tint-bg, #f0f9fb); border-left: 3px solid var(--teal-primary, #147D91); }
        #special_activities .list-item-name { font-weight: 500; color: var(--slate-800, #1F2937); font-size: 0.9rem; }
        #special_activities .chip.active { background: var(--teal-primary, #147D91); color: white; border-color: var(--teal-primary, #147D91); box-shadow: 0 2px 5px rgba(20, 125, 145, 0.3); }
        #special_activities input:checked + .slider { background-color: var(--teal-primary, #147D91); }
        #special_activities .switch { position: relative; display: inline-block; width: 34px; height: 20px; flex-shrink: 0; }
        #special_activities .switch input { opacity: 0; width: 0; height: 0; }
        #special_activities .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #ccc; transition: .4s; border-radius: 34px; }
        #special_activities .slider:before { position: absolute; content: ""; height: 14px; width: 14px; left: 3px; bottom: 3px; background-color: white; transition: .4s; border-radius: 50%; }
        #special_activities input:checked + .slider:before { transform: translateX(14px); }
        #special_activities .grouped-section { border:1px solid #E5E7EB; border-radius:10px; overflow:hidden; margin-bottom:12px; }
        #special_activities .grouped-section .detail-section { border-bottom:1px solid #F3F4F6; }
        #special_activities .grouped-section .detail-section:last-child { border-bottom:none; }
        #special_activities .group-label { font-size:0.7rem; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; color:#9CA3AF; padding:8px 14px 4px; background:#FAFAFA; }
        .rainy-list { background: linear-gradient(to bottom, #f0f9ff, #fff) !important; border-color: #7dd3fc !important; }
        .rainy-badge { display: inline-flex; align-items: center; gap: 3px; font-size: 0.7rem; color: #0284c7; background: #e0f2fe; padding: 2px 8px; border-radius: 999px; margin-left: 8px; }
        .weather-badge { display: inline-flex; align-items: center; gap: 3px; font-size: 0.65rem; padding: 2px 6px; border-radius: 999px; margin-left: 6px; }
        .weather-badge.indoor { color: #0A4A56; background: #e6f4f7; }
        .weather-badge.outdoor { color: #92400e; background: #fef3c7; }
    `;
    container.appendChild(style);

    const contentWrapper = document.createElement('div');
    contentWrapper.innerHTML = `
        <div class="setup-grid">
          <section class="setup-card setup-card-wide" style="border:none; box-shadow:none; background:transparent;">
            <div class="setup-card-header" style="margin-bottom:20px;">
              <span class="setup-step-pill">Specials</span>
              <div class="setup-card-text">
                <h3>Manage Special Activities</h3>
                <p>Configure special camp programs, availability, sharing, division access, and rotation rules.</p>
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
    setupTabListeners(); setupCloudSyncListener(); setupBeforeUnloadHandler(); _isInitialized = true;
    renderMasterList(); renderRainyDayList(); renderDetailPane();
    console.log("[SPECIAL_ACTIVITIES] Initialized:", { specials: specialActivities.length, rainyDay: rainyDayActivities.length });
}

function loadData() {
    try {
        const settings = window.loadGlobalSettings?.() || {};
        const allActivities = settings.specialActivities || settings.app1?.specialActivities || [];
        console.log(`[SPECIAL_ACTIVITIES] loadData: Found ${allActivities.length} total activities`);
        specialActivities = []; rainyDayActivities = [];
        allActivities.forEach(s => {
            const validated = validateSpecialActivity(s, s?.name);
            if (validated.rainyDayOnly === true) validated.rainyDayExclusive = true;
            if (validated.rainyDayExclusive) rainyDayActivities.push(validated);
            else specialActivities.push(validated);
        });
    } catch (e) { console.error("[SPECIAL_ACTIVITIES] Error loading data:", e); specialActivities = []; rainyDayActivities = []; }
}

function refreshFromStorage() {
    const pS = JSON.stringify(specialActivities), pR = JSON.stringify(rainyDayActivities), pSel = selectedItemId;
    loadData();
    if (selectedItemId) { const [, n] = selectedItemId.split(/-(.+)/); if (!specialActivities.some(s=>s.name===n) && !rainyDayActivities.some(s=>s.name===n)) selectedItemId = null; }
    if (pS !== JSON.stringify(specialActivities) || pR !== JSON.stringify(rainyDayActivities) || pSel !== selectedItemId) {
        if (specialsListEl) renderMasterList(); if (rainyDayListEl) renderRainyDayList(); if (detailPaneEl) renderDetailPane();
    }
}

function saveData() {
    if (window.AccessControl?.canEditSetup && !window.AccessControl.canEditSetup()) return;
    try {
        specialActivities = validateAllActivities(specialActivities);
        rainyDayActivities = validateAllActivities(rainyDayActivities);
        window.saveGlobalSpecialActivities?.([...specialActivities, ...rainyDayActivities]);
        if (typeof window.forceSyncToCloud === 'function') {
            if (window._specialActivitiesSyncTimeout) clearTimeout(window._specialActivitiesSyncTimeout);
            window._specialActivitiesSyncTimeout = setTimeout(() => { window.forceSyncToCloud(); window._specialActivitiesSyncTimeout = null; }, 500);
        }
    } catch (e) { console.error("[SPECIAL_ACTIVITIES] Error saving data:", e); }
}

function renderMasterList() {
    if (!specialsListEl) return; specialsListEl.innerHTML = "";
    if (specialActivities.length === 0) { specialsListEl.innerHTML = '<div style="padding:20px; text-align:center; color:#9CA3AF;">No special activities yet.</div>'; return; }
    specialActivities.forEach(item => specialsListEl.appendChild(createMasterListItem(item, false)));
}

function renderRainyDayList() {
    if (!rainyDayListEl) return; rainyDayListEl.innerHTML = "";
    if (rainyDayActivities.length === 0) { rainyDayListEl.innerHTML = '<div style="padding:16px; text-align:center; color:#0369a1; font-size:0.85rem;">No rainy day activities yet.</div>'; return; }
    rainyDayActivities.forEach(item => rainyDayListEl.appendChild(createMasterListItem(item, true)));
}

function createMasterListItem(item, isRainyDay) {
    if (!item || !item.name) return document.createElement('div');
    const id = 'special-' + item.name;
    const el = document.createElement("div");
    el.className = "list-item" + (id === selectedItemId ? " selected" : "");
    el.onclick = () => { selectedItemId = id; renderMasterList(); renderRainyDayList(); renderDetailPane(); };
    const infoDiv = document.createElement("div");
    const nameEl = document.createElement("div"); nameEl.className = "list-item-name"; nameEl.textContent = item.name;
    if (isRainyDay) { const b = document.createElement("span"); b.className = "rainy-badge"; b.textContent = "Rainy Only"; nameEl.appendChild(b); }
    infoDiv.appendChild(nameEl); el.appendChild(infoDiv);
    const tog = document.createElement("label"); tog.className = "switch list-item-toggle"; tog.onclick = e => e.stopPropagation();
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = item.available;
    cb.onchange = () => { item.available = cb.checked; saveData(); renderDetailPane(); };
    const slider = document.createElement("span"); slider.className = "slider";
    tog.appendChild(cb); tog.appendChild(slider); el.appendChild(tog);
    return el;
}

// v3.3: Section builder matching fields.js accordion
function section(title, summary, builder) {
    const wrap = document.createElement("div"); wrap.className = "detail-section";
    const head = document.createElement("div"); head.className = "detail-section-header";
    const t = document.createElement("div");
    t.innerHTML = '<div class="detail-section-title">' + escapeHtml(title) + '</div><div class="detail-section-summary">' + escapeHtml(summary) + '</div>';
    const caret = document.createElement("span");
    caret.innerHTML = '<svg width="20" height="20" fill="none" stroke="#9CA3AF" stroke-width="2" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"></path></svg>';
    caret.style.transition = "transform 0.2s";
    head.appendChild(t); head.appendChild(caret);
    const body = document.createElement("div"); body.className = "detail-section-body";
    head.onclick = () => {
        const open = body.style.display === "block";
        body.style.display = open ? "none" : "block";
        caret.style.transform = open ? "rotate(0deg)" : "rotate(90deg)";
        if (!open && !body.dataset.built) { body.innerHTML = ""; body.appendChild(builder()); body.dataset.built = "1"; }
    };
    wrap.appendChild(head); wrap.appendChild(body); return wrap;
}

// v3.3: Group builder — wraps multiple section() accordions into a bordered group
function sectionGroup(label, sections) {
    const group = document.createElement("div"); group.className = "grouped-section";
    const lbl = document.createElement("div"); lbl.className = "group-label"; lbl.textContent = label;
    group.appendChild(lbl);
    sections.forEach(s => group.appendChild(s));
    return group;
}

function renderDetailPane() {
    if (!detailPaneEl) return;
    if (!selectedItemId) { detailPaneEl.innerHTML = '<div style="height:300px; display:flex; align-items:center; justify-content:center; color:#9CA3AF; border:1px dashed #E5E7EB; border-radius:12px;">Select a special to edit details</div>'; return; }
    const [, name] = selectedItemId.split(/-(.+)/);
    if (!name) { detailPaneEl.innerHTML = "<p class='muted'>Invalid selection.</p>"; selectedItemId = null; return; }
    let item = specialActivities.find(s => s.name === name);
    let isRainyDayItem = false;
    if (!item) { item = rainyDayActivities.find(s => s.name === name); isRainyDayItem = true; }
    if (!item) { detailPaneEl.innerHTML = "<p class='muted'>Not found.</p>"; selectedItemId = null; return; }
    detailPaneEl.innerHTML = "";

    // HEADER
    const header = document.createElement("div");
    header.style.cssText = "display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;";
    const titleContainer = document.createElement("div");
    titleContainer.style.cssText = "display:flex; align-items:center; gap:10px;";
    const title = document.createElement("h2");
    title.textContent = item.name; title.style.margin = "0"; title.style.fontSize = "1.25rem"; title.title = "Double click to rename";
    makeEditable(title, newName => {
        if (!newName.trim()) return;
        const oldName = item.name; if (oldName === newName) return;
        if (specialActivities.some(s => s !== item && s.name.toLowerCase() === newName.toLowerCase()) || rainyDayActivities.some(s => s !== item && s.name.toLowerCase() === newName.toLowerCase())) { alert('Already exists.'); return; }
        item.name = newName; selectedItemId = 'special-' + newName;
        propagateSpecialActivityRename(oldName, newName);
        saveData(); renderMasterList(); renderRainyDayList(); renderDetailPane();
    });
    titleContainer.appendChild(title);
    if (isRainyDayItem) {
        const badge = document.createElement("span");
        badge.style.cssText = "display:inline-flex; padding:4px 10px; background:linear-gradient(135deg, #0ea5e9, #0284c7); color:white; border-radius:999px; font-size:0.75rem; font-weight:600;";
        badge.textContent = "Rainy Day Only"; titleContainer.appendChild(badge);
    }
    const delBtn = document.createElement("button");
    delBtn.innerHTML = '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg> Delete';
    delBtn.style.cssText = "color:#DC2626; background:#FEF2F2; border:1px solid #FECACA; padding:6px 12px; border-radius:6px; cursor:pointer; display:flex; gap:6px; align-items:center;";
    delBtn.onclick = () => {
        if (window.AccessControl?.canEraseData && !window.AccessControl.canEraseData()) { window.AccessControl?.showPermissionDenied?.('delete special activities'); return; }
        if (!window.AccessControl?.checkSetupAccess?.('delete special activities')) return;
        if (confirm('Delete "' + item.name + '"?\n\nThis will also remove references from all schedules.')) {
            cleanupDeletedSpecialActivity(item.name);
            if (isRainyDayItem) rainyDayActivities = rainyDayActivities.filter(s => s.name !== item.name);
            else specialActivities = specialActivities.filter(s => s.name !== item.name);
            saveData(); selectedItemId = null; renderMasterList(); renderRainyDayList(); renderDetailPane();
        }
    };
    header.appendChild(titleContainer); header.appendChild(delBtn);
    detailPaneEl.appendChild(header);

    // AVAILABILITY STRIP
    const avail = document.createElement("div");
    avail.style.cssText = "padding:12px; border-radius:8px; margin-bottom:20px; font-size:0.9rem; display:flex; justify-content:space-between; background:" + (item.available ? "#e6f4f7" : "#FEF2F2") + "; border:1px solid " + (item.available ? "#b2dce6" : "#FECACA") + "; color:" + (item.available ? "#0A4A56" : "#991B1B") + ";";
    avail.innerHTML = '<span>Special is <strong>' + (item.available ? 'AVAILABLE' : 'UNAVAILABLE') + '</strong></span><span style="font-size:0.8rem; opacity:0.8;">Toggle in master list</span>';
    detailPaneEl.appendChild(avail);

    // v3.3: CONSOLIDATED ACCORDION GROUPS (4 groups instead of 8 sections)
    // Group 1: Scheduling Rules — location + sharing + access
    detailPaneEl.appendChild(sectionGroup("Scheduling Rules", [
        section("Field / Location", summaryLocation(item), () => renderLocationSettings(item)),
        section("Concurrent Use", summarySharing(item), () => renderSharing(item)),
        section("Division Access", summaryAccess(item), () => renderAccess(item))
    ]));

    // Group 2: Time & Weather — time rules + weather (weather only for non-rainy-day items)
    const timeWeatherSections = [section("Time Availability", summaryTime(item), () => renderTimeRules(item))];
    if (!isRainyDayItem) timeWeatherSections.push(section("Weather & Availability", summaryWeather(item), () => renderWeatherSettings(item)));
    detailPaneEl.appendChild(sectionGroup("Time & Weather", timeWeatherSections));

    // Group 3: Rotation Rules — usage limit + full grade + prep duration
    detailPaneEl.appendChild(sectionGroup("Rotation Rules", [
        section("Usage Limit", summaryMaxUsage(item), () => renderMaxUsageSettings(item)),
        section("Full Grade", summaryFullGrade(item), () => renderFullGradeSettings(item)),
        section("Prep Duration", (item.prepDuration > 0) ? item.prepDuration + 'min prep' : 'None', () => renderPrepDurationSettings(item))
    ]));
}

// =========================================================================
// SUMMARY HELPERS
// =========================================================================
function summaryMaxUsage(item) {
    var m = parseInt(item.maxUsage) || 0;
    if (m <= 0) return 'No limit';
    var period = item.maxUsagePeriod || 'half';
    var periodLabels = { 'half': 'per half', '1week': 'per week', '2weeks': 'per 2 weeks', '3weeks': 'per 3 weeks', '4weeks': 'per 4 weeks' };
    return 'Max ' + m + ' time' + (m > 1 ? 's' : '') + ' ' + (periodLabels[period] || 'per half');
}
function summaryFullGrade(item) { return item.fullGrade ? 'Entire grade does it together' : 'Off (normal rotation)'; }
function summarySharing(item) { if (!item.sharableWith || item.sharableWith.type === 'not_sharable') return "No sharing (1 bunk only)"; return 'Up to ' + (parseInt(item.sharableWith.capacity,10)||2) + ' bunks (same grade)'; }
function summaryAccess(item) { if (!item.limitUsage?.enabled) return "Open to all grades"; const c = Object.keys(item.limitUsage.divisions||{}).length; if (c===0) return "\u26A0 Restricted (none selected)"; return c + ' grade' + (c!==1?'s':'') + ' allowed' + (item.limitUsage.usePriority?" \u00B7 prioritized":""); }
function summaryTime(item) { const c = (item.timeRules||[]).length; return c ? c + ' rule(s) active' : "Available all day"; }
function summaryWeather(item) {
    let s = item.isIndoor ? 'Indoor · Rainy day available' : 'Outdoor · Disabled on rain';
    const overrides = [];
    if (item.rainyDayCapacity > 0) overrides.push('cap:' + item.rainyDayCapacity);
    if (item.rainyDayAvailableAllDay && (item.timeRules||[]).length > 0) overrides.push('bypass time rules');
    if (overrides.length > 0) s += ' · 🌧️ ' + overrides.join(', ');
    return s;
}
function summaryLocation(item) { return item.location || "No field assigned"; }

// =========================================================================
// RENDER: Full Grade Settings
// =========================================================================
function renderFullGradeSettings(item) {
    const container = document.createElement("div");
    const updateSummary = () => { const s = container.closest('.detail-section')?.querySelector('.detail-section-summary'); if (s) s.textContent = summaryFullGrade(item); };
    const modeWrap = document.createElement("div"); modeWrap.style.cssText = "display:flex; gap:12px; margin-bottom:16px;";
    const btnOff = document.createElement("button"); btnOff.textContent = "Normal Rotation";
    btnOff.style.cssText = 'flex:1; padding:8px; border-radius:6px; border:1px solid #E5E7EB; cursor:pointer; background:' + (!item.fullGrade ? '#e6f4f7' : '#fff') + '; color:' + (!item.fullGrade ? '#0F5F6E' : '#333') + '; border-color:' + (!item.fullGrade ? '#147D91' : '#E5E7EB') + '; font-weight:' + (!item.fullGrade ? '600' : '400') + ';';
    const btnOn = document.createElement("button"); btnOn.textContent = "Full Grade";
    btnOn.style.cssText = 'flex:1; padding:8px; border-radius:6px; border:1px solid #E5E7EB; cursor:pointer; background:' + (item.fullGrade ? '#e6f4f7' : '#fff') + '; color:' + (item.fullGrade ? '#0F5F6E' : '#333') + '; border-color:' + (item.fullGrade ? '#147D91' : '#E5E7EB') + '; font-weight:' + (item.fullGrade ? '600' : '400') + ';';
    btnOff.onclick = () => { item.fullGrade = false; saveData(); container.innerHTML = ''; container.appendChild(renderFullGradeSettings(item)); updateSummary(); };
    btnOn.onclick = () => { item.fullGrade = true; saveData(); container.innerHTML = ''; container.appendChild(renderFullGradeSettings(item)); updateSummary(); };
    modeWrap.appendChild(btnOff); modeWrap.appendChild(btnOn); container.appendChild(modeWrap);
    const note = document.createElement("div"); note.style.cssText = "color:#6B7280; font-size:0.8rem; padding:10px; background:#f0f9fb; border-radius:8px; line-height:1.5;";
    if (item.fullGrade) {
        note.innerHTML = '<strong>Full Grade mode:</strong> When the scheduler assigns this activity, <strong>every bunk in the grade</strong> will get it in the same time slot. The whole grade does it once together.';
    } else {
        note.innerHTML = '<strong>Normal mode:</strong> Bunks are assigned this activity individually through the regular rotation.';
    }
    container.appendChild(note);
    return container;
}

// =========================================================================
// RENDER: Max Usage Settings — v3.3 rewrite with period dropdown
// =========================================================================
function renderMaxUsageSettings(item) {
    const container = document.createElement("div");
    const updateSummary = () => {
        const s = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if (s) s.textContent = summaryMaxUsage(item);
    };

    const currentVal = parseInt(item.maxUsage) || 0;
    const isEnabled = currentVal > 0;

    // Toggle row
    const toggleRow = document.createElement("div");
    toggleRow.style.cssText = "display:flex; align-items:center; gap:10px; margin-bottom:16px;";
    const tog = document.createElement("label"); tog.className = "switch";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = isEnabled;
    const sl = document.createElement("span"); sl.className = "slider";
    tog.appendChild(cb); tog.appendChild(sl);
    const label = document.createElement("span");
    label.style.cssText = "font-weight:500; font-size:0.9rem;";
    label.textContent = "Limit how many times a bunk can do this";
    toggleRow.appendChild(tog); toggleRow.appendChild(label);
    container.appendChild(toggleRow);

    const detailDiv = document.createElement("div");
    detailDiv.style.cssText = "margin-top:4px; padding-left:12px; border-left:2px solid #147D91;";

    const renderDetails = () => {
        detailDiv.innerHTML = "";
        if (!cb.checked) {
            detailDiv.style.display = "none";
            return;
        }
        detailDiv.style.display = "block";

        // Max count row
        const row = document.createElement("div");
        row.style.cssText = "display:flex; align-items:center; gap:8px; margin-bottom:12px;";
        row.innerHTML = '<span style="font-size:0.85rem;">Max times per bunk:</span>';
        const numIn = document.createElement("input");
        numIn.type = "number"; numIn.min = "1"; numIn.max = "50";
        numIn.value = parseInt(item.maxUsage) || 1;
        numIn.style.cssText = "width:60px; padding:4px; border-radius:6px; border:1px solid #D1D5DB; text-align:center;";
        numIn.onchange = () => {
            item.maxUsage = Math.min(50, Math.max(1, parseInt(numIn.value) || 1));
            numIn.value = item.maxUsage;
            saveData();
            updateNote();
            updateSummary();
        };
        row.appendChild(numIn);
        detailDiv.appendChild(row);

        // Period dropdown row
        const periodRow = document.createElement("div");
        periodRow.style.cssText = "display:flex; align-items:center; gap:8px; margin-bottom:12px;";
        periodRow.innerHTML = '<span style="font-size:0.85rem;">Reset period:</span>';
        const periodSel = document.createElement("select");
        periodSel.style.cssText = "padding:5px 8px; border-radius:6px; border:1px solid #D1D5DB; font-size:0.85rem; background:white; cursor:pointer;";
        const periods = [
            { value: 'half', label: 'Entire half (no reset)' },
            { value: '1week', label: 'Every week' },
            { value: '2weeks', label: 'Every 2 weeks' },
            { value: '3weeks', label: 'Every 3 weeks' },
            { value: '4weeks', label: 'Every 4 weeks' }
        ];
        periods.forEach(p => {
            const opt = document.createElement("option");
            opt.value = p.value; opt.textContent = p.label;
            if ((item.maxUsagePeriod || 'half') === p.value) opt.selected = true;
            periodSel.appendChild(opt);
        });
        periodSel.onchange = () => {
            item.maxUsagePeriod = periodSel.value;
            saveData();
            updateNote();
            updateSummary();
        };
        periodRow.appendChild(periodSel);
        detailDiv.appendChild(periodRow);

        // Explanation note
        const note = document.createElement("div");
        note.id = "max-usage-note";
        note.style.cssText = "color:#6B7280; font-size:0.8rem; padding:10px; background:#f0f9fb; border-radius:8px; line-height:1.5;";
        detailDiv.appendChild(note);

        const updateNote = () => {
            const count = parseInt(item.maxUsage) || 1;
            const period = item.maxUsagePeriod || 'half';
            const periodTexts = {
                'half': 'across the entire half. Resets when you start a new half.',
                '1week': 'per week. Counter resets every Monday.',
                '2weeks': 'per 2-week period. Counter resets every other Monday.',
                '3weeks': 'per 3-week period.',
                '4weeks': 'per 4-week (monthly) period.'
            };
            const noteEl = detailDiv.querySelector('#max-usage-note');
            if (noteEl) {
                noteEl.innerHTML = 'Each bunk can be scheduled for <strong>' + count +
                    '</strong> time' + (count > 1 ? 's' : '') + ' max ' +
                    (periodTexts[period] || periodTexts['half']) +
                    '<br><span style="font-size:0.75rem; color:#9CA3AF;">Tracked via rotation history.</span>';
            }
        };
        updateNote();
    };

    cb.onchange = () => {
        if (cb.checked) {
            item.maxUsage = parseInt(item.maxUsage) || 1;
        } else {
            item.maxUsage = null;
        }
        saveData();
        renderDetails();
        updateSummary();
    };

    container.appendChild(detailDiv);
    renderDetails();
    return container;
}

// =========================================================================
// RENDER: Sharing — toggle pattern matching fields.js
// =========================================================================
function renderSharing(item) {
    const container = document.createElement("div");
    const updateSummary = () => { const s = container.closest('.detail-section')?.querySelector('.detail-section-summary'); if (s) s.textContent = summarySharing(item); };
    const renderContent = () => {
        container.innerHTML = "";
        const rules = item.sharableWith || { type: 'not_sharable', divisions: [], capacity: 2 };
        const isSharable = rules.type !== 'not_sharable';
        const toggleRow = document.createElement("div"); toggleRow.style.cssText = "display:flex; align-items:center; gap:10px; margin-bottom:16px;";
        const tog = document.createElement("label"); tog.className = "switch";
        const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = isSharable;
        cb.onchange = () => {
            if (cb.checked) { rules.type = 'same_division'; rules.capacity = rules.capacity > 1 ? rules.capacity : 2; }
            else { rules.type = 'not_sharable'; rules.capacity = 1; }
            rules.divisions = []; item.sharableWith = rules; saveData(); renderContent(); updateSummary();
        };
        const sl = document.createElement("span"); sl.className = "slider"; tog.appendChild(cb); tog.appendChild(sl);
        const label = document.createElement("span"); label.style.cssText = "font-weight:500; font-size:0.9rem;"; label.textContent = "Allow Sharing";
        toggleRow.appendChild(tog); toggleRow.appendChild(label); container.appendChild(toggleRow);
        if (!isSharable) { const n = document.createElement("div"); n.style.cssText = "color:#6B7280; font-size:0.85rem; padding:10px; background:#F9FAFB; border-radius:8px;"; n.textContent = "Only 1 bunk can use this activity at a time."; container.appendChild(n); }
        else {
            const det = document.createElement("div"); det.style.cssText = "margin-top:4px; padding-left:12px; border-left:2px solid #147D91;";
            const capRow = document.createElement("div"); capRow.style.cssText = "display:flex; align-items:center; gap:8px; margin-bottom:12px;";
            capRow.innerHTML = '<span style="font-size:0.85rem;">Max bunks at once:</span>';
            const capIn = document.createElement("input"); capIn.type = "number"; capIn.min = "2"; capIn.max = "20"; capIn.value = rules.capacity || 2;
            capIn.style.cssText = "width:60px; padding:4px; border-radius:6px; border:1px solid #D1D5DB; text-align:center;";
            capIn.onchange = () => { rules.capacity = Math.min(20, Math.max(2, parseInt(capIn.value)||2)); capIn.value = rules.capacity; item.sharableWith = rules; saveData(); updateSummary(); };
            capRow.appendChild(capIn); det.appendChild(capRow);
            const note = document.createElement("div"); note.style.cssText = "color:#6B7280; font-size:0.8rem; padding:10px; background:#f0f9fb; border-radius:8px; line-height:1.5;";
            note.innerHTML = 'Up to <strong>' + (rules.capacity||2) + '</strong> bunks <strong>within the same grade</strong> can use this simultaneously.';
            det.appendChild(note); container.appendChild(det);
        }
    };
    renderContent(); return container;
}

// =========================================================================
// RENDER: Access — grade chips + priority
// =========================================================================
function renderAccess(item) {
    const container = document.createElement("div");
    const updateSummary = () => { const s = container.closest('.detail-section')?.querySelector('.detail-section-summary'); if (s) s.textContent = summaryAccess(item); };
    const renderContent = () => {
        container.innerHTML = "";
        const rules = item.limitUsage || { enabled: false, divisions: {}, priorityList: [], usePriority: false };
        if (!rules.priorityList) rules.priorityList = Object.keys(rules.divisions || {});
        if (rules.usePriority === undefined) rules.usePriority = false;
        const modeWrap = document.createElement("div"); modeWrap.style.cssText = "display:flex; gap:12px; margin-bottom:16px;";
        const btnAll = document.createElement("button"); btnAll.textContent = "Open to All Grades";
        btnAll.style.cssText = 'flex:1; padding:8px; border-radius:6px; border:1px solid #E5E7EB; cursor:pointer; background:' + (!rules.enabled ? '#e6f4f7' : '#fff') + '; color:' + (!rules.enabled ? '#0F5F6E' : '#333') + '; border-color:' + (!rules.enabled ? '#147D91' : '#E5E7EB') + '; font-weight:' + (!rules.enabled ? '600' : '400') + ';';
        const btnRes = document.createElement("button"); btnRes.textContent = "Specific Grades Only";
        btnRes.style.cssText = 'flex:1; padding:8px; border-radius:6px; border:1px solid #E5E7EB; cursor:pointer; background:' + (rules.enabled ? '#e6f4f7' : '#fff') + '; color:' + (rules.enabled ? '#0F5F6E' : '#333') + '; border-color:' + (rules.enabled ? '#147D91' : '#E5E7EB') + '; font-weight:' + (rules.enabled ? '600' : '400') + ';';
        btnAll.onclick = () => { rules.enabled = false; item.limitUsage = rules; saveData(); renderContent(); updateSummary(); };
        btnRes.onclick = () => { rules.enabled = true; item.limitUsage = rules; saveData(); renderContent(); updateSummary(); };
        modeWrap.appendChild(btnAll); modeWrap.appendChild(btnRes); container.appendChild(modeWrap);
        const allDivs = Object.keys(window.loadGlobalSettings?.()?.divisions || {});
        if (rules.enabled) {
            const body = document.createElement("div"); body.style.cssText = "padding-left:12px; border-left:2px solid #147D91; margin-bottom:16px;";
            const chipLabel = document.createElement("div"); chipLabel.style.cssText = "font-size:0.85rem; font-weight:500; margin-bottom:8px; color:#374151;"; chipLabel.textContent = "Select allowed grades:"; body.appendChild(chipLabel);
            const chipWrap = document.createElement("div"); chipWrap.style.cssText = "display:flex; flex-wrap:wrap; gap:4px; margin-bottom:8px;";
            allDivs.forEach(divName => {
                const isAllowed = !!rules.divisions[divName];
                const c = document.createElement("span"); c.className = "chip " + (isAllowed ? "active" : "inactive"); c.textContent = divName;
                c.onclick = () => { if (isAllowed) { delete rules.divisions[divName]; rules.priorityList = rules.priorityList.filter(d=>d!==divName); } else { rules.divisions[divName] = []; if (!rules.priorityList.includes(divName)) rules.priorityList.push(divName); } item.limitUsage = rules; saveData(); renderContent(); updateSummary(); };
                chipWrap.appendChild(c);
            });
            body.appendChild(chipWrap);
            if (Object.keys(rules.divisions).length === 0) { const w = document.createElement("div"); w.style.cssText = "color:#DC2626; font-size:0.8rem; padding:8px; background:#FEF2F2; border-radius:6px;"; w.textContent = "No grades selected."; body.appendChild(w); }
            container.appendChild(body);
        }
        const availableGrades = rules.enabled ? Object.keys(rules.divisions) : allDivs;
        if (availableGrades.length >= 2) {
            const ps = document.createElement("div"); ps.style.cssText = "border:1px solid #E5E7EB; border-radius:10px; padding:14px; background:#FAFAFA;";
            const ptr = document.createElement("div"); ptr.style.cssText = "display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;";
            const pl = document.createElement("span"); pl.style.cssText = "font-weight:600; font-size:0.9rem;"; pl.textContent = "Priority Order";
            const pt = document.createElement("label"); pt.className = "switch"; const pc = document.createElement("input"); pc.type = "checkbox"; pc.checked = rules.usePriority === true;
            pc.onchange = () => { rules.usePriority = pc.checked; if (pc.checked && rules.priorityList.length === 0) rules.priorityList = [...availableGrades]; item.limitUsage = rules; saveData(); renderContent(); updateSummary(); };
            const psl = document.createElement("span"); psl.className = "slider"; pt.appendChild(pc); pt.appendChild(psl);
            ptr.appendChild(pl); ptr.appendChild(pt); ps.appendChild(ptr);
            const pd = document.createElement("div"); pd.style.cssText = "font-size:0.8rem; color:#6B7280; margin-bottom:10px;";
            pd.textContent = rules.usePriority ? "Higher = first access." : "No preference."; ps.appendChild(pd);
            if (rules.usePriority) {
                const vp = rules.priorityList.filter(d=>availableGrades.includes(d));
                const ms = availableGrades.filter(d=>!vp.includes(d));
                rules.priorityList = [...vp, ...ms];
                const le = document.createElement("div"); le.style.cssText = "display:flex; flex-direction:column; gap:4px;";
                rules.priorityList.forEach((dn, idx) => {
                    const row = document.createElement("div"); row.style.cssText = "display:flex; align-items:center; gap:8px; padding:6px 10px; background:#fff; border:1px solid #E5E7EB; border-radius:6px;";
                    const num = document.createElement("span"); num.style.cssText = "width:20px; text-align:center; font-weight:600; color:#147D91;"; num.textContent = idx+1;
                    const ne = document.createElement("span"); ne.style.cssText = "flex:1; font-size:0.85rem;"; ne.textContent = dn;
                    const bu = document.createElement("button"); bu.textContent = "\u2191"; bu.style.cssText = "border:1px solid #D1D5DB; background:#fff; border-radius:4px; width:24px; height:24px; cursor:pointer;"; bu.disabled = idx===0; if(idx===0)bu.style.opacity="0.3";
                    bu.onclick = () => { [rules.priorityList[idx-1],rules.priorityList[idx]]=[rules.priorityList[idx],rules.priorityList[idx-1]]; item.limitUsage=rules; saveData(); renderContent(); updateSummary(); };
                    const bd = document.createElement("button"); bd.textContent = "\u2193"; bd.style.cssText = "border:1px solid #D1D5DB; background:#fff; border-radius:4px; width:24px; height:24px; cursor:pointer;"; bd.disabled = idx===rules.priorityList.length-1; if(idx===rules.priorityList.length-1)bd.style.opacity="0.3";
                    bd.onclick = () => { [rules.priorityList[idx],rules.priorityList[idx+1]]=[rules.priorityList[idx+1],rules.priorityList[idx]]; item.limitUsage=rules; saveData(); renderContent(); updateSummary(); };
                    row.appendChild(num); row.appendChild(ne); row.appendChild(bu); row.appendChild(bd); le.appendChild(row);
                });
                ps.appendChild(le);
            }
            container.appendChild(ps);
        }
    };
    renderContent(); return container;
}

// =========================================================================
// RENDER: Time Rules, Location, Weather, Prep, Add/Delete, Cleanup, Helpers
// =========================================================================
function renderTimeRules(item) {
    const container = document.createElement("div");
    if (item.timeRules && item.timeRules.length > 0) {
        item.timeRules.forEach((r, i) => {
            const row = document.createElement("div"); row.style.cssText = "display:flex; justify-content:space-between; align-items:center; background:#F9FAFB; padding:8px; margin-bottom:6px; border-radius:6px; border:1px solid #E5E7EB;";
            const ls = document.createElement("div"); ls.style.flex = "1";
            ls.innerHTML = '<strong style="color:' + (r.type==='Available'?'#0F6A7A':'#DC2626') + '">' + escapeHtml(r.type) + '</strong>: ' + escapeHtml(r.start) + ' to ' + escapeHtml(r.end);
            if (r.divisions && r.divisions.length > 0) { const di = document.createElement("div"); di.style.cssText = "font-size:0.75rem; color:#6B7280; margin-top:4px;"; di.innerHTML = r.divisions.map(d => '<span style="background:#e6f4f7;color:#0F5F6E;padding:2px 6px;border-radius:999px;font-size:0.7rem;margin-right:3px;">'+escapeHtml(d)+'</span>').join(''); ls.appendChild(di); }
            const del = document.createElement("button"); del.textContent = "\u2715"; del.style.cssText = "border:none; background:transparent; color:#9CA3AF; cursor:pointer;";
            del.onclick = () => { item.timeRules.splice(i,1); saveData(); renderDetailPane(); };
            row.appendChild(ls); row.appendChild(del); container.appendChild(row);
        });
    } else { container.innerHTML = '<div class="muted" style="font-size:0.8rem; margin-bottom:10px;">No specific time rules.</div>'; }
    const as = document.createElement("div"); as.style.cssText = "margin-top:12px; padding-top:12px; border-top:1px dashed #E5E7EB;";
    const ar = document.createElement("div"); ar.style.cssText = "display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:8px;";
    const ts = document.createElement("select"); ts.innerHTML = '<option>Available</option><option>Unavailable</option>'; ts.style.cssText = "border-radius:6px; border:1px solid #D1D5DB; padding:4px;";
    const si = document.createElement("input"); si.placeholder = "9:00am"; si.style.cssText = "width:70px; padding:4px; border-radius:6px; border:1px solid #D1D5DB;";
    const ei = document.createElement("input"); ei.placeholder = "10:00am"; ei.style.cssText = "width:70px; padding:4px; border-radius:6px; border:1px solid #D1D5DB;";
    ar.appendChild(ts); ar.appendChild(si); ar.appendChild(document.createTextNode(" to ")); ar.appendChild(ei); as.appendChild(ar);
    const dr = document.createElement("div"); dr.style.cssText = "display:flex; align-items:center; gap:8px; margin-bottom:8px; flex-wrap:wrap;";
    const dl = document.createElement("span"); dl.style.cssText = "font-size:0.8rem; color:#6B7280;"; dl.textContent = "Applies to:"; dr.appendChild(dl);
    const agb = document.createElement("button"); agb.textContent = "All Grades"; agb.style.cssText = "padding:4px 10px; border-radius:6px; border:1px solid #147D91; background:#e6f4f7; color:#0F5F6E; font-size:0.8rem; cursor:pointer; font-weight:600;";
    const spb = document.createElement("button"); spb.textContent = "Specific Grades"; spb.style.cssText = "padding:4px 10px; border-radius:6px; border:1px solid #E5E7EB; background:#fff; color:#333; font-size:0.8rem; cursor:pointer;";
    let selDivs = [];
    const dcw = document.createElement("div"); dcw.style.cssText = "display:none; flex-wrap:wrap; gap:4px; margin-top:6px; margin-bottom:8px; width:100%;";
    const allDivs = window.availableDivisions || Object.keys(window.loadGlobalSettings?.()?.divisions || {});
    function rebuildDC() { dcw.innerHTML = ""; allDivs.forEach(d => { const a = selDivs.includes(d); const c = document.createElement("span"); c.className = "chip " + (a?"active":"inactive"); c.textContent = d; c.onclick = () => { if(a) selDivs=selDivs.filter(x=>x!==d); else selDivs.push(d); rebuildDC(); }; dcw.appendChild(c); }); }
    agb.onclick = () => { selDivs=[]; agb.style.cssText="padding:4px 10px; border-radius:6px; border:1px solid #147D91; background:#e6f4f7; color:#0F5F6E; font-size:0.8rem; cursor:pointer; font-weight:600;"; spb.style.cssText="padding:4px 10px; border-radius:6px; border:1px solid #E5E7EB; background:#fff; color:#333; font-size:0.8rem; cursor:pointer;"; dcw.style.display="none"; };
    spb.onclick = () => { spb.style.cssText="padding:4px 10px; border-radius:6px; border:1px solid #147D91; background:#e6f4f7; color:#0F5F6E; font-size:0.8rem; cursor:pointer; font-weight:600;"; agb.style.cssText="padding:4px 10px; border-radius:6px; border:1px solid #E5E7EB; background:#fff; color:#333; font-size:0.8rem; cursor:pointer;"; dcw.style.display="flex"; rebuildDC(); };
    dr.appendChild(agb); dr.appendChild(spb); as.appendChild(dr); as.appendChild(dcw);
    const btn = document.createElement("button"); btn.textContent = "Add"; btn.style.cssText = "background:#111; color:white; border:none; border-radius:6px; padding:4px 12px; cursor:pointer;";
    btn.onclick = () => {
        if (!si.value || !ei.value) { alert("Enter both times."); return; }
        const sm = parseTimeToMinutes(si.value), em = parseTimeToMinutes(ei.value);
        if (sm===null||em===null) { alert("Invalid time format."); return; }
        if (sm >= em) { alert("End time must be after start time."); return; }
        const nr = { type: ts.value, start: si.value, end: ei.value, startMin: sm, endMin: em };
        if (selDivs.length > 0) nr.divisions = [...selDivs];
        item.timeRules.push(nr); saveData(); renderDetailPane();
    };
    as.appendChild(btn); container.appendChild(as); return container;
}

function renderLocationSettings(item) {
    const container = document.createElement("div");
    const updateSummary = () => { const s = container.closest('.detail-section')?.querySelector('.detail-section-summary'); if(s) s.textContent = summaryLocation(item); };
    const renderContent = () => {
        container.innerHTML = "";
        const desc = document.createElement("p"); desc.style.cssText = "font-size:0.85rem; color:#6b7280; margin:0 0 12px 0;";
        desc.textContent = "Assign a field or facility. When scheduled, that field will be locked."; container.appendChild(desc);
        if (item.location) {
            const cur = document.createElement("div"); cur.style.cssText = "display:flex; align-items:center; gap:10px; padding:12px; background:#f0f9fb; border:1px solid #b2dce6; border-radius:10px; margin-bottom:12px;";
            cur.innerHTML = '<div style="flex:1;"><div style="font-weight:600; color:#0A4A56;">' + escapeHtml(item.location) + '</div><div style="font-size:0.8rem; color:#0F5F6E;">Locked when scheduled</div></div>';
            const cb = document.createElement("button"); cb.textContent = "\u2715 Remove"; cb.style.cssText = "padding:4px 10px; background:#fef2f2; color:#dc2626; border:1px solid #fecaca; border-radius:6px; cursor:pointer; font-size:0.8rem;";
            cb.onclick = () => { item.location = null; saveData(); renderContent(); updateSummary(); }; cur.appendChild(cb); container.appendChild(cur);
        }
        const sel = document.createElement("select"); sel.style.cssText = "width:100%; padding:8px 10px; border:1px solid #E5E7EB; border-radius:8px; font-size:0.9rem; background:white; cursor:pointer;";
        const dopt = document.createElement("option"); dopt.value = ""; dopt.textContent = "-- None --"; sel.appendChild(dopt);
        const sf = window.loadGlobalSettings?.() || {};
        const allF = sf.app1?.fields || sf.fields || window.getFields?.() || [];
        if (allF.length > 0) {
            const fg = document.createElement("optgroup"); fg.label = "Fields";
            allF.sort((a,b)=>(a.name||'').localeCompare(b.name||'')).forEach(f => { if(!f.name)return; const o=document.createElement("option"); o.value=f.name; o.textContent=f.name+(f.rainyDayAvailable?' (indoor)':''); if(item.location===f.name) o.selected=true; fg.appendChild(o); });
            sel.appendChild(fg);
        }
        const zones = sf.locationZones || {}; const facs = [];
        Object.entries(zones).forEach(([zn,z]) => { if(!z||typeof z!=='object')return; Object.keys(z.locations||{}).forEach(ln => { facs.push({name:ln,zone:zn}); }); });
        if (facs.length > 0) { const facG = document.createElement("optgroup"); facG.label = "Facilities"; facs.sort((a,b)=>a.name.localeCompare(b.name)).forEach(f => { const o=document.createElement("option"); o.value=f.name; o.textContent=f.name+' ('+f.zone+')'; if(item.location===f.name) o.selected=true; facG.appendChild(o); }); sel.appendChild(facG); }
        sel.onchange = () => { item.location = sel.value || null; saveData(); renderContent(); updateSummary(); };
        container.appendChild(sel);
    };
    renderContent(); return container;
}

function renderWeatherSettings(item) {
    const container = document.createElement("div");
    const isIndoor = item.isIndoor === true;
    const updateSummary = () => { const s = container.closest('.detail-section')?.querySelector('.detail-section-summary'); if(s) s.textContent = summaryWeather(item); };
    // Indoor/Outdoor toggle section
    const indoorHtml = '<div style="margin-bottom:16px;">'
        + '<p style="font-size:0.85rem; color:#6b7280; margin:0 0 12px 0;">Mark as indoor to keep available during Rainy Day Mode.</p>'
        + '<div style="display:flex; align-items:center; gap:12px; padding:14px; background:' + (isIndoor ? '#e6f4f7' : '#fef3c7') + '; border:1px solid ' + (isIndoor ? '#b2dce6' : '#fcd34d') + '; border-radius:10px;">'
        + '<span style="font-size:28px;">' + (isIndoor ? '\uD83C\uDFE0' : '\uD83C\uDF33') + '</span>'
        + '<div style="flex:1;">'
        + '<div style="font-weight:600; color:' + (isIndoor ? '#0A4A56' : '#92400e') + ';">' + (isIndoor ? 'Indoor' : 'Outdoor') + '</div>'
        + '<div style="font-size:0.85rem; color:' + (isIndoor ? '#0F5F6E' : '#b45309') + ';">' + (isIndoor ? 'Available on rainy days' : 'Disabled during rainy days') + '</div>'
        + '</div>'
        + '<label class="switch"><input type="checkbox" id="weather-toggle" ' + (isIndoor ? 'checked' : '') + '><span class="slider"></span></label>'
        + '</div></div>';
    // Rainy Day Overrides section (capacity + time bypass) — matches fields.js
    const regularCapacity = parseInt(item.sharableWith?.capacity) || 1;
    const hasTimeRules = (item.timeRules || []).length > 0;
    const overridesHtml = '<div style="margin-top:20px; padding-top:16px; border-top:1px solid #e5e7eb;">'
        + '<div style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">'
        + '<span style="font-size:1.1rem;">\uD83C\uDF27\uFE0F</span>'
        + '<div style="font-weight:600; font-size:0.95rem; color:#1e293b;">Rainy Day Overrides</div>'
        + '</div>'
        // Capacity Override
        + '<div style="background:#f0f9ff; border:1px solid #bae6fd; border-radius:10px; padding:14px; margin-bottom:12px;">'
        + '<div style="font-weight:600; font-size:0.9rem; color:#0c4a6e; margin-bottom:8px;">'
        + '\uD83D\uDCCA Capacity Override'
        + '<span style="font-weight:400; font-size:0.8rem; color:#0369a1;"> (regular: ' + regularCapacity + ')</span>'
        + '</div>'
        + '<div style="display:flex; align-items:center; gap:10px;">'
        + '<label style="font-size:0.85rem; color:#334155;">Rainy day capacity:</label>'
        + '<input type="number" id="rainy-day-capacity-input" min="1" max="20" placeholder="Same" value="' + (item.rainyDayCapacity || '') + '" style="width:70px; padding:6px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:0.9rem;">'
        + '<span style="font-size:0.8rem; color:#64748b;">bunks</span>'
        + '</div>'
        + '<div style="font-size:0.75rem; color:#64748b; margin-top:6px;">Leave empty = use regular capacity.</div>'
        + '</div>'
        // Ignore Time Restrictions
        + '<div style="background:#fefce8; border:1px solid #fde68a; border-radius:10px; padding:14px;">'
        + '<div style="display:flex; align-items:center; justify-content:space-between;">'
        + '<div>'
        + '<div style="font-weight:600; font-size:0.9rem; color:#713f12;">\u23F0 Ignore Time Restrictions on Rain Days</div>'
        + '<div style="font-size:0.8rem; color:#a16207;">' + (hasTimeRules ? (item.timeRules.length + ' time rule(s) can be bypassed') : 'No time restrictions configured') + '</div>'
        + '</div>'
        + '<label class="switch"><input type="checkbox" id="rainy-day-all-day-toggle" ' + (item.rainyDayAvailableAllDay ? 'checked' : '') + ' ' + (!hasTimeRules ? 'disabled' : '') + '><span class="slider"></span></label>'
        + '</div></div>'
        + '</div>';
    container.innerHTML = indoorHtml + overridesHtml;
    // Bind indoor toggle
    const tog = container.querySelector('#weather-toggle');
    if (tog) {
        tog.onchange = function() {
            item.isIndoor = this.checked;
            item.rainyDayAvailable = this.checked;
            item.availableOnRainyDay = this.checked;
            saveData();
            const p = container.parentElement;
            if (p) { p.innerHTML = ''; p.appendChild(renderWeatherSettings(item)); }
            updateSummary();
            renderMasterList();
        };
    }
    // Bind capacity override
    const capInput = container.querySelector('#rainy-day-capacity-input');
    if (capInput) {
        capInput.addEventListener('change', function() {
            const val = this.value.trim();
            if (val === '' || val === '0') {
                delete item.rainyDayCapacity;
                item.rainyDayCapacity = null;
            } else {
                const parsed = parseInt(val, 10);
                if (!isNaN(parsed) && parsed > 0 && parsed <= 20) {
                    item.rainyDayCapacity = parsed;
                } else {
                    alert('Enter a number between 1 and 20.');
                    this.value = item.rainyDayCapacity || '';
                    return;
                }
            }
            saveData();
            updateSummary();
        });
    }
    // Bind all-day toggle
    const allDayTog = container.querySelector('#rainy-day-all-day-toggle');
    if (allDayTog) {
        allDayTog.addEventListener('change', function() {
            item.rainyDayAvailableAllDay = this.checked;
            saveData();
            updateSummary();
        });
    }
    return container;
}

function renderPrepDurationSettings(item) {
    const container = document.createElement("div");
    const hp = (item.prepDuration||0) > 0;
    container.innerHTML = '<div style="margin-bottom:16px;"><p style="font-size:0.85rem; color:#6b7280; margin:0 0 12px 0;">Some activities need prep time. Example: <strong>Skits</strong> = 30min practice + 60min performance.</p><div style="background:' + (hp?'#faf5ff':'#f9fafb') + '; border:1px solid ' + (hp?'#d8b4fe':'#e5e7eb') + '; border-radius:10px; padding:14px;"><div style="display:flex; align-items:center; gap:12px; margin-bottom:' + (hp?'12px':'0') + ';"><div style="flex:1;"><div style="font-weight:600; color:' + (hp?'#6b21a8':'#374151') + ';">' + (hp?'Has Prep Phase':'Single Phase') + '</div><div style="font-size:0.8rem; color:' + (hp?'#7c3aed':'#6b7280') + ';">' + (hp?item.prepDuration+' min prep + main':'No prep needed') + '</div></div><label class="switch"><input type="checkbox" id="prep-duration-toggle" ' + (hp?'checked':'') + '><span class="slider"></span></label></div><div id="prep-duration-config" style="display:' + (hp?'block':'none') + ';"><div style="display:flex; align-items:center; gap:10px; padding:10px; background:white; border-radius:8px; border:1px solid #e9d5ff;"><label style="font-size:0.85rem;">Prep time:</label><input type="number" id="prep-duration-input" min="5" max="120" step="5" value="' + (item.prepDuration||30) + '" style="width:70px; padding:6px 10px; border:1px solid #d8b4fe; border-radius:6px; text-align:center;"><span style="font-size:0.85rem; color:#64748b;">minutes</span></div></div></div></div>';
    const pt = container.querySelector("#prep-duration-toggle");
    if (pt) { pt.addEventListener("change", function() { const c = container.querySelector("#prep-duration-config"); if(this.checked){c.style.display="block";item.prepDuration=parseInt(container.querySelector("#prep-duration-input").value,10)||30;}else{c.style.display="none";item.prepDuration=0;} saveData(); const s=container.closest('.detail-section')?.querySelector('.detail-section-summary'); if(s)s.textContent=(item.prepDuration>0)?item.prepDuration+'min prep':'None'; }); }
    const di = container.querySelector("#prep-duration-input");
    if (di) { di.addEventListener("change", function() { const v=parseInt(this.value,10); if(!isNaN(v)&&v>=5&&v<=120){item.prepDuration=v;saveData();const s=container.closest('.detail-section')?.querySelector('.detail-section-summary');if(s)s.textContent=v+'min prep';} }); }
    return container;
}

function addSpecial() { if(!window.AccessControl?.checkSetupAccess?.('add special activities'))return; if(!addSpecialInput)return; const n=addSpecialInput.value.trim(); if(!n)return; if(specialActivities.some(s=>s.name.toLowerCase()===n.toLowerCase())||rainyDayActivities.some(s=>s.name.toLowerCase()===n.toLowerCase())){alert("Already exists.");return;} specialActivities.push(createDefaultActivity(n)); addSpecialInput.value=""; saveData(); selectedItemId='special-'+n; renderMasterList(); renderRainyDayList(); renderDetailPane(); }
function addRainyDayActivity() { if(!window.AccessControl?.checkSetupAccess?.('add rainy day activities'))return; if(!addRainyDayInput)return; const n=addRainyDayInput.value.trim(); if(!n)return; if(specialActivities.some(s=>s.name.toLowerCase()===n.toLowerCase())||rainyDayActivities.some(s=>s.name.toLowerCase()===n.toLowerCase())){alert("Already exists.");return;} const a=createDefaultActivity(n); a.rainyDayExclusive=true; a.rainyDayOnly=true; a.isIndoor=true; rainyDayActivities.push(a); addRainyDayInput.value=""; saveData(); selectedItemId='special-'+n; renderMasterList(); renderRainyDayList(); renderDetailPane(); }

function cleanupDeletedSpecialActivity(name) { if(!name)return; try { const s=window.loadGlobalSettings?.()||{}; const ds=s.daily_schedules||{}; let c=0; Object.keys(ds).forEach(dk=>{const dd=ds[dk]; if(!dd?.scheduleAssignments)return; Object.keys(dd.scheduleAssignments).forEach(bk=>{const sl=dd.scheduleAssignments[bk]; if(!Array.isArray(sl))return; sl.forEach((s,i)=>{if(s?._activity===name||s?.activity===name||s?.event===name){dd.scheduleAssignments[bk][i]=null;c++;}});}); }); if(c>0)window.saveGlobalSettings?.('daily_schedules',ds); if(window.scheduleAssignments){Object.keys(window.scheduleAssignments).forEach(bk=>{const sl=window.scheduleAssignments[bk]; if(!Array.isArray(sl))return; sl.forEach((s,i)=>{if(s?._activity===name||s?.activity===name||s?.event===name)window.scheduleAssignments[bk][i]=null;});}); } if(window.activityProperties?.[name])delete window.activityProperties[name]; } catch(e){console.error('[SPECIAL_ACTIVITIES] Cleanup error:',e);} }
function propagateSpecialActivityRename(oldN,newN) { if(!oldN||!newN||oldN===newN)return; try { const s=window.loadGlobalSettings?.()||{}; const ds=s.daily_schedules||{}; let c=0; Object.keys(ds).forEach(dk=>{const dd=ds[dk]; if(!dd?.scheduleAssignments)return; Object.keys(dd.scheduleAssignments).forEach(bk=>{const sl=dd.scheduleAssignments[bk]; if(!Array.isArray(sl))return; sl.forEach((s,i)=>{if(s?._activity===oldN){dd.scheduleAssignments[bk][i]._activity=newN;c++;} if(s?.activity===oldN){dd.scheduleAssignments[bk][i].activity=newN;c++;} if(s?.event===oldN){dd.scheduleAssignments[bk][i].event=newN;c++;}});}); }); if(c>0)window.saveGlobalSettings?.('daily_schedules',ds); if(window.activityProperties?.[oldN]){window.activityProperties[newN]={...window.activityProperties[oldN]};delete window.activityProperties[oldN];} } catch(e){console.error('[SPECIAL_ACTIVITIES] Rename error:',e);} }

function escapeHtml(str) { if(str===null||str===undefined)return""; const d=document.createElement("div"); d.textContent=String(str); return d.innerHTML; }
function makeEditable(el,save) { if(!el)return; el.ondblclick=()=>{ const inp=document.createElement("input"); inp.value=el.textContent; inp.style.cssText="font-size:inherit;font-weight:inherit;border:1px solid #147D91;outline:none;border-radius:4px;padding:2px 6px;width:"+Math.max(100,el.offsetWidth+20)+"px;"; el.replaceWith(inp); inp.focus(); inp.select(); const finish=()=>{const v=inp.value.trim();if(v&&v!==el.textContent)save(v);else if(inp.parentNode)inp.replaceWith(el);}; inp.onblur=finish; inp.onkeyup=e=>{if(e.key==="Enter")finish();if(e.key==="Escape")inp.replaceWith(el);}; }; }
function parseTimeToMinutes(str) { if(!str||typeof str!=="string")return null; let s=str.trim().toLowerCase(); let mer=null; if(s.endsWith("am")||s.endsWith("pm")){mer=s.endsWith("am")?"am":"pm";s=s.replace(/am|pm/g,"").trim();} const m=s.match(/^(\d{1,2})\s*:\s*(\d{2})$/); if(!m)return null; let hh=parseInt(m[1],10); const mm=parseInt(m[2],10); if(Number.isNaN(hh)||Number.isNaN(mm)||mm<0||mm>59)return null; if(mer){if(hh===12)hh=mer==="am"?0:12;else if(mer==="pm")hh+=12;} return hh*60+mm; }

window.initSpecialActivitiesTab = initSpecialActivitiesTab;
Object.defineProperty(window,'specialActivities',{get:()=>specialActivities,set:v=>{specialActivities=v;},configurable:true});
Object.defineProperty(window,'rainyDayActivities',{get:()=>rainyDayActivities,set:v=>{rainyDayActivities=v;},configurable:true});
window.getSpecialActivities = () => [...specialActivities];
window.getRainyDayActivities = () => [...rainyDayActivities];
window.getAllSpecialActivities = function() {
    if((!specialActivities||specialActivities.length===0)&&(!rainyDayActivities||rainyDayActivities.length===0)){
        console.log('[SPECIAL_ACTIVITIES] Arrays empty - auto-loading from storage...');
        const settings=window.loadGlobalSettings?.()||{};
        const allActivities=settings.specialActivities||settings.app1?.specialActivities||[];
        if(allActivities.length>0){
            specialActivities=[];rainyDayActivities=[];
            allActivities.forEach(s=>{const v=validateSpecialActivity(s,s?.name);if(v.rainyDayExclusive||v.rainyDayOnly)rainyDayActivities.push(v);else specialActivities.push(v);});
            console.log(`[SPECIAL_ACTIVITIES] Auto-loaded ${specialActivities.length} regular + ${rainyDayActivities.length} rainy-only`);
        }
    }
    return[...specialActivities,...rainyDayActivities];
};
window.getSpecialActivityByName = function(name) { if(!name)return null; const n=String(name); let i=specialActivities.find(s=>s.name===n); if(!i)i=rainyDayActivities.find(s=>s.name===n); return i?{...i}:null; };
window.isRainyDayModeActive = function() { try{const d=window.loadCurrentDailyData?.()||{};return d.rainyDayMode===true||d.isRainyDay===true||window.isRainyDay===true;}catch(e){return window.isRainyDay===true;} };
window.getAvailableSpecialActivities = function() { const r=window.isRainyDayModeActive?.()||false; if(r){return[...specialActivities.filter(s=>s.available&&s.isIndoor===true),...rainyDayActivities.filter(s=>s.available)];} return specialActivities.filter(s=>s.available); };
window.getGlobalSpecialActivities = function(respectRainyDay=true) {
    const allActivities=[...specialActivities,...rainyDayActivities];
    if(!respectRainyDay)return allActivities;
    const isRainyMode=window.isRainyDayModeActive?.()||window.isRainyDay===true;
    if(isRainyMode){
        console.log('[SpecialActivities] Rainy mode - filtering for indoor/rainy activities');
        return allActivities.filter(s=>s.rainyDayOnly===true||s.rainyDayExclusive===true||s.isIndoor===true);
    }
    console.log('[SpecialActivities] Normal mode - excluding rainy-day-only activities');
    return allActivities.filter(s=>s.rainyDayOnly!==true&&s.rainyDayExclusive!==true);
};
window.getRainyDayOnlySpecials = function() { return rainyDayActivities.filter(s=>s.available!==false); };
window.getIndoorAvailableSpecials = function() { return specialActivities.filter(s=>s.available!==false&&s.isIndoor===true); };
window.getOutdoorSpecials = function() { return specialActivities.filter(s=>s.isIndoor!==true); };
window.cleanupSpecialActivitiesModule = function() { cleanupEventListeners(); cleanupTabListeners(); _isInitialized=false; };
window.refreshSpecialActivitiesFromStorage = function() { if(_isInitialized)refreshFromStorage(); };
window.validateSpecialActivities = function() { const a=window.getAllSpecialActivities?.()||[]; const v=validateAllActivities(a); let f=0; a.forEach((o,i)=>{if(JSON.stringify(o)!==JSON.stringify(v[i]))f++;}); if(f>0){loadData();if(_isInitialized){renderMasterList();renderRainyDayList();renderDetailPane();}} return{activitiesChecked:a.length,issuesFixed:f}; };
window.diagnoseSpecialActivities = function() {
    console.log('\n' + '='.repeat(60));
    console.log('SPECIAL ACTIVITIES DIAGNOSTICS');
    console.log('='.repeat(60));
    var settings = window.loadGlobalSettings?.() || {};
    var storedActivities = settings.specialActivities || settings.app1?.specialActivities || [];
    var divisions = Object.keys(settings.divisions || {});
    var isRainyMode = window.isRainyDayModeActive?.() || false;
    var indoorCount = specialActivities.filter(function(s){return s.isIndoor === true;}).length;
    var outdoorCount = specialActivities.filter(function(s){return s.isIndoor !== true;}).length;
    console.log('\nSUMMARY:');
    console.log('   Total activities: ' + storedActivities.length);
    console.log('   Regular specials: ' + specialActivities.length);
    console.log('      - Indoor: ' + indoorCount);
    console.log('      - Outdoor: ' + outdoorCount);
    console.log('   Rainy day specials: ' + rainyDayActivities.length);
    console.log('   Valid divisions: ' + (divisions.join(', ') || 'none'));
    console.log('   Rainy Day Mode: ' + (isRainyMode ? 'ACTIVE' : 'INACTIVE'));
    if (isRainyMode) { var availableNow = window.getGlobalSpecialActivities?.() || []; console.log('   Currently available specials: ' + availableNow.length); }
    var issues = [];
    storedActivities.forEach(function(a, idx) {
        var actIssues = [];
        if (!a.type || a.type !== 'Special') actIssues.push('Missing or incorrect type property (should be "Special")');
        if (!a.sharableWith) { actIssues.push('Missing sharableWith'); }
        else {
            if (!a.sharableWith.type) actIssues.push('sharableWith.type missing');
            if (!Array.isArray(a.sharableWith.divisions)) actIssues.push('sharableWith.divisions not array');
            if (a.sharableWith.capacity === undefined) actIssues.push('sharableWith.capacity missing');
            if (Array.isArray(a.sharableWith.divisions)) {
                var staleSharable = a.sharableWith.divisions.filter(function(d) { return !divisions.includes(d); });
                if (staleSharable.length > 0) actIssues.push('Stale sharableWith.divisions: ' + staleSharable.join(', '));
            }
        }
        if (!a.limitUsage) { actIssues.push('Missing limitUsage'); }
        else {
            if (a.limitUsage.enabled === undefined) actIssues.push('limitUsage.enabled missing');
            if (typeof a.limitUsage.divisions !== 'object') actIssues.push('limitUsage.divisions not object');
            if (!Array.isArray(a.limitUsage.priorityList)) actIssues.push('limitUsage.priorityList missing');
            if (typeof a.limitUsage.divisions === 'object' && a.limitUsage.divisions !== null) {
                var staleLimit = Object.keys(a.limitUsage.divisions).filter(function(d) { return !divisions.includes(d); });
                if (staleLimit.length > 0) actIssues.push('Stale limitUsage.divisions: ' + staleLimit.join(', '));
            }
        }
        if (!Array.isArray(a.timeRules)) { actIssues.push('timeRules not array'); }
        else { a.timeRules.forEach(function(rule, rIdx) { if (rule.startMin === undefined) actIssues.push('timeRules[' + rIdx + '].startMin missing'); if (rule.endMin === undefined) actIssues.push('timeRules[' + rIdx + '].endMin missing'); }); }
        if (a.isIndoor === undefined && !a.rainyDayExclusive && !a.rainyDayOnly) actIssues.push('isIndoor property missing (will default to true)');
        if (actIssues.length > 0) issues.push({ activity: a.name || '[index ' + idx + ']', issues: actIssues });
    });
    if (issues.length === 0) { console.log('\nAll special activities have valid structure!'); }
    else { console.log('\nISSUES FOUND (' + issues.length + ' activities):'); issues.forEach(function(item) { console.log('\n   ' + item.activity + ':'); item.issues.forEach(function(issue) { console.log('      - ' + issue); }); }); }
    console.log('\n' + '='.repeat(60));
    console.log('Run validateSpecialActivities() to auto-fix issues');
    console.log('='.repeat(60) + '\n');
    return { activities: storedActivities.length, issues: issues.length };
};

console.log("[SPECIAL_ACTIVITIES] Module v3.3 loaded");
})();
