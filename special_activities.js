// ============================================================================
// special_activities.js — PRODUCTION-READY v3.7
// ============================================================================
// v3.7: Multi-Part Specials — single activity with N parts, auto-tracked
// v3.4: Nested accordion layout
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

console.log("[SPECIAL_ACTIVITIES] Module v3.5 loading...");

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
       fullGrade: activity.fullGrade === true,
        fullGradePerGrade: (activity.fullGradePerGrade && typeof activity.fullGradePerGrade === 'object') ? activity.fullGradePerGrade : undefined,
        // ★ v3.7: Multi-Part Special support (simple N parts)


        multiPart: activity.multiPart && typeof activity.multiPart === 'object' ? {
            enabled: activity.multiPart.enabled === true,
            totalParts: (function() { var tp = parseInt(activity.multiPart.totalParts, 10); return (!isNaN(tp) && tp >= 2 && tp <= 10) ? tp : 2; })(),
            daysBetween: (function() { var db = parseInt(activity.multiPart.daysBetween, 10); return (!isNaN(db) && db >= 1 && db <= 14) ? db : 3; })()
        } : { enabled: false, totalParts: 2, daysBetween: 3 }
    };
}

function createDefaultActivity(name) {
    return { name, type: 'Special', available: true, sharableWith: { type: 'not_sharable', divisions: [], capacity: 2 },
        limitUsage: { enabled: false, divisions: {}, priorityList: [], usePriority: false }, timeRules: [],
        maxUsage: null, maxUsagePeriod: 'half', frequencyWeeks: 0, rainyDayExclusive: false, prepDuration: 0,
        location: null, isIndoor: true, rainyDayAvailable: true, availableOnRainyDay: true,
        rainyDayCapacity: null, rainyDayAvailableAllDay: false, fullGrade: false,
        multiPart: { enabled: false, totalParts: 2, daysBetween: 3, parts: [] },
        minFrequency: null, minFrequencyPeriod: 'week', maxUsagePerGrade: {} };
}

function validateAllActivities(activities) { if (!Array.isArray(activities)) return []; return activities.map(a => validateSpecialActivity(a, a?.name)); }

// =========================================================================
// INIT — v3.4: Nested accordion layout
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
        #special_activities .sa-group { margin-bottom: 18px; }
        #special_activities .sa-group-header { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #9CA3AF; padding: 0 2px 6px 2px; margin-bottom: 4px; border-bottom: 1px solid #F3F4F6; }
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
    // ★ v3.5: Show multi-part badge in master list
    if (item.multiPart?.enabled) {
        const mpBadge = document.createElement("span");
        mpBadge.style.cssText = "display:inline-flex; align-items:center; gap:3px; font-size:0.65rem; padding:2px 6px; border-radius:999px; margin-left:6px; color:#6b21a8; background:#f3e8ff;";
        mpBadge.textContent = item.multiPart.totalParts + "-part";
        nameEl.appendChild(mpBadge);
    }
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

/ v5.0: flat labeled group — sections sit directly under the label, no outer click
function sectionGroup(label, sections) {
    const group = document.createElement('div');
    group.className = 'sa-group';
    const header = document.createElement('div');
    header.className = 'sa-group-header';
    header.textContent = label;
    group.appendChild(header);
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
        // ★ v3.5: Also update partner activity references when renaming
        propagateMultiPartRename(oldName, newName);
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
            // ★ v3.5: Unlink partner before deleting
            cleanupMultiPartLink(item);
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

    // v5.0: WHO / WHERE / WHEN / HOW — flat labeled groups, single-level accordion

    // ── WHO ───────────────────────────────────────────────────────────────────
    detailPaneEl.appendChild(sectionGroup('Who', [
        section('Grade Access', summaryAccess(item), () => renderAccess(item))
    ]));

    // ── WHERE ─────────────────────────────────────────────────────────────────
    detailPaneEl.appendChild(sectionGroup('Where', [
        section('Field / Location', summaryLocation(item), () => renderLocationSettings(item))
    ]));

    // ── WHEN ──────────────────────────────────────────────────────────────────
    const whenSections = [
        section('Time Availability', summaryTime(item), () => renderTimeRules(item)),
        section('Day Availability', summaryDays(item), () => renderDayAvailability(item))
    ];
    if (!isRainyDayItem) {
        whenSections.push(section('Weather & Rainy Day', summaryWeather(item), () => renderWeatherSettings(item)));
    }
    detailPaneEl.appendChild(sectionGroup('When', whenSections));

    // ── HOW ───────────────────────────────────────────────────────────────────
    const howSections = [
        section('Scheduling Mode', summarySchedulingMode(item), () => renderSchedulingMode(item)),
        section('Usage & Frequency', summaryMaxUsage(item), () => renderMaxUsageSettings(item)),
        section('Prep Duration', summaryPrepDuration(item), () => renderPrepDurationSettings(item)),
        section('Multi-Part Activity', summaryMultiPart(item), () => renderMultiPartSettings(item))
    ];
    if (window.getCampBuilderMode?.() === 'auto' || window._daBuilderMode === 'auto') {
        howSections.splice(1, 0, section('Activity Duration', summaryDuration(item), () => renderDurationSettings(item)));
    }
    detailPaneEl.appendChild(sectionGroup('How', howSections));
}
   
}

// =========================================================================
// SUMMARY HELPERS
// =========================================================================
function summaryMaxUsage(item) {
    var parts = [];
    var m = parseInt(item.maxUsage) || 0;
    if (m > 0) {
        var period = item.maxUsagePeriod || 'half';
        var periodLabels = { 'half': 'per half', '1week': 'per week', '2weeks': 'per 2 wks', '3weeks': 'per 3 wks', '4weeks': 'per 4 wks' };
        parts.push('Max ' + m + ' ' + (periodLabels[period] || 'per half'));
    }
    var minF = parseInt(item.minFrequency) || 0;
    if (minF > 0) {
        parts.push('Min ' + minF + 'x ' + (item.minFrequencyPeriod === '2weeks' ? 'per 2 wks' : 'per week'));
    }
    var gradeCount = Object.keys(item.maxUsagePerGrade || {}).filter(function(k) { return (item.maxUsagePerGrade[k] || 0) > 0; }).length;
    if (gradeCount > 0) parts.push(gradeCount + ' grade override' + (gradeCount > 1 ? 's' : ''));
    return parts.length ? parts.join(' · ') : 'No limit';
}
function summaryFullGrade(item) { return item.fullGrade ? 'Full grade together' : 'Individual bunks'; }
function summarySharing(item) { if (!item.sharableWith || item.sharableWith.type === 'not_sharable') return "1 bunk at a time"; return 'Up to ' + (parseInt(item.sharableWith.capacity,10)||2) + ' bunks at once'; }
function summarySchedulingMode(item) {
    if (item.fullGradePerGrade && typeof item.fullGradePerGrade === 'object'
        && Object.keys(item.fullGradePerGrade).length > 0) {
        var fullCount = 0, indivCount = 0;
        var allDivs = Object.keys(window.loadGlobalSettings?.()?.divisions || {});
        allDivs.forEach(function(div) {
            if (window.isFullGradeForDivision?.(item.name, div)) fullCount++; else indivCount++;
        });
        if (fullCount > 0 && indivCount > 0) return 'Mixed — ' + fullCount + ' full grade, ' + indivCount + ' individual';
        if (fullCount === allDivs.length) return 'Full grade — all bunks together';
    }
    if (item.fullGrade) return 'Full grade — all bunks together';
    if (!item.sharableWith || item.sharableWith.type === 'not_sharable') return 'Individual — 1 bunk at a time';
    return 'Individual — up to ' + (parseInt(item.sharableWith.capacity, 10) || 2) + ' bunks at once';
}
function summaryAccess(item) { if (!item.limitUsage?.enabled) return "Open to all grades"; const c = Object.keys(item.limitUsage.divisions||{}).length; if (c===0) return "\u26A0 Restricted (none selected)"; return c + ' grade' + (c!==1?'s':'') + ' allowed' + (item.limitUsage.usePriority?" \u00B7 prioritized":""); }
function summaryTime(item) { const c = (item.timeRules||[]).length; return c ? c + ' rule(s) active' : "Available all day"; }
function summaryWeather(item) {
    let s = item.isIndoor ? 'Indoor · Rainy day available' : 'Outdoor · Disabled on rain';
    const overrides = [];
    if (item.rainyDayCapacity > 0) overrides.push('cap:' + item.rainyDayCapacity);
    if (item.rainyDayAvailableAllDay && (item.timeRules||[]).length > 0) overrides.push('bypass time rules');
    if (overrides.length > 0) s += ' · Rainy: ' + overrides.join(', ');
    return s;
}
function summaryLocation(item) { return item.location || "No field assigned"; }

// ★ v3.7: Multi-Part summary
function summaryMultiPart(item) {
    if (!item.multiPart?.enabled) return 'Single session';
    return item.multiPart.totalParts + '-part activity';
}

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
// RENDER: Scheduling Mode — v4.1 Full Grade + Per Grade + Sharing
// =========================================================================
function renderSchedulingMode(item) {
    const container = document.createElement("div");
    const updateSummary = () => {
        const s = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if (s) s.textContent = summarySchedulingMode(item);
        const groupHint = container.closest('.outer-accordion-body')?.previousElementSibling?.querySelector('.oa-hint');
        if (groupHint) groupHint.textContent = summarySchedulingMode(item);
    };

    const getMode = () => {
        if (item.fullGradePerGrade && typeof item.fullGradePerGrade === 'object'
            && Object.keys(item.fullGradePerGrade).length > 0) return 'per_grade';
        return item.fullGrade ? 'full' : 'individual';
    };

    const renderContent = () => {
        container.innerHTML = "";
        const mode = getMode();

        // ── TOP-LEVEL 3-WAY TOGGLE ──
        const modeWrap = document.createElement("div");
        modeWrap.style.cssText = "display:flex; gap:0; margin-bottom:16px; border-radius:10px; overflow:hidden; border:1px solid #E5E7EB;";

        const makeBtn = (label, sublabel, isActive, isFirst) => {
            const btn = document.createElement("button");
            btn.innerHTML = '<strong>' + label + '</strong><span style="display:block;font-size:0.7rem;font-weight:400;margin-top:2px;opacity:0.8;">' + sublabel + '</span>';
            btn.style.cssText = 'flex:1; padding:10px 6px; border:none; cursor:pointer; text-align:center; font-size:0.82rem; transition:all 0.15s; line-height:1.3; '
                + (isActive ? 'background:#0F5F6E; color:white;' : 'background:#fff; color:#6B7280;')
                + (!isFirst ? ' border-left:1px solid #E5E7EB;' : '');
            return btn;
        };

        const btnFull = makeBtn('Full Grade', 'All grades together', mode === 'full', true);
        const btnPerGrade = makeBtn('Per Grade', 'Customize per grade', mode === 'per_grade', false);
        const btnIndiv = makeBtn('Individual', 'Assigned per bunk', mode === 'individual', false);

        btnFull.onclick = () => {
            item.fullGrade = true;
            delete item.fullGradePerGrade;
            saveData(); renderContent(); updateSummary();
        };
        btnPerGrade.onclick = () => {
            const allDivs = Object.keys(window.loadGlobalSettings?.()?.divisions || {});
            if (!item.fullGradePerGrade || typeof item.fullGradePerGrade !== 'object') item.fullGradePerGrade = {};
            allDivs.forEach(div => { if (!(div in item.fullGradePerGrade)) item.fullGradePerGrade[div] = !!item.fullGrade; });
            saveData(); renderContent(); updateSummary();
        };
        btnIndiv.onclick = () => {
            item.fullGrade = false;
            delete item.fullGradePerGrade;
            saveData(); renderContent(); updateSummary();
        };

        modeWrap.appendChild(btnFull);
        modeWrap.appendChild(btnPerGrade);
        modeWrap.appendChild(btnIndiv);
        container.appendChild(modeWrap);

        // ── MODE-SPECIFIC CONTENT ──
        if (mode === 'full') {
            const infoBox = document.createElement("div");
            infoBox.style.cssText = "padding:14px; background:linear-gradient(135deg, #f0f9fb, #e6f4f7); border:1px solid #b2dce6; border-radius:8px; line-height:1.6;";
            infoBox.innerHTML =
                '<div style="font-weight:600; color:#0A4A56; margin-bottom:6px; font-size:0.9rem;">How it works</div>' +
                '<div style="color:#0F5F6E; font-size:0.84rem;">' +
                    'When the scheduler assigns this activity, <strong>every bunk in the grade</strong> will do it in the same time slot. ' +
                    'No sharing rules are needed — the entire grade participates together.' +
                '</div>';
            container.appendChild(infoBox);

        } else if (mode === 'per_grade') {
            // ── PER GRADE MODE ──
            const allDivs = Object.keys(window.loadGlobalSettings?.()?.divisions || {});
            const perGrade = item.fullGradePerGrade || {};

            const infoBox = document.createElement("div");
            infoBox.style.cssText = "padding:12px; background:linear-gradient(135deg, #FFF7ED, #FEF3C7); border:1px solid #FCD34D; border-radius:8px; line-height:1.5; margin-bottom:14px;";
            infoBox.innerHTML =
                '<div style="font-weight:600; color:#92400E; margin-bottom:4px; font-size:0.88rem;">Per-Grade Mode</div>' +
                '<div style="color:#A16207; font-size:0.82rem;">' +
                    'Choose which grades do this as <strong>full grade</strong> (all bunks together) ' +
                    'vs <strong>individual bunks</strong> (assigned per bunk).' +
                '</div>';
            container.appendChild(infoBox);

            const gradeList = document.createElement("div");
            gradeList.style.cssText = "display:flex; flex-direction:column; gap:6px;";

            allDivs.forEach(divName => {
                const isFullGrade = !!perGrade[divName];
                const row = document.createElement("div");
                row.style.cssText = "display:flex; align-items:center; justify-content:space-between; padding:10px 14px; border-radius:8px; border:1px solid "
                    + (isFullGrade ? "#b2dce6" : "#E5E7EB") + "; background:"
                    + (isFullGrade ? "#f0f9fb" : "#FAFAFA") + "; transition:all 0.15s;";

                const nameSpan = document.createElement("span");
                nameSpan.style.cssText = "font-weight:500; font-size:0.88rem; color:#1F2937;";
                nameSpan.textContent = divName;

                const btnRow = document.createElement("div");
                btnRow.style.cssText = "display:flex; gap:0; border-radius:6px; overflow:hidden; border:1px solid #D1D5DB;";

                const btnGradeFull = document.createElement("button");
                btnGradeFull.textContent = "Full Grade";
                btnGradeFull.style.cssText = "padding:4px 10px; border:none; cursor:pointer; font-size:0.78rem; font-weight:500; transition:all 0.15s; "
                    + (isFullGrade ? "background:#0F5F6E; color:white;" : "background:#fff; color:#6B7280;");

                const btnGradeIndiv = document.createElement("button");
                btnGradeIndiv.textContent = "Individual";
                btnGradeIndiv.style.cssText = "padding:4px 10px; border:none; cursor:pointer; font-size:0.78rem; font-weight:500; border-left:1px solid #D1D5DB; transition:all 0.15s; "
                    + (!isFullGrade ? "background:#0F5F6E; color:white;" : "background:#fff; color:#6B7280;");

                btnGradeFull.onclick = () => { item.fullGradePerGrade[divName] = true; saveData(); renderContent(); updateSummary(); };
                btnGradeIndiv.onclick = () => { item.fullGradePerGrade[divName] = false; saveData(); renderContent(); updateSummary(); };

                btnRow.appendChild(btnGradeFull);
                btnRow.appendChild(btnGradeIndiv);
                row.appendChild(nameSpan);
                row.appendChild(btnRow);
                gradeList.appendChild(row);
            });
            container.appendChild(gradeList);

            // Sharing controls for individual-mode grades
            const hasAnyIndividual = allDivs.some(d => !perGrade[d]);
            if (hasAnyIndividual) {
                const divider = document.createElement("div");
                divider.style.cssText = "margin:16px 0 12px; border-top:1px solid #E5E7EB;";
                container.appendChild(divider);

                const sharingHeader = document.createElement("div");
                sharingHeader.style.cssText = "font-size:0.85rem; font-weight:500; color:#374151; margin-bottom:10px;";
                sharingHeader.textContent = "Sharing rules (for Individual grades):";
                container.appendChild(sharingHeader);

                const rules = item.sharableWith || { type: 'not_sharable', divisions: [], capacity: 2 };
                const isSharable = rules.type !== 'not_sharable';

                const toggleRow = document.createElement("div");
                toggleRow.style.cssText = "display:flex; align-items:center; gap:10px; margin-bottom:12px;";
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

                if (isSharable) {
                    const capRow = document.createElement("div");
                    capRow.style.cssText = "display:flex; align-items:center; gap:12px; padding:12px; background:#F9FAFB; border-radius:8px; border:1px solid #E5E7EB;";
                    const capIn = document.createElement("input");
                    capIn.type = "number"; capIn.min = "2"; capIn.max = "20"; capIn.value = rules.capacity || 2;
                    capIn.style.cssText = "width:64px; padding:8px; border-radius:6px; border:1px solid #D1D5DB; text-align:center; font-size:1rem; font-weight:600;";
                    capIn.onchange = () => { rules.capacity = Math.min(20, Math.max(2, parseInt(capIn.value) || 2)); capIn.value = rules.capacity; item.sharableWith = rules; saveData(); updateSummary(); };
                    const capSuffix = document.createElement("span"); capSuffix.style.cssText = "font-size:0.85rem; color:#6B7280;"; capSuffix.textContent = "bunks at once";
                    capRow.appendChild(capIn); capRow.appendChild(capSuffix); container.appendChild(capRow);
                } else {
                    const noteBox = document.createElement("div");
                    noteBox.style.cssText = "color:#6B7280; font-size:0.8rem; padding:12px; background:#F9FAFB; border-radius:8px; border:1px solid #E5E7EB;";
                    noteBox.textContent = "Only 1 bunk at a time (for Individual grades).";
                    container.appendChild(noteBox);
                }
            }

        } else {
            // ── INDIVIDUAL BUNK MODE (unchanged) ──
            const rules = item.sharableWith || { type: 'not_sharable', divisions: [], capacity: 2 };
            const isSharable = rules.type !== 'not_sharable';

            const sharingLabel = document.createElement("div");
            sharingLabel.style.cssText = "font-size:0.85rem; font-weight:500; color:#374151; margin-bottom:10px;";
            sharingLabel.textContent = "Can multiple bunks do this at the same time?";
            container.appendChild(sharingLabel);

            const toggleRow = document.createElement("div");
            toggleRow.style.cssText = "display:flex; align-items:center; gap:10px; margin-bottom:12px;";
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

            if (!isSharable) {
                const n = document.createElement("div");
                n.style.cssText = "color:#6B7280; font-size:0.85rem; padding:10px; background:#F9FAFB; border-radius:8px;";
                n.textContent = "Only 1 bunk can use this activity at a time.";
                container.appendChild(n);
            } else {
                const capBox = document.createElement("div");
                capBox.style.cssText = "padding:14px; background:#F9FAFB; border-radius:8px; border:1px solid #E5E7EB;";

                const capLabel = document.createElement("div");
                capLabel.style.cssText = "font-size:0.85rem; font-weight:500; color:#374151; margin-bottom:10px;";
                capLabel.textContent = "How many bunks at once?";
                capBox.appendChild(capLabel);

                const capRow = document.createElement("div");
                capRow.style.cssText = "display:flex; align-items:center; gap:12px; margin-bottom:10px;";
                const capIn = document.createElement("input");
                capIn.type = "number"; capIn.min = "2"; capIn.max = "20"; capIn.value = rules.capacity || 2;
                capIn.style.cssText = "width:64px; padding:8px; border-radius:6px; border:1px solid #D1D5DB; text-align:center; font-size:1rem; font-weight:600;";
                capIn.onchange = () => {
                    rules.capacity = Math.min(20, Math.max(2, parseInt(capIn.value) || 2));
                    capIn.value = rules.capacity;
                    item.sharableWith = rules; saveData(); updateSummary();
                    const noteEl = capBox.querySelector('.cap-note');
                    if (noteEl) noteEl.innerHTML = 'Up to <strong>' + rules.capacity + '</strong> bunks from the <strong>same grade</strong> can be scheduled here at the same time.';
                };
                const capSuffix = document.createElement("span");
                capSuffix.style.cssText = "font-size:0.85rem; color:#6B7280;";
                capSuffix.textContent = "bunks at once";
                capRow.appendChild(capIn); capRow.appendChild(capSuffix); capBox.appendChild(capRow);

                const capNote = document.createElement("div");
                capNote.className = "cap-note";
                capNote.style.cssText = "color:#6B7280; font-size:0.8rem; line-height:1.5;";
                capNote.innerHTML = 'Up to <strong>' + (rules.capacity || 2) + '</strong> bunks from the <strong>same grade</strong> can be scheduled here at the same time. Bunks from different grades cannot share.';
                capBox.appendChild(capNote);
                container.appendChild(capBox);
            }
        }
    };

    renderContent();
    return container;
}

// =========================================================================
// RENDER: Usage & Frequency — v5.0: ceiling + per-grade + floor
// =========================================================================
function renderMaxUsageSettings(item) {
    const container = document.createElement('div');
    const updateSummary = () => {
        const s = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if (s) s.textContent = summaryMaxUsage(item);
    };

    function rebuild() {
        container.innerHTML = '';

        // ── A: MAXIMUM (CEILING) ──────────────────────────────────────────
        const ceilLabel = document.createElement('div');
        ceilLabel.style.cssText = 'font-weight:600; font-size:0.82rem; color:#374151; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:10px;';
        ceilLabel.textContent = 'Maximum (ceiling)';
        container.appendChild(ceilLabel);

        const ceilEnabled = (parseInt(item.maxUsage) || 0) > 0;

        const ceilTogRow = document.createElement('div');
        ceilTogRow.style.cssText = 'display:flex; align-items:center; gap:10px; margin-bottom:' + (ceilEnabled ? '12px' : '4px') + ';';
        const ceilTog = document.createElement('label'); ceilTog.className = 'switch';
        const ceilCb = document.createElement('input'); ceilCb.type = 'checkbox'; ceilCb.checked = ceilEnabled;
        const ceilSl = document.createElement('span'); ceilSl.className = 'slider';
        ceilTog.appendChild(ceilCb); ceilTog.appendChild(ceilSl);
        const ceilLbl = document.createElement('span');
        ceilLbl.style.cssText = 'font-size:0.88rem; color:#374151;';
        ceilLbl.textContent = 'Limit how many times a bunk can do this';
        ceilTogRow.appendChild(ceilTog); ceilTogRow.appendChild(ceilLbl);
        container.appendChild(ceilTogRow);
        ceilCb.onchange = () => { item.maxUsage = ceilCb.checked ? 1 : null; saveData(); rebuild(); updateSummary(); };

        if (ceilEnabled) {
            const ceilDetail = document.createElement('div');
            ceilDetail.style.cssText = 'padding-left:12px; border-left:2px solid #147D91; margin-bottom:14px;';

            const countRow = document.createElement('div');
            countRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:8px; flex-wrap:wrap;';
            countRow.innerHTML = '<span style="font-size:0.85rem; color:#374151;">Max:</span>';
            const countIn = document.createElement('input');
            countIn.type = 'number'; countIn.min = '1'; countIn.max = '99'; countIn.value = parseInt(item.maxUsage) || 1;
            countIn.style.cssText = 'width:56px; padding:4px 6px; border-radius:6px; border:1px solid #D1D5DB; text-align:center; font-size:0.88rem;';
            countIn.onchange = () => { item.maxUsage = Math.max(1, parseInt(countIn.value) || 1); saveData(); updateSummary(); };

            const periodSel = document.createElement('select');
            periodSel.style.cssText = 'padding:5px 8px; border-radius:6px; border:1px solid #D1D5DB; font-size:0.85rem; background:white; cursor:pointer;';
            [{ value:'half', label:'per half' }, { value:'1week', label:'per week' },
             { value:'2weeks', label:'per 2 weeks' }, { value:'3weeks', label:'per 3 weeks' },
             { value:'4weeks', label:'per 4 weeks' }].forEach(function(p) {
                const opt = document.createElement('option'); opt.value = p.value; opt.textContent = p.label;
                if ((item.maxUsagePeriod || 'half') === p.value) opt.selected = true;
                periodSel.appendChild(opt);
            });
            periodSel.onchange = () => { item.maxUsagePeriod = periodSel.value; saveData(); updateSummary(); };
            countRow.appendChild(countIn); countRow.appendChild(periodSel);
            ceilDetail.appendChild(countRow);

            // per-grade overrides
            const gradeSubHead = document.createElement('div');
            gradeSubHead.style.cssText = 'font-size:0.78rem; font-weight:600; color:#6B7280; margin:10px 0 4px 0;';
            gradeSubHead.textContent = 'Per-grade overrides';
            ceilDetail.appendChild(gradeSubHead);
            const gradeNote = document.createElement('div');
            gradeNote.style.cssText = 'font-size:0.75rem; color:#9CA3AF; margin-bottom:8px;';
            gradeNote.textContent = 'Leave blank to use the global cap above.';
            ceilDetail.appendChild(gradeNote);

            if (!item.maxUsagePerGrade) item.maxUsagePerGrade = {};
            const allDivs = Object.keys(window.loadGlobalSettings?.()?.divisions || {});
            const gradeGrid = document.createElement('div');
            gradeGrid.style.cssText = 'display:flex; flex-direction:column; gap:5px;';
            allDivs.forEach(function(div) {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex; align-items:center; gap:8px;';
                const lbl = document.createElement('span');
                lbl.style.cssText = 'font-size:0.82rem; color:#374151; flex:1;';
                lbl.textContent = div;
                const inp = document.createElement('input');
                inp.type = 'number'; inp.min = '0'; inp.max = '99';
                inp.placeholder = String(parseInt(item.maxUsage) || '—');
                const gv = item.maxUsagePerGrade[div];
                if (gv > 0) inp.value = gv;
                inp.style.cssText = 'width:56px; padding:4px 6px; border-radius:6px; border:1px solid #D1D5DB; text-align:center; font-size:0.85rem;';
                inp.onchange = () => {
                    const v = parseInt(inp.value);
                    if (v > 0) item.maxUsagePerGrade[div] = v;
                    else delete item.maxUsagePerGrade[div];
                    saveData(); updateSummary();
                };
                const clrBtn = document.createElement('button');
                clrBtn.textContent = '✕'; clrBtn.title = 'Clear override';
                clrBtn.style.cssText = 'background:none; border:none; color:#D1D5DB; cursor:pointer; font-size:0.8rem; padding:2px 4px; line-height:1;';
                clrBtn.onmouseover = () => clrBtn.style.color = '#9CA3AF';
                clrBtn.onmouseout = () => clrBtn.style.color = '#D1D5DB';
                clrBtn.onclick = () => { inp.value = ''; delete item.maxUsagePerGrade[div]; saveData(); updateSummary(); };
                row.appendChild(lbl); row.appendChild(inp); row.appendChild(clrBtn);
                gradeGrid.appendChild(row);
            });
            ceilDetail.appendChild(gradeGrid);
            container.appendChild(ceilDetail);
        }

        // ── B: MINIMUM (FLOOR) ────────────────────────────────────────────
        const divider = document.createElement('div');
        divider.style.cssText = 'border-top:1px solid #F3F4F6; margin:16px 0 14px 0;';
        container.appendChild(divider);

        const floorLabel = document.createElement('div');
        floorLabel.style.cssText = 'font-weight:600; font-size:0.82rem; color:#374151; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:10px;';
        floorLabel.textContent = 'Minimum (floor)';
        container.appendChild(floorLabel);

        const minF = parseInt(item.minFrequency) || 0;
        const minEnabled = minF > 0;

        const minTogRow = document.createElement('div');
        minTogRow.style.cssText = 'display:flex; align-items:center; gap:10px; margin-bottom:' + (minEnabled ? '12px' : '4px') + ';';
        const minTog = document.createElement('label'); minTog.className = 'switch';
        const minCb = document.createElement('input'); minCb.type = 'checkbox'; minCb.checked = minEnabled;
        const minSl = document.createElement('span'); minSl.className = 'slider';
        minTog.appendChild(minCb); minTog.appendChild(minSl);
        const minLbl = document.createElement('span');
        minLbl.style.cssText = 'font-size:0.88rem; color:#374151;';
        minLbl.textContent = 'Require a minimum frequency for every bunk';
        minTogRow.appendChild(minTog); minTogRow.appendChild(minLbl);
        container.appendChild(minTogRow);
        minCb.onchange = () => { item.minFrequency = minCb.checked ? 1 : null; saveData(); rebuild(); updateSummary(); };

        if (minEnabled) {
            const minDetail = document.createElement('div');
            minDetail.style.cssText = 'padding-left:12px; border-left:2px solid #0ea5e9; margin-bottom:4px;';

            const minRow = document.createElement('div');
            minRow.style.cssText = 'display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:10px;';
            minRow.innerHTML = '<span style="font-size:0.85rem; color:#374151;">At least:</span>';
            const minIn = document.createElement('input');
            minIn.type = 'number'; minIn.min = '1'; minIn.max = '14'; minIn.value = minF || 1;
            minIn.style.cssText = 'width:56px; padding:4px 6px; border-radius:6px; border:1px solid #D1D5DB; text-align:center; font-size:0.88rem;';
            const minSuffix = document.createElement('span');
            minSuffix.style.cssText = 'font-size:0.85rem; color:#374151;';
            minSuffix.textContent = 'time(s) per';
            const minPeriodSel = document.createElement('select');
            minPeriodSel.style.cssText = 'padding:5px 8px; border-radius:6px; border:1px solid #D1D5DB; font-size:0.85rem; background:white; cursor:pointer;';
            [{ value:'week', label:'week' }, { value:'2weeks', label:'2 weeks' }].forEach(function(p) {
                const opt = document.createElement('option'); opt.value = p.value; opt.textContent = p.label;
                if ((item.minFrequencyPeriod || 'week') === p.value) opt.selected = true;
                minPeriodSel.appendChild(opt);
            });
            minIn.onchange = () => { item.minFrequency = Math.max(1, parseInt(minIn.value) || 1); saveData(); updateSummary(); };
            minPeriodSel.onchange = () => { item.minFrequencyPeriod = minPeriodSel.value; saveData(); updateSummary(); };
            minRow.appendChild(minIn); minRow.appendChild(minSuffix); minRow.appendChild(minPeriodSel);
            minDetail.appendChild(minRow);

            const minNote = document.createElement('div');
            minNote.style.cssText = 'font-size:0.78rem; color:#0369a1; background:#e0f2fe; padding:8px 10px; border-radius:6px; line-height:1.5;';
            minNote.innerHTML = 'The scheduler will actively push to get every bunk this activity at least <strong>' +
                (item.minFrequency || 1) + 'x</strong> ' +
                (item.minFrequencyPeriod === '2weeks' ? 'every 2 weeks' : 'per week') + '.';
            minDetail.appendChild(minNote);
            container.appendChild(minDetail);
        }
    }

    rebuild();
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

    // ── INDOOR / OUTDOOR TOGGLE ──
    const topDesc = document.createElement("p");
    topDesc.style.cssText = "font-size:0.84rem; color:#6b7280; margin:0 0 14px 0; line-height:1.5;";
    topDesc.textContent = "Does this activity happen indoors or outdoors? Indoor activities stay available when you turn on Rainy Day Mode. Outdoor activities are automatically disabled.";
    container.appendChild(topDesc);

    const indoorCard = document.createElement("div");
    indoorCard.style.cssText = "display:flex; align-items:center; gap:12px; padding:14px; background:" + (isIndoor ? '#e6f4f7' : '#fef3c7') + "; border:1px solid " + (isIndoor ? '#b2dce6' : '#fcd34d') + "; border-radius:10px; margin-bottom:20px;";
    indoorCard.innerHTML =
        '<div style="flex:1;">'
        + '<div style="font-weight:600; color:' + (isIndoor ? '#0A4A56' : '#92400e') + ';">' + (isIndoor ? 'Indoor Activity' : 'Outdoor Activity') + '</div>'
        + '<div style="font-size:0.84rem; color:' + (isIndoor ? '#0F5F6E' : '#b45309') + ';">' + (isIndoor ? 'Stays available on rainy days' : 'Turned off during rainy days') + '</div>'
        + '</div>'
        + '<label class="switch"><input type="checkbox" id="weather-toggle" ' + (isIndoor ? 'checked' : '') + '><span class="slider"></span></label>';
    container.appendChild(indoorCard);

    // ── RAINY DAY OVERRIDES ──
    const overrideSection = document.createElement("div");
    overrideSection.style.cssText = "padding-top:16px; border-top:1px solid #e5e7eb;";

    const overrideTitle = document.createElement("div");
    overrideTitle.style.cssText = "font-weight:600; font-size:0.95rem; color:#1e293b; margin-bottom:4px;";
    overrideTitle.textContent = "Rainy Day Overrides";
    overrideSection.appendChild(overrideTitle);

    const overrideDesc = document.createElement("div");
    overrideDesc.style.cssText = "font-size:0.8rem; color:#6B7280; margin-bottom:14px; line-height:1.5;";
    overrideDesc.textContent = "Optionally change how this activity behaves when Rainy Day Mode is on. These only apply on rainy days.";
    overrideSection.appendChild(overrideDesc);

    // Capacity override
    const regularCapacity = parseInt(item.sharableWith?.capacity) || 1;
    const capCard = document.createElement("div");
    capCard.style.cssText = "background:#f0f9ff; border:1px solid #bae6fd; border-radius:10px; padding:14px; margin-bottom:12px;";
    capCard.innerHTML =
        '<div style="font-weight:600; font-size:0.9rem; color:#0c4a6e; margin-bottom:4px;">Capacity Override</div>'
        + '<div style="font-size:0.8rem; color:#0369a1; margin-bottom:10px;">Normal capacity is ' + regularCapacity + ' bunk' + (regularCapacity !== 1 ? 's' : '') + '. Set a different number here if more bunks should be able to use this on rainy days.</div>'
        + '<div style="display:flex; align-items:center; gap:10px;">'
        + '<label style="font-size:0.85rem; color:#334155;">Rainy day capacity:</label>'
        + '<input type="number" id="rainy-day-capacity-input" min="1" max="20" placeholder="Same as normal" value="' + (item.rainyDayCapacity || '') + '" style="width:80px; padding:6px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:0.9rem;">'
        + '<span style="font-size:0.8rem; color:#64748b;">bunks</span>'
        + '</div>'
        + '<div style="font-size:0.75rem; color:#64748b; margin-top:6px;">Leave empty to keep the normal capacity on rainy days.</div>';
    overrideSection.appendChild(capCard);

    // Time bypass
    const hasTimeRules = (item.timeRules || []).length > 0;
    const timeCard = document.createElement("div");
    timeCard.style.cssText = "background:#fefce8; border:1px solid #fde68a; border-radius:10px; padding:14px;";
    timeCard.innerHTML =
        '<div style="display:flex; align-items:center; justify-content:space-between;">'
        + '<div>'
        + '<div style="font-weight:600; font-size:0.9rem; color:#713f12;">Available All Day on Rain Days</div>'
        + '<div style="font-size:0.8rem; color:#a16207; line-height:1.4;">'
        + (hasTimeRules
            ? 'When on, the ' + item.timeRules.length + ' time rule' + (item.timeRules.length !== 1 ? 's' : '') + ' you set will be ignored on rainy days, making this available all day.'
            : 'No time rules configured yet. Add time rules in the Time Availability section first.')
        + '</div>'
        + '</div>'
        + '<label class="switch" style="margin-left:12px;"><input type="checkbox" id="rainy-day-all-day-toggle" ' + (item.rainyDayAvailableAllDay ? 'checked' : '') + ' ' + (!hasTimeRules ? 'disabled' : '') + '><span class="slider"></span></label>'
        + '</div>';
    overrideSection.appendChild(timeCard);

    container.appendChild(overrideSection);

    // ── EVENT HANDLERS ──
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

// =========================================================================
// ★ v3.5: RENDER Multi-Part Special Settings
// =========================================================================
function renderMultiPartSettings(item) {
    var container = document.createElement("div");
    container.style.cssText = "padding:16px;";

    var mp = item.multiPart || { enabled: false, totalParts: 2, daysBetween: 3 };
    var isEnabled = mp.enabled === true;

    // Description
    var desc = document.createElement("p");
    desc.style.cssText = "font-size:0.8rem; color:#6B7280; margin:0 0 14px 0; line-height:1.5;";
    desc.innerHTML = 'A <strong>multi-part special</strong> must be completed over multiple days. Example: <strong>Woodworking</strong> with 3 parts \u2014 bunks see "Woodworking 1/3" the first time, "Woodworking 2/3" next, then "Woodworking 3/3". A bunk cannot skip ahead.';
    container.appendChild(desc);

    // Toggle
    var toggleRow = document.createElement("div");
    toggleRow.style.cssText = "display:flex; align-items:center; gap:10px; margin-bottom:14px;";
    var tog = document.createElement("label"); tog.className = "switch";
    var cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = isEnabled;
    var sl = document.createElement("span"); sl.className = "slider";
    tog.appendChild(cb); tog.appendChild(sl);
    var toggleLabel = document.createElement("span");
    toggleLabel.style.cssText = "font-weight:500; font-size:0.9rem;";
    toggleLabel.textContent = "Enable Multi-Part Special";
    toggleRow.appendChild(tog); toggleRow.appendChild(toggleLabel);
    container.appendChild(toggleRow);

    // Config panel
    var configPanel = document.createElement("div");
    configPanel.style.display = isEnabled ? "block" : "none";
    container.appendChild(configPanel);

    function renderConfig() {
        configPanel.innerHTML = '';

        // Total parts input
        var row = document.createElement("div");
        row.style.cssText = "display:flex; align-items:center; gap:10px; margin-bottom:16px;";
        row.innerHTML = '<label style="font-size:0.85rem; font-weight:500;">Number of parts:</label>';
        var inp = document.createElement("input");
        inp.type = "number"; inp.min = "2"; inp.max = "10"; inp.value = mp.totalParts || 2;
        inp.style.cssText = "width:60px; padding:6px 10px; border:1px solid #D1D5DB; border-radius:6px; text-align:center; font-size:0.9rem;";
        inp.onchange = function() {
            var v = Math.min(10, Math.max(2, parseInt(this.value) || 2));
            this.value = v;
            mp.totalParts = v;
            item.multiPart = mp;
            saveData();
            renderConfig();
            updateSummary();
            renderMasterList(); renderRainyDayList();
        };
        row.appendChild(inp);
        row.lastElementChild.insertAdjacentHTML('afterend', '<span style="font-size:0.8rem; color:#6B7280;">sessions across different days</span>');
        configPanel.appendChild(row);

        // Days between parts input
        var daysRow = document.createElement("div");
        daysRow.style.cssText = "display:flex; align-items:center; gap:10px; margin-bottom:16px;";
        daysRow.innerHTML = '<label style="font-size:0.85rem; font-weight:500;">Days between parts:</label>';
        var daysInp = document.createElement("input");
        daysInp.type = "number"; daysInp.min = "1"; daysInp.max = "14"; daysInp.value = mp.daysBetween || 3;
        daysInp.style.cssText = "width:60px; padding:6px 10px; border:1px solid #D1D5DB; border-radius:6px; text-align:center; font-size:0.9rem;";
        daysInp.onchange = function() {
            var v = Math.min(14, Math.max(1, parseInt(this.value) || 3));
            this.value = v;
            mp.daysBetween = v;
            item.multiPart = mp;
            saveData();
            renderConfig();
        };
        daysRow.appendChild(daysInp);
        daysRow.lastElementChild.insertAdjacentHTML('afterend', '<span style="font-size:0.8rem; color:#6B7280;">days before the scheduler starts pushing the next part</span>');
        configPanel.appendChild(daysRow);

        // Preview
        var preview = document.createElement("div");
        preview.style.cssText = "border:1px solid #E5E7EB; border-radius:10px; padding:14px; background:#FAFAFA; margin-bottom:14px;";
        preview.innerHTML = '<div style="font-weight:600; font-size:0.85rem; margin-bottom:10px;">Schedule Preview</div>';
        for (var i = 1; i <= mp.totalParts; i++) {
            var step = document.createElement("div");
            step.style.cssText = "display:flex; align-items:center; gap:10px; padding:8px 12px; margin-bottom:" + (i < mp.totalParts ? "4px" : "0") + "; border-radius:8px; background:#fff; border:1px solid #E5E7EB;";
            var badge = document.createElement("span");
            badge.style.cssText = "width:26px; height:26px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:0.75rem; flex-shrink:0; color:#fff; background:#147D91;";
            badge.textContent = i;
            step.appendChild(badge);
            var label = document.createElement("span");
            label.style.cssText = "font-size:0.85rem; color:#374151;";
            label.textContent = escapeHtml(item.name) + " " + i + "/" + mp.totalParts;
            step.appendChild(label);
            if (i === 1) { step.insertAdjacentHTML('beforeend', '<span style="margin-left:auto; font-size:0.7rem; color:#6B7280;">No prerequisite</span>'); }
            else { step.insertAdjacentHTML('beforeend', '<span style="margin-left:auto; font-size:0.7rem; color:#92400e;">Requires ' + (i-1) + '/' + mp.totalParts + ' done</span>'); }
            preview.appendChild(step);
            if (i < mp.totalParts) {
                var arrow = document.createElement("div");
                arrow.style.cssText = "text-align:center; color:#9CA3AF; font-size:0.75rem; margin:2px 0;";
                arrow.textContent = "\u2193 " + (mp.daysBetween || 3) + " day" + ((mp.daysBetween || 3) > 1 ? "s" : "") + " gap";
                preview.appendChild(arrow);
            }
        }
        configPanel.appendChild(preview);

        // Info box
        var info = document.createElement("div");
        info.style.cssText = "padding:10px 14px; border-radius:8px; font-size:0.8rem; line-height:1.5; background:#e6f4f7; border:1px solid #b2dce6; color:#0A4A56;";
        var cycles = item.maxUsage ? Math.ceil(item.maxUsage / mp.totalParts) : 1;
        var cycleText = cycles > 1 ? ' Bunks will complete <strong>' + cycles + ' full cycles</strong> (' + item.maxUsage + ' total sessions, set via Max Usage).' : ' Once a bunk completes all ' + mp.totalParts + ' parts, it won\u2019t be assigned again.';
        var daysText = ' After each part, the scheduler waits <strong>' + (mp.daysBetween || 3) + ' day' + ((mp.daysBetween || 3) > 1 ? 's' : '') + '</strong> then starts pushing the next part \u2014 getting more urgent each day it\u2019s not scheduled.';
        info.innerHTML = '\uD83D\uDCCB Each bunk sees <strong>' + escapeHtml(item.name) + ' 1/' + mp.totalParts + '</strong>, then <strong>' + escapeHtml(item.name) + ' 2/' + mp.totalParts + '</strong>' + (mp.totalParts > 2 ? ', and so on' : '') + '.' + daysText + cycleText;
        configPanel.appendChild(info);
    }

    function updateSummary() {
        var s = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if (s) s.textContent = summaryMultiPart(item);
    }

    cb.onchange = function() {
        isEnabled = this.checked;
        mp.enabled = isEnabled;
        if (!isEnabled) { mp.totalParts = 2; }
        item.multiPart = mp;
        // If maxUsage isn't set at all, default to totalParts (one cycle)
        if (isEnabled && !item.maxUsage) {
            item.maxUsage = mp.totalParts;
        }
        configPanel.style.display = isEnabled ? "block" : "none";
        if (isEnabled) renderConfig();
        saveData();
        updateSummary();
        renderMasterList(); renderRainyDayList();
    };

    if (isEnabled) renderConfig();
    return container;
}

// =========================================================================
// ★ v3.5: Multi-Part Helper Functions
// =========================================================================
function cleanupMultiPartLink(item) {
    // v3.7: No partner links — multiPart is self-contained on each activity
    return;
}

function propagateMultiPartRename(oldName, newName) {
    // v3.7: No partner references to update — single activity model
    return;
}

// =========================================================================
// Add/Delete, Cleanup, Helpers
// =========================================================================
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
// ★★★ v4.1: Per-Grade fullGrade helper ★★★
window.isFullGradeForDivision = function(activityName, divName) {
    var special = window.getSpecialActivityByName?.(activityName);
    if (!special) {
        var props = window.activityProperties?.[activityName];
        if (!props) return false;
        var fg = props._fullGrade ?? props.fullGrade;
        if (fg && typeof fg === 'object') return !!fg[divName];
        return !!fg;
    }
    if (special.fullGradePerGrade && typeof special.fullGradePerGrade === 'object'
        && Object.keys(special.fullGradePerGrade).length > 0) {
        if (divName in special.fullGradePerGrade) return !!special.fullGradePerGrade[divName];
        return !!special.fullGrade;
    }
    return !!special.fullGrade;
};window.isRainyDayModeActive = function() { try{const d=window.loadCurrentDailyData?.()||{};return d.rainyDayMode===true||d.isRainyDay===true||window.isRainyDay===true;}catch(e){return window.isRainyDay===true;} };
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
        // ★ v3.7: Check multi-part consistency
        if (a.multiPart?.enabled) {
            if (!a.multiPart.totalParts || a.multiPart.totalParts < 2) actIssues.push('Multi-part enabled but totalParts < 2');
            if (a.maxUsage && a.maxUsage < a.multiPart.totalParts) actIssues.push('maxUsage (' + a.maxUsage + ') < totalParts (' + a.multiPart.totalParts + ') — bunks will max out before completing all parts');
        }
        if (actIssues.length > 0) issues.push({ activity: a.name || '[index ' + idx + ']', issues: actIssues });
    });
    if (issues.length === 0) { console.log('\nAll special activities have valid structure!'); }
    else { console.log('\nISSUES FOUND (' + issues.length + ' activities):'); issues.forEach(function(item) { console.log('\n   ' + item.activity + ':'); item.issues.forEach(function(issue) { console.log('      - ' + issue); }); }); }
    console.log('\n' + '='.repeat(60));
    console.log('Run validateSpecialActivities() to auto-fix issues');
    console.log('='.repeat(60) + '\n');
    return { activities: storedActivities.length, issues: issues.length };
};

// =========================================================================
// ★ v3.7: Multi-Part Special — Global Helpers for Scheduler Integration
// =========================================================================
// Simple model: one activity, N parts. The system counts how many times
// a bunk has done it. Part X = the Xth time. Can't do part X+1 before X.
// Display: "Woodworking 2/3" means bunk's 2nd session out of 3 total.
// =========================================================================

/**
 * Count how many times a bunk has completed this activity on previous days.
 */
window.getBunkCompletionCount = function(bunkName, activityName) {
    if (!bunkName || !activityName) return 0;
    var count = 0;
    try {
        // Source 1: Historical counts (most reliable)
        var global = window.loadGlobalSettings?.() || {};
        var histCounts = global.historicalCounts || {};
        if (histCounts[bunkName]?.[activityName] > 0) return histCounts[bunkName][activityName];

        // Source 2: Rotation history
        var rotHist = window.loadRotationHistory?.() || {};
        var bunkHist = rotHist.bunks?.[bunkName];
        if (bunkHist) {
            var actHist = bunkHist.activities?.[activityName] || bunkHist[activityName];
            if (actHist?.count > 0) return actHist.count;
        }

        // Source 3: Scan all past daily schedules
        var allDaily = window.loadAllDailyData?.() || {};
        var currentDate = window.currentScheduleDate || window.currentDate || '';
        var sortedDates = Object.keys(allDaily).sort();
        for (var i = 0; i < sortedDates.length; i++) {
            var dateKey = sortedDates[i];
            if (currentDate && dateKey >= currentDate) continue;
            var sched = allDaily[dateKey]?.scheduleAssignments?.[bunkName];
            if (!Array.isArray(sched)) continue;
            for (var j = 0; j < sched.length; j++) {
                var entry = sched[j];
                if (entry && !entry.continuation && (entry._activity === activityName || entry.field === activityName)) {
                    count++;
                    break; // One per day max
                }
            }
        }
    } catch (e) {
        console.warn('[MultiPart] Error counting completions for ' + bunkName + ':', e);
    }
    return count;
};

// Backward compat alias
window.hasBunkCompletedPart1 = function(bunkName, activityName) {
    return window.getBunkCompletionCount(bunkName, activityName) > 0;
};
window.hasBunkCompletedActivity = window.hasBunkCompletedPart1;

/**
 * Get multi-part config for an activity (returns null if not multi-part).
 */
window.getMultiPartConfig = function(activityName) {
    var special = window.getSpecialActivityByName?.(activityName);
    if (!special?.multiPart?.enabled) return null;
    return special.multiPart;
};

/**
 * Check if a bunk is eligible for a special activity.
 * For multi-part: bunk must not have exceeded maxUsage.
 * maxUsage is set separately (e.g., 4 for 2-part × 2 cycles).
 * The existing same-day duplicate logic prevents double-assign within a day.
 */
window.isBunkEligibleForSpecial = function(bunkName, activityName) {
    var mp = window.getMultiPartConfig?.(activityName);
    if (!mp) return true;
    // maxUsage is the real cap (could be totalParts × number of cycles)
    var special = window.getSpecialActivityByName?.(activityName);
    var maxUsage = special?.maxUsage || mp.totalParts;
    if (maxUsage <= 0) return true; // No limit
    var completed = window.getBunkCompletionCount(bunkName, activityName);
    return completed < maxUsage;
};

/**
 * Get the display label for a bunk's next session of a multi-part activity.
 * Cycles through parts: if totalParts=2 and completed=3, next is "2/2" (second cycle, part 2).
 * Returns "Woodworking 1/2" or null if not multi-part.
 */
window.getMultiPartDisplayLabel = function(bunkName, activityName) {
    var mp = window.getMultiPartConfig?.(activityName);
    if (!mp) return null;
    var completed = window.getBunkCompletionCount(bunkName, activityName);
    var partInCycle = (completed % mp.totalParts) + 1;
    return activityName + ' ' + partInCycle + '/' + mp.totalParts;
};

console.log("[SPECIAL_ACTIVITIES] Module v3.7 loaded (multi-part: single activity, N parts)");
})();
