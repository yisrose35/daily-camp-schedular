// =================================================================
// daily_adjustments.js  (v5.0 - Master Builder UI Redesign)
// =================================================================
// v5.0 CHANGES:
// - ★ COMPLETE UI OVERHAUL to match master_schedule_builder.js
// - Premium enterprise design with .da- prefixed classes
// - Modal system from master builder (replaces browser prompts)
// - Sidebar layout matching master builder aesthetic
// - All existing functionality preserved
// - Rainy day mode with premium animations
// - Memory leak fixes with event listener cleanup
// - RBAC integration maintained
// =================================================================
(function() {
'use strict';

// =================================================================
// MODULE STATE
// =================================================================
let container = null;
let masterSettings = {};
let currentOverrides = {
  dailyFieldAvailability: {},
  leagues: [],
  disabledSpecialtyLeagues: [],
  dailyDisabledSportsByField: {},
  disabledFields: [],
  disabledSpecials: [],
  bunkActivityOverrides: []
};
let displacedTiles = [];
let smartTileHistory = null;
let dailyOverrideSkeleton = [];
let selectedTileId = null;

// DOM References
let skeletonContainer = null;
let tripsFormContainer = null;
let bunkOverridesContainer = null;
let resourceOverridesContainer = null;
let activeSubTab = 'skeleton';
let selectedOverrideId = null;

// Event listener tracking for cleanup
const _eventListeners = [];
let _keyHandler = null;
let _visHandler = null;

// Constants
const SMART_TILE_HISTORY_KEY = "smartTileHistory_v1";
const PIXELS_PER_MINUTE = 1.6; // Match master_builder.js PX constant
const INCREMENT_MINS = 30;
const SNAP_MINS = 5;

// =================================================================
// BLOCK TYPES - EXACT MATCH FROM master_schedule_builder.js
// =================================================================
const BLOCKS = {
  activity:         { name: 'Activity',    color: '#6366F1', bg: '#E0E7FF' },
  sports:           { name: 'Sports',      color: '#22C55E', bg: '#DCFCE7' },
  special:          { name: 'Special',     color: '#14B8A6', bg: '#CCFBF1' },
  smart:            { name: 'Smart',       color: '#8B5CF6', bg: '#EDE9FE', dashed: true },
  split:            { name: 'Split',       color: '#F59E0B', bg: '#FEF3C7' },
  elective:         { name: 'Elective',    color: '#EC4899', bg: '#FCE7F3' },
  league:           { name: 'League',      color: '#8B5CF6', bg: '#F3E8FF' },
  specialty_league: { name: 'Specialty',   color: '#EAB308', bg: '#FEF9C3' },
  swim:             { name: 'Swim',        color: '#0EA5E9', bg: '#E0F2FE' },
  lunch:            { name: 'Lunch',       color: '#EF4444', bg: '#FEE2E2' },
  snacks:           { name: 'Snacks',      color: '#F97316', bg: '#FFEDD5' },
  dismissal:        { name: 'Dismissal',   color: '#DC2626', bg: '#FEE2E2' },
  custom:           { name: 'Custom',      color: '#64748B', bg: '#F1F5F9' }
};

// TILES for palette (matching master builder's soft pastel palette)
const TILES = [
  {type:'activity', name:'Activity', style:'background:#93c5fd;color:#1e3a5f;', description:'Flexible slot (Sport or Special).'},
  {type:'sports', name:'Sports', style:'background:#86efac;color:#14532d;', description:'Sports slot only.'},
  {type:'special', name:'Special Activity', style:'background:#c4b5fd;color:#3b1f6b;', description:'Special Activity slot only.'},
  {type:'smart', name:'Smart Tile', style:'background:#7dd3fc;color:#0c4a6e;border:2px dashed #0284c7;', description:'Fills Main 1 by capacity, rest get Main 2, then swap next period.'},
  {type:'split', name:'Split Activity', style:'background:#fdba74;color:#7c2d12;', description:'Splits division between two tile types, swap midway.'},
  {type:'elective', name:'Elective', style:'background:#f0abfc;color:#701a75;', description:'Reserve multiple activities for this division only.'},
  {type:'league', name:'League Game', style:'background:#a5b4fc;color:#312e81;', description:'Regular League slot (Full Buyout).'},
  {type:'specialty_league', name:'Specialty League', style:'background:#d8b4fe;color:#581c87;', description:'Specialty League slot (Full Buyout).'},
  {type:'swim', name:'Swim', style:'background:#67e8f9;color:#155e75;', description:'Pinned.'},
  {type:'lunch', name:'Lunch', style:'background:#fca5a5;color:#7f1d1d;', description:'Pinned.'},
  {type:'snacks', name:'Snacks', style:'background:#fde047;color:#713f12;', description:'Pinned.'},
  {type:'dismissal', name:'Dismissal', style:'background:#f87171;color:#fff;', description:'Pinned.'},
  {type:'custom', name:'Custom Pinned', style:'background:#cbd5e1;color:#334155;', description:'Pinned custom (e.g., Regroup).'}
];

// =================================================================
// UTILITY FUNCTIONS
// =================================================================
const genId = () => Math.random().toString(36).slice(2, 9);
const escapeHtml = (s) => { 
  const d = document.createElement('div'); 
  d.textContent = s || ''; 
  return d.innerHTML; 
};

function parseTimeToMinutes(str) {
  if (!str) return null;
  const t = str.toLowerCase().replace(/\s/g, '');
  const pm = t.includes('pm'), am = t.includes('am');
  let [hr, mn] = t.replace(/[ap]m/g, '').split(':').map(Number);
  if (isNaN(hr)) return null;
  if (pm && hr !== 12) hr += 12;
  if (am && hr === 12) hr = 0;
  return hr * 60 + (mn || 0);
}

function minutesToTime(min) {
  if (min == null) return '';
  let hr = Math.floor(min / 60), mn = min % 60;
  return `${hr % 12 || 12}:${String(mn).padStart(2, '0')} ${hr >= 12 ? 'PM' : 'AM'}`;
}

function getGridBounds() {
  const D = window.divisions || {};
  let lo = null, hi = null;
  Object.values(D).filter(d => d?.bunks?.length).forEach(d => {
    const s = parseTimeToMinutes(d.startTime), e = parseTimeToMinutes(d.endTime);
    if (s != null && (lo == null || s < lo)) lo = s;
    if (e != null && (hi == null || e > hi)) hi = e;
  });
  dailyOverrideSkeleton.forEach(ev => {
    const s = parseTimeToMinutes(ev.startTime), e = parseTimeToMinutes(ev.endTime);
    if (s != null && (lo == null || s < lo)) lo = s;
    if (e != null && (hi == null || e > hi)) hi = e;
  });
  return { lo: lo ?? 480, hi: hi ?? 1020 };
}

function getAllLocations() {
  const globalSettings = window.loadGlobalSettings?.() || {};
  const app1 = globalSettings.app1 || {};
  const fields = (app1.fields || []).map(f => f.name);
  const specialActivities = (app1.specialActivities || []).map(s => s.name);
  const facilities = (app1.facilities || []).map(f => f.name || f);
  return [...new Set([...fields, ...facilities, ...specialActivities])].sort();
}

// =================================================================
// SMART TILE HISTORY
// =================================================================
function loadSmartTileHistory() {
  try {
    const g = window.loadGlobalSettings?.() || {};
    if (g.smartTileHistory && g.smartTileHistory.byBunk) {
      return g.smartTileHistory;
    }
    if (!window.localStorage) return { byBunk: {} };
    const raw = localStorage.getItem(SMART_TILE_HISTORY_KEY);
    if (!raw) return { byBunk: {} };
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === "object" && parsed.byBunk) ? parsed : { byBunk: {} };
  } catch (e) { 
    return { byBunk: {} }; 
  }
}

function saveSmartTileHistory(history) {
  try {
    if (window.localStorage) {
      localStorage.setItem(SMART_TILE_HISTORY_KEY, JSON.stringify(history || { byBunk: {} }));
    }
    window.saveGlobalSettings?.("smartTileHistory", history || { byBunk: {} });
  } catch (e) {
    console.error("Failed to save smart tile history:", e);
  }
}

// =================================================================
// MODAL SYSTEM - From master_schedule_builder.js
// =================================================================
function showModal(config) {
  return new Promise((resolve) => {
    const existing = document.getElementById('da-modal-overlay');
    if (existing) existing.remove();
    
    const overlay = document.createElement('div');
    overlay.id = 'da-modal-overlay';
    overlay.innerHTML = `
      <div class="da-modal">
        <div class="da-modal-header">
          <h3>${config.title || 'Input Required'}</h3>
          <button class="da-modal-close">&times;</button>
        </div>
        <div class="da-modal-body">
          ${config.description ? `<p class="da-modal-desc">${config.description}</p>` : ''}
          <div class="da-modal-fields"></div>
        </div>
        <div class="da-modal-footer">
          <button class="da-btn da-btn-ghost da-modal-cancel">Cancel</button>
          <button class="da-btn da-btn-primary da-modal-confirm">${config.confirmText || 'Confirm'}</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(overlay);
    
    const fieldsContainer = overlay.querySelector('.da-modal-fields');
    const inputs = {};
    
    (config.fields || []).forEach(field => {
      const fieldEl = document.createElement('div');
      fieldEl.className = 'da-modal-field';
      
      if (field.type === 'text' || field.type === 'time') {
        fieldEl.innerHTML = `
          <label>${field.label}</label>
          <input type="text" class="da-modal-input" data-field="${field.name}"
                 value="${field.default || ''}" placeholder="${field.placeholder || ''}">
        `;
        inputs[field.name] = () => fieldEl.querySelector('input').value;
      }
      else if (field.type === 'select') {
        const options = (field.options || []).map(o => 
          `<option value="${o.value || o}" ${o === field.default ? 'selected' : ''}>${o.label || o}</option>`
        ).join('');
        fieldEl.innerHTML = `
          <label>${field.label}</label>
          <select class="da-modal-input" data-field="${field.name}">${options}</select>
        `;
        inputs[field.name] = () => fieldEl.querySelector('select').value;
      }
      else if (field.type === 'checkbox-group') {
        const checkboxes = (field.options || []).map(o => `
          <label class="da-checkbox-item">
            <input type="checkbox" value="${o}" data-group="${field.name}">
            <span>${o}</span>
          </label>
        `).join('');
        fieldEl.innerHTML = `
          <label>${field.label}</label>
          <div class="da-checkbox-group">${checkboxes}</div>
        `;
        inputs[field.name] = () => {
          const checked = fieldEl.querySelectorAll(`input[data-group="${field.name}"]:checked`);
          return Array.from(checked).map(c => c.value);
        };
      }
      
      fieldsContainer.appendChild(fieldEl);
    });
    
    setTimeout(() => {
      const firstInput = overlay.querySelector('.da-modal-input');
      if (firstInput) firstInput.focus();
    }, 50);
    
    const close = (result) => { overlay.remove(); resolve(result); };
    
    overlay.querySelector('.da-modal-close').onclick = () => close(null);
    overlay.querySelector('.da-modal-cancel').onclick = () => close(null);
    overlay.onclick = (e) => { if (e.target === overlay) close(null); };
    
    overlay.querySelector('.da-modal-confirm').onclick = () => {
      const result = {};
      Object.keys(inputs).forEach(key => { result[key] = inputs[key](); });
      close(result);
    };
    
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
        overlay.querySelector('.da-modal-confirm').click();
      }
      if (e.key === 'Escape') close(null);
    });
  });
}

function showConfirm(message) {
  return new Promise((resolve) => {
    const existing = document.getElementById('da-modal-overlay');
    if (existing) existing.remove();
    
    const overlay = document.createElement('div');
    overlay.id = 'da-modal-overlay';
    overlay.innerHTML = `
      <div class="da-modal da-modal-sm">
        <div class="da-modal-body" style="padding:24px;">
          <p style="margin:0;font-size:14px;color:#334155;">${message}</p>
        </div>
        <div class="da-modal-footer">
          <button class="da-btn da-btn-ghost da-modal-cancel">Cancel</button>
          <button class="da-btn da-btn-primary da-modal-confirm-btn">Confirm</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(overlay);
    
    overlay.querySelector('.da-modal-cancel').onclick = () => { overlay.remove(); resolve(false); };
    overlay.querySelector('.da-modal-confirm-btn').onclick = () => { overlay.remove(); resolve(true); };
    overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } };
  });
}

function showAlert(message) {
  return new Promise((resolve) => {
    const existing = document.getElementById('da-modal-overlay');
    if (existing) existing.remove();
    
    const overlay = document.createElement('div');
    overlay.id = 'da-modal-overlay';
    overlay.innerHTML = `
      <div class="da-modal da-modal-sm">
        <div class="da-modal-body" style="padding:24px;">
          <p style="margin:0;font-size:14px;color:#334155;">${message}</p>
        </div>
        <div class="da-modal-footer">
          <button class="da-btn da-btn-primary da-modal-ok">OK</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(overlay);
    overlay.querySelector('.da-modal-ok').onclick = () => { overlay.remove(); resolve(); };
    overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); resolve(); } };
  });
}

// =================================================================
// NOTIFICATION SYSTEM
// =================================================================
function notify(msg) {
  const existing = document.getElementById('da-notify');
  if (existing) existing.remove();
  
  const notif = document.createElement('div');
  notif.id = 'da-notify';
  notif.textContent = msg;
  document.body.appendChild(notif);
  
  requestAnimationFrame(() => notif.classList.add('on'));
  setTimeout(() => {
    notif.classList.remove('on');
    setTimeout(() => notif.remove(), 300);
  }, 2500);
}

// =================================================================
// RAINY DAY MODE
// =================================================================
function isRainyDayActive() {
  const dailyData = window.loadCurrentDailyData?.() || {};
  return dailyData.rainyDayMode === true;
}

function isMidDayModeActive() {
  const dailyData = window.loadCurrentDailyData?.() || {};
  return dailyData.rainyDayStartTime !== null && dailyData.rainyDayStartTime !== undefined;
}

function getMidDayStartTime() {
  const dailyData = window.loadCurrentDailyData?.() || {};
  return dailyData.rainyDayStartTime || null;
}

function getPreservedSlotCount() {
  const startTime = getMidDayStartTime();
  if (startTime === null) return 0;
  const times = window.unifiedTimes || [];
  let count = 0;
  for (let i = 0; i < times.length; i++) {
    const slot = times[i];
    if (slot && slot.start) {
      const slotStart = new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes();
      if (slotStart < startTime) count++;
    }
  }
  return count;
}

function isAutoSkeletonSwitchEnabled() {
  const g = window.loadGlobalSettings?.() || {};
  return g.rainyDayAutoSkeletonSwitch === true;
}

function setAutoSkeletonSwitch(enabled) {
  window.saveGlobalSettings?.("rainyDayAutoSkeletonSwitch", enabled);
}

function getRainyDaySkeletonName() {
  const g = window.loadGlobalSettings?.() || {};
  return g.rainyDaySkeletonName || null;
}

function setRainyDaySkeletonName(name) {
  window.saveGlobalSettings?.("rainyDaySkeletonName", name);
  window.forceSyncToCloud?.();
}

function getAvailableSkeletons() {
  const g = window.loadGlobalSettings?.() || {};
  const savedSkeletons = g.app1?.savedSkeletons || {};
  return Object.keys(savedSkeletons).sort();
}

function getRainyDayStats() {
  const g = window.loadGlobalSettings?.() || {};
  const fields = g.app1?.fields || [];
  const specials = g.app1?.specialActivities || [];
  return {
    indoorFields: fields.filter(f => f.rainyDayAvailable === true).length,
    outdoorFields: fields.filter(f => f.rainyDayAvailable !== true).length,
    rainySpecials: specials.filter(s => s.rainyDayOnly === true).length,
    outdoorFieldNames: fields.filter(f => f.rainyDayAvailable !== true).map(f => f.name)
  };
}

function activateFullDayRainyMode() {
  if (!window.AccessControl?.checkEditAccess?.('activate rainy day mode')) return;
  const dailyData = window.loadCurrentDailyData?.() || {};
  const overrides = dailyData.overrides || {};
  const stats = getRainyDayStats();
  
  if (!dailyData.preRainyDayDisabledFields) {
    window.saveCurrentDailyData?.("preRainyDayDisabledFields", overrides.disabledFields || []);
  }
  
  const existingDisabled = overrides.disabledFields || [];
  const newDisabled = [...new Set([...existingDisabled, ...stats.outdoorFieldNames])];
  
  overrides.disabledFields = newDisabled;
  currentOverrides.disabledFields = newDisabled;
  window.saveCurrentDailyData?.("overrides", overrides);
  window.saveCurrentDailyData?.("rainyDayMode", true);
  window.saveCurrentDailyData?.("rainyDayStartTime", null);
  
  if (isAutoSkeletonSwitchEnabled()) {
    switchToRainySkeleton();
  }
  
  showRainyDayNotification(true, stats.outdoorFieldNames.length);
}

function activateMidDayRainyMode() {
  if (!window.AccessControl?.checkEditAccess?.('activate mid-day rainy mode')) return;
  const dailyData = window.loadCurrentDailyData?.() || {};
  const overrides = dailyData.overrides || {};
  const stats = getRainyDayStats();
  
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  
  if (!dailyData.preRainyDayDisabledFields) {
    window.saveCurrentDailyData?.("preRainyDayDisabledFields", overrides.disabledFields || []);
  }
  
  const existingDisabled = overrides.disabledFields || [];
  const newDisabled = [...new Set([...existingDisabled, ...stats.outdoorFieldNames])];
  
  overrides.disabledFields = newDisabled;
  currentOverrides.disabledFields = newDisabled;
  window.saveCurrentDailyData?.("overrides", overrides);
  window.saveCurrentDailyData?.("rainyDayMode", true);
  window.saveCurrentDailyData?.("rainyDayStartTime", currentMinutes);
  
  const preservedCount = getPreservedSlotCount();
  showRainyDayNotification(true, stats.outdoorFieldNames.length, true, false, preservedCount);
}

function switchToRainySkeleton() {
  const skeletonName = getRainyDaySkeletonName();
  if (!skeletonName) return false;
  
  const g = window.loadGlobalSettings?.() || {};
  const savedSkeletons = g.app1?.savedSkeletons || {};
  const skeleton = savedSkeletons[skeletonName];
  
  if (!skeleton || skeleton.length === 0) return false;
  
  const dailyData = window.loadCurrentDailyData?.() || {};
  const currentSkeleton = dailyData.manualSkeleton || [];
  if (currentSkeleton.length > 0) {
    window.saveCurrentDailyData?.("preRainyDayManualSkeleton", JSON.parse(JSON.stringify(currentSkeleton)));
  }
  
  window.saveCurrentDailyData?.("manualSkeleton", JSON.parse(JSON.stringify(skeleton)));
  dailyOverrideSkeleton = JSON.parse(JSON.stringify(skeleton));
  window.dailyOverrideSkeleton = dailyOverrideSkeleton;
  
  return true;
}

function deactivateRainyDayMode() {
  const dailyData = window.loadCurrentDailyData?.() || {};
  const preRainyDisabled = dailyData.preRainyDayDisabledFields || [];
  
  const overrides = dailyData.overrides || {};
  overrides.disabledFields = preRainyDisabled;
  currentOverrides.disabledFields = preRainyDisabled;
  
  window.saveCurrentDailyData?.("overrides", overrides);
  window.saveCurrentDailyData?.("preRainyDayDisabledFields", null);
  window.saveCurrentDailyData?.("rainyDayMode", false);
  window.saveCurrentDailyData?.("rainyDayStartTime", null);
  window.saveCurrentDailyData?.("preservedScheduleBackup", null);
  
  if (isAutoSkeletonSwitchEnabled()) {
    restorePreRainySkeleton();
  }
  
  showRainyDayNotification(false);
}

function restorePreRainySkeleton() {
  const dailyData = window.loadCurrentDailyData?.() || {};
  const backup = dailyData.preRainyDayManualSkeleton;
  
  if (backup && backup.length > 0) {
    window.saveCurrentDailyData?.("manualSkeleton", JSON.parse(JSON.stringify(backup)));
    window.saveCurrentDailyData?.("preRainyDayManualSkeleton", null);
    dailyOverrideSkeleton = JSON.parse(JSON.stringify(backup));
    window.dailyOverrideSkeleton = dailyOverrideSkeleton;
    return true;
  }
  return false;
}

function showRainyDayNotification(activated, disabledCount = 0, isMidDay = false, skeletonSwitched = false, preservedCount = 0) {
  const existing = document.getElementById('rainy-notification');
  if (existing) existing.remove();
  
  const notif = document.createElement('div');
  notif.id = 'rainy-notification';
  
  if (activated) {
    notif.className = 'da-notif-rainy active';
    let subtitle = `${disabledCount} outdoor field${disabledCount !== 1 ? 's' : ''} disabled`;
    if (isMidDay) {
      subtitle = `${preservedCount} slot${preservedCount !== 1 ? 's' : ''} preserved • ${disabledCount} field${disabledCount !== 1 ? 's' : ''} disabled`;
    }
    notif.innerHTML = `
      <span class="notif-icon">${isMidDay ? '⏰' : '🌧️'}</span>
      <div>
        <div class="notif-title">${isMidDay ? 'Mid-Day Mode Activated' : 'Rainy Day Mode Activated'}</div>
        <div class="notif-subtitle">${subtitle}${skeletonSwitched ? ' • Skeleton switched' : ''}</div>
      </div>
    `;
  } else {
    notif.className = 'da-notif-rainy inactive';
    notif.innerHTML = `
      <span class="notif-icon">☀️</span>
      <div>
        <div class="notif-title">Normal Mode Restored</div>
        <div class="notif-subtitle">All fields back to normal availability</div>
      </div>
    `;
  }
  
  document.body.appendChild(notif);
  requestAnimationFrame(() => notif.classList.add('show'));
  
  setTimeout(() => {
    notif.classList.remove('show');
    setTimeout(() => notif.remove(), 300);
  }, 4000);
}

// =================================================================
// SKELETON PERSISTENCE
// =================================================================
function loadDailySkeleton() {
  const dailyData = window.loadCurrentDailyData?.() || {};
  const manualSkeleton = dailyData.manualSkeleton;
  
  if (manualSkeleton && Array.isArray(manualSkeleton) && manualSkeleton.length > 0) {
    dailyOverrideSkeleton = JSON.parse(JSON.stringify(manualSkeleton));
  } else {
    const assignments = window.getSkeletonAssignments?.() || {};
    const skeletons = window.getSavedSkeletons?.() || {};
    const dateStr = window.currentScheduleDate || "";
    const [Y, M, D] = dateStr.split('-').map(Number);
    let dow = 0;
    if (Y && M && D) dow = new Date(Y, M - 1, D).getDay();
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const today = dayNames[dow];
    let tmpl = assignments[today] || assignments["Default"];
    dailyOverrideSkeleton = (tmpl && skeletons[tmpl]) ? JSON.parse(JSON.stringify(skeletons[tmpl])) : [];
  }
  
  window.dailyOverrideSkeleton = dailyOverrideSkeleton;
}

function saveDailySkeleton() {
  window.saveCurrentDailyData?.("manualSkeleton", JSON.parse(JSON.stringify(dailyOverrideSkeleton)));
  window.dailyOverrideSkeleton = dailyOverrideSkeleton;
  window.forceSyncToCloud?.();
}

function loadSkeletonToEditor(name) {
  const all = window.getSavedSkeletons?.() || {};
  if (all[name]) {
    dailyOverrideSkeleton = JSON.parse(JSON.stringify(all[name]));
    window.dailyOverrideSkeleton = dailyOverrideSkeleton;
    saveDailySkeleton();
    notify(`Loaded: ${name}`);
  }
}

// =================================================================
// MAIN INIT
// =================================================================
function init() {
  container = document.getElementById("daily-adjustments-content");
  if (!container) return;
  
  // Load settings
  masterSettings = {
    global: window.loadGlobalSettings?.() || {},
    get app1() { return this.global.app1 || {}; }
  };
  
  smartTileHistory = loadSmartTileHistory();
  loadDailySkeleton();
  loadCurrentOverrides();
  
  // Inject CSS + HTML
  container.innerHTML = getMainStyles() + getMainHTML();
  
  // Setup references
  skeletonContainer = document.getElementById("da-skeleton-container");
  tripsFormContainer = document.getElementById("da-trips-container");
  bunkOverridesContainer = document.getElementById("da-bunk-overrides-container");
  resourceOverridesContainer = document.getElementById("da-resources-container");
  
  // Setup event handlers
  setupSubTabs();
  setupKeyboardHandler();
  setupVisibilityHandler();
  
  // Render all sections
  renderSkeletonEditor();
  renderRainyDayPanel();
  renderTripsForm();
  renderBunkOverridesUI();
  renderResourceOverridesUI();
}

function cleanup() {
  if (_keyHandler) {
    document.removeEventListener('keydown', _keyHandler);
    _keyHandler = null;
  }
  if (_visHandler) {
    document.removeEventListener('visibilitychange', _visHandler);
    _visHandler = null;
  }
}

function setupKeyboardHandler() {
  if (_keyHandler) document.removeEventListener('keydown', _keyHandler);
  
  _keyHandler = (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedTileId) {
      e.preventDefault();
      deleteTile(selectedTileId);
    }
    if (e.key === 'Escape') {
      deselectAllTiles();
    }
  };
  
  document.addEventListener('keydown', _keyHandler);
}

function setupVisibilityHandler() {
  if (_visHandler) document.removeEventListener('visibilitychange', _visHandler);
  
  _visHandler = () => {
    if (document.visibilityState === 'visible') {
      refreshFromCloud();
    }
  };
  
  document.addEventListener('visibilitychange', _visHandler);
}

function refreshFromCloud() {
  masterSettings.global = window.loadGlobalSettings?.() || {};
  loadDailySkeleton();
  loadCurrentOverrides();
  renderGrid();
  renderResourceOverridesUI();
}

// =================================================================
// CSS STYLES
// =================================================================
function getMainStyles() {
  return `<style>
    /* === DAILY ADJUSTMENTS - MASTER BUILDER STYLE === */
    :root {
      --da-bg: #ffffff;
      --da-surface: #f8fafc;
      --da-border: #e2e8f0;
      --da-text: #0f172a;
      --da-text2: #475569;
      --da-text3: #94a3b8;
      --da-accent: #3b82f6;
      --da-success: #10b981;
      --da-warning: #f59e0b;
      --da-danger: #ef4444;
      --da-r: 8px;
    }
    
    /* Container Layout */
    .da-container {
      display: flex;
      gap: 0;
      height: calc(100vh - 140px);
      min-height: 500px;
      background: var(--da-bg);
      border: 1px solid var(--da-border);
      border-radius: 12px;
      overflow: hidden;
    }
    
    /* Left Sidebar */
    .da-sidebar {
      width: 200px;
      min-width: 200px;
      background: var(--da-surface);
      border-right: 1px solid var(--da-border);
      display: flex;
      flex-direction: column;
      height: 100%;
    }
    
    .da-sidebar-header {
      padding: 16px 14px;
      border-bottom: 1px solid var(--da-border);
      background: var(--da-bg);
    }
    
    .da-sidebar-header h3 {
      margin: 0;
      font-size: 13px;
      font-weight: 600;
      color: var(--da-text2);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    
    /* Palette */
    .da-palette {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      scrollbar-width: thin;
      scrollbar-color: #cbd5e1 #f1f5f9;
    }
    
    .da-palette::-webkit-scrollbar { width: 6px; }
    .da-palette::-webkit-scrollbar-track { background: #f1f5f9; border-radius: 3px; }
    .da-palette::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
    
    .da-tile {
      padding: 10px 12px;
      border-radius: 6px;
      cursor: grab;
      font-size: 12px;
      font-weight: 600;
      transition: transform 0.15s, box-shadow 0.15s;
      text-shadow: 0 1px 2px rgba(0,0,0,0.1);
    }
    
    .da-tile:hover {
      transform: translateX(3px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    }
    
    .da-tile:active { cursor: grabbing; }
    
    .da-tile-divider {
      height: 1px;
      background: var(--da-border);
      margin: 6px 0;
    }
    
    .da-tile-label {
      font-size: 10px;
      color: var(--da-text3);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 4px 0;
    }
    
    /* Main Content */
    .da-main {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    
    /* Sub-tabs Navigation */
    .da-subtabs {
      display: flex;
      gap: 0;
      background: var(--da-bg);
      border-bottom: 1px solid var(--da-border);
      padding: 0 16px;
    }
    
    .da-subtab {
      padding: 12px 18px;
      font-size: 13px;
      font-weight: 500;
      color: var(--da-text2);
      cursor: pointer;
      border: none;
      background: none;
      position: relative;
      transition: color 0.15s;
    }
    
    .da-subtab:hover { color: var(--da-text); }
    
    .da-subtab.active {
      color: var(--da-accent);
      font-weight: 600;
    }
    
    .da-subtab.active::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: var(--da-accent);
      border-radius: 2px 2px 0 0;
    }
    
    /* Content Panes */
    .da-pane {
      display: none;
      flex: 1;
      overflow: auto;
      padding: 16px;
    }
    
    .da-pane.active { display: flex; flex-direction: column; }
    
    /* Toolbar */
    .da-toolbar {
      background: var(--da-bg);
      border-bottom: 1px solid var(--da-border);
      padding: 12px 16px;
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    
    .da-toolbar-group {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 12px;
      border-right: 1px solid var(--da-border);
    }
    
    .da-toolbar-group:last-child { border-right: none; }
    
    .da-toolbar-label {
      font-size: 11px;
      color: var(--da-text3);
      font-weight: 500;
    }
    
    /* Buttons */
    .da-btn {
      padding: 8px 14px;
      border: none;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    
    .da-btn-primary { background: var(--da-accent); color: #fff; }
    .da-btn-primary:hover { background: #2563eb; }
    .da-btn-success { background: var(--da-success); color: #fff; }
    .da-btn-success:hover { background: #059669; }
    .da-btn-warning { background: var(--da-warning); color: #fff; }
    .da-btn-warning:hover { background: #d97706; }
    .da-btn-danger { background: var(--da-danger); color: #fff; }
    .da-btn-danger:hover { background: #dc2626; }
    .da-btn-ghost { background: var(--da-surface); color: var(--da-text2); }
    .da-btn-ghost:hover { background: var(--da-border); }
    .da-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    
    /* Select & Input */
    .da-select, .da-input {
      padding: 8px 12px;
      border: 1px solid var(--da-border);
      border-radius: 6px;
      font-size: 12px;
      background: var(--da-bg);
      min-width: 140px;
    }
    
    .da-select:focus, .da-input:focus {
      outline: none;
      border-color: var(--da-accent);
      box-shadow: 0 0 0 3px rgba(59,130,246,0.1);
    }
    
    /* Grid Area */
    .da-grid-wrapper {
      flex: 1;
      overflow: auto;
      background: var(--da-bg);
    }
    
    .da-grid {
      display: flex;
      position: relative;
      min-width: max-content;
    }
    
    .da-time-rail {
      position: sticky;
      left: 0;
      z-index: 30;
      background: var(--da-bg);
      border-right: 1px solid var(--da-border);
      width: 72px;
      padding-top: 10px;
    }
    
    .da-time-label {
      position: absolute;
      right: 8px;
      font-size: 11px;
      color: var(--da-text3);
      font-weight: 500;
      transform: translateY(-50%);
    }
    
    .da-cols {
      display: flex;
      flex: 1;
    }
    
    .da-col {
      flex: 1;
      min-width: 120px;
      border-right: 1px solid var(--da-border);
      position: relative;
    }
    
    .da-col:last-child { border-right: none; }
    
    .da-col-header {
      position: sticky;
      top: 0;
      z-index: 20;
      background: var(--da-surface);
      padding: 10px 8px;
      text-align: center;
      font-size: 12px;
      font-weight: 600;
      color: var(--da-text);
      border-bottom: 1px solid var(--da-border);
    }
    
    .da-col-body {
      position: relative;
      background: var(--da-bg);
    }
    
    .da-hour-line {
      position: absolute;
      left: 0;
      right: 0;
      height: 1px;
      background: var(--da-border);
    }
    
    .da-off-hours {
      position: absolute;
      left: 0;
      right: 0;
      background: repeating-linear-gradient(-45deg, #f1f5f9, #f1f5f9 10px, #e2e8f0 10px, #e2e8f0 11px);
      z-index: 1;
      pointer-events: none;
    }
    
    /* Grid Events */
    .da-event {
      position: absolute;
      left: 4px;
      right: 4px;
      border-radius: 6px;
      padding: 6px 8px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      z-index: 10;
      transition: box-shadow 0.15s, outline 0.15s;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }
    
    .da-event:hover {
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 11;
    }
    
    .da-event.selected {
      outline: 3px solid var(--da-accent);
      outline-offset: -1px;
      box-shadow: 0 0 0 4px rgba(59,130,246,0.2);
      z-index: 12;
    }
    
    .da-event-name {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    
    .da-event-time {
      font-size: 9px;
      opacity: 0.8;
      margin-top: 2px;
    }
    
    /* Resize Handles */
    .da-resize-handle {
      position: absolute;
      left: 0;
      right: 0;
      height: 8px;
      cursor: ns-resize;
      z-index: 15;
      opacity: 0;
      transition: opacity 0.15s;
    }
    
    .da-resize-top { top: -2px; }
    .da-resize-bottom { bottom: -2px; }
    
    .da-event:hover .da-resize-handle {
      opacity: 1;
      background: rgba(59,130,246,0.4);
    }
    
    /* Drop Preview */
    .da-drop-preview {
      display: none;
      position: absolute;
      left: 4px;
      right: 4px;
      background: rgba(59,130,246,0.15);
      border: 2px dashed var(--da-accent);
      border-radius: 6px;
      pointer-events: none;
      z-index: 5;
    }
    
    .da-preview-label {
      text-align: center;
      padding: 6px;
      color: #1d4ed8;
      font-weight: 600;
      font-size: 11px;
      background: rgba(255,255,255,0.95);
      border-radius: 4px;
      margin: 3px;
    }
    
    /* Modal Styles */
    #da-modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(15,23,42,0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
    }
    
    .da-modal {
      background: var(--da-bg);
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      min-width: 360px;
      max-width: 500px;
      max-height: 80vh;
      overflow: hidden;
    }
    
    .da-modal-sm { min-width: 300px; }
    
    .da-modal-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--da-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    
    .da-modal-header h3 {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
      color: var(--da-text);
    }
    
    .da-modal-close {
      background: none;
      border: none;
      font-size: 20px;
      color: var(--da-text3);
      cursor: pointer;
      padding: 0;
      line-height: 1;
    }
    
    .da-modal-close:hover { color: var(--da-text2); }
    
    .da-modal-body {
      padding: 20px;
      overflow-y: auto;
      max-height: 50vh;
    }
    
    .da-modal-desc {
      margin: 0 0 16px;
      font-size: 13px;
      color: var(--da-text2);
      line-height: 1.5;
    }
    
    .da-modal-field {
      margin-bottom: 16px;
    }
    
    .da-modal-field:last-child { margin-bottom: 0; }
    
    .da-modal-field label {
      display: block;
      font-size: 12px;
      font-weight: 500;
      color: var(--da-text2);
      margin-bottom: 6px;
    }
    
    .da-modal-input {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid var(--da-border);
      border-radius: 6px;
      font-size: 13px;
      box-sizing: border-box;
    }
    
    .da-modal-input:focus {
      outline: none;
      border-color: var(--da-accent);
      box-shadow: 0 0 0 3px rgba(59,130,246,0.1);
    }
    
    .da-modal-footer {
      padding: 16px 20px;
      border-top: 1px solid var(--da-border);
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      background: var(--da-surface);
    }
    
    .da-checkbox-group {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 8px;
      max-height: 200px;
      overflow-y: auto;
      padding: 8px;
      background: var(--da-surface);
      border-radius: 6px;
      border: 1px solid var(--da-border);
    }
    
    .da-checkbox-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      background: var(--da-bg);
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    
    .da-checkbox-item:hover { background: #f1f5f9; }
    .da-checkbox-item input { margin: 0; }
    .da-checkbox-item span { color: var(--da-text); }
    
    /* Notification Toast */
    #da-notify {
      position: fixed;
      bottom: 32px;
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      background: var(--da-text);
      color: white;
      padding: 14px 24px;
      border-radius: 100px;
      font-size: 14px;
      font-weight: 500;
      opacity: 0;
      transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
      z-index: 10001;
    }
    
    #da-notify.on {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
    
    /* Rainy Day Notification */
    .da-notif-rainy {
      position: fixed;
      top: 80px;
      right: 20px;
      padding: 16px 22px;
      border-radius: 14px;
      z-index: 10000;
      display: flex;
      align-items: center;
      gap: 12px;
      font-weight: 500;
      font-size: 0.9rem;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
      transform: translateX(120%);
      transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1);
    }
    
    .da-notif-rainy.show { transform: translateX(0); }
    
    .da-notif-rainy.active {
      background: linear-gradient(135deg, #0c4a6e, #164e63);
      color: #f0f9ff;
      border: 1px solid rgba(14, 165, 233, 0.4);
    }
    
    .da-notif-rainy.inactive {
      background: linear-gradient(135deg, #fef3c7, #fef9c3);
      color: #92400e;
      border: 1px solid #fbbf24;
    }
    
    .da-notif-rainy .notif-icon { font-size: 24px; }
    .da-notif-rainy .notif-title { font-weight: 600; font-size: 0.95rem; }
    .da-notif-rainy .notif-subtitle { font-size: 0.85rem; opacity: 0.85; margin-top: 2px; }
    
    /* Rainy Day Card */
    .da-rainy-card {
      border-radius: 16px;
      overflow: hidden;
      position: relative;
      transition: all 0.4s ease;
      margin-bottom: 16px;
    }
    
    .da-rainy-card.inactive {
      background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
      border: 1px solid #e2e8f0;
    }
    
    .da-rainy-card.active {
      background: linear-gradient(135deg, #0c4a6e 0%, #164e63 50%, #134e4a 100%);
      border: 1px solid rgba(14, 165, 233, 0.3);
      box-shadow: 0 8px 32px rgba(14, 165, 233, 0.15);
    }
    
    .da-rainy-header {
      padding: 20px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      position: relative;
      z-index: 1;
    }
    
    .da-rainy-title-section {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    
    .da-rainy-icon {
      width: 48px;
      height: 48px;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      transition: all 0.4s ease;
    }
    
    .da-rainy-card.inactive .da-rainy-icon { background: #e2e8f0; }
    .da-rainy-card.active .da-rainy-icon {
      background: rgba(14, 165, 233, 0.2);
      box-shadow: 0 0 20px rgba(14, 165, 233, 0.3);
    }
    
    .da-rainy-title {
      font-size: 1.1rem;
      font-weight: 600;
      margin: 0;
    }
    
    .da-rainy-card.inactive .da-rainy-title { color: #334155; }
    .da-rainy-card.active .da-rainy-title { color: #f0f9ff; }
    
    .da-rainy-subtitle {
      font-size: 0.85rem;
      margin: 2px 0 0;
    }
    
    .da-rainy-card.inactive .da-rainy-subtitle { color: #64748b; }
    .da-rainy-card.active .da-rainy-subtitle { color: #7dd3fc; }
    
    .da-rainy-toggle-container {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    
    .da-rainy-status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 12px;
      border-radius: 999px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    
    .da-rainy-status.active {
      background: rgba(14, 165, 233, 0.2);
      color: #7dd3fc;
      border: 1px solid rgba(14, 165, 233, 0.3);
    }
    
    .da-rainy-status.inactive {
      background: #f1f5f9;
      color: #64748b;
      border: 1px solid #e2e8f0;
    }
    
    .da-rainy-status .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
    }
    
    .da-rainy-status.active .status-dot {
      background: #22d3ee;
      box-shadow: 0 0 8px #22d3ee;
    }
    
    .da-rainy-status.inactive .status-dot { background: #94a3b8; }
    
    .da-rainy-toggle {
      position: relative;
      width: 52px;
      height: 26px;
      cursor: pointer;
    }
    
    .da-rainy-toggle input { opacity: 0; width: 0; height: 0; }
    
    .da-rainy-toggle-track {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: #cbd5e1;
      border-radius: 26px;
      transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
    }
    
    .da-rainy-toggle input:checked + .da-rainy-toggle-track {
      background: linear-gradient(135deg, #0ea5e9, #06b6d4);
      box-shadow: 0 0 16px rgba(14, 165, 233, 0.5);
    }
    
    .da-rainy-toggle-thumb {
      position: absolute;
      top: 2px;
      left: 2px;
      width: 22px;
      height: 22px;
      background: white;
      border-radius: 50%;
      transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
    }
    
    .da-rainy-toggle input:checked ~ .da-rainy-toggle-thumb {
      left: 28px;
      background: #f0f9ff;
    }
    
    .da-rainy-stats {
      padding: 0 24px 16px;
      display: flex;
      gap: 20px;
      flex-wrap: wrap;
      position: relative;
      z-index: 1;
    }
    
    .da-rainy-stat {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.85rem;
    }
    
    .da-rainy-card.inactive .da-rainy-stat { color: #64748b; }
    .da-rainy-card.inactive .da-rainy-stat strong { color: #334155; }
    .da-rainy-card.active .da-rainy-stat { color: #bae6fd; }
    .da-rainy-card.active .da-rainy-stat strong { color: #f0f9ff; }
    
    /* Rain Animation */
    .da-rain-container {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      overflow: hidden;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.5s ease;
      border-radius: 16px;
    }
    
    .da-rainy-card.active .da-rain-container { opacity: 1; }
    
    .da-rain-drop {
      position: absolute;
      width: 2px;
      background: linear-gradient(to bottom, transparent, rgba(186, 230, 253, 0.3));
      animation: da-rainFall linear infinite;
    }
    
    @keyframes da-rainFall {
      0% { transform: translateY(-100%); opacity: 0; }
      10% { opacity: 1; }
      90% { opacity: 1; }
      100% { transform: translateY(200px); opacity: 0; }
    }
    
    /* Drag Ghost */
    #da-drag-ghost {
      position: fixed;
      padding: 8px 12px;
      background: var(--da-bg);
      border: 2px solid var(--da-accent);
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(59,130,246,0.25);
      pointer-events: none;
      z-index: 10001;
      display: none;
      font-size: 12px;
      font-weight: 600;
    }
    
    /* Resource Overrides Section */
    .da-section {
      background: var(--da-bg);
      border: 1px solid var(--da-border);
      border-radius: 10px;
      padding: 16px;
      margin-bottom: 16px;
    }
    
    .da-section-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--da-text);
      margin: 0 0 4px;
    }
    
    .da-section-desc {
      font-size: 12px;
      color: var(--da-text3);
      margin: 0 0 12px;
    }
    
    /* Resource Toggle Rows */
    .da-resource-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      background: var(--da-surface);
      border: 1px solid var(--da-border);
      border-radius: 8px;
      margin-bottom: 6px;
      transition: all 0.15s;
    }
    
    .da-resource-row:hover {
      background: #f1f5f9;
      border-color: #d1d5db;
    }
    
    .da-resource-row.disabled {
      background: #fef2f2;
      border-color: #fecaca;
    }
    
    .da-resource-name {
      font-weight: 500;
      font-size: 13px;
      color: var(--da-text);
    }
    
    .da-toggle {
      position: relative;
      width: 44px;
      height: 22px;
    }
    
    .da-toggle input { opacity: 0; width: 0; height: 0; }
    
    .da-toggle-track {
      position: absolute;
      cursor: pointer;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: #ccc;
      transition: 0.3s;
      border-radius: 22px;
    }
    
    .da-toggle-track:before {
      position: absolute;
      content: "";
      height: 16px;
      width: 16px;
      left: 3px;
      bottom: 3px;
      background: white;
      transition: 0.3s;
      border-radius: 50%;
    }
    
    .da-toggle input:checked + .da-toggle-track { background: var(--da-success); }
    .da-toggle input:checked + .da-toggle-track:before { transform: translateX(22px); }
    
    /* List Panel for Overrides */
    .da-list-panel {
      display: flex;
      gap: 16px;
    }
    
    .da-list-sidebar {
      width: 220px;
      border: 1px solid var(--da-border);
      border-radius: 8px;
      overflow: hidden;
    }
    
    .da-list-header {
      padding: 12px;
      background: var(--da-surface);
      border-bottom: 1px solid var(--da-border);
      font-size: 12px;
      font-weight: 600;
      color: var(--da-text2);
    }
    
    .da-list-items {
      max-height: 300px;
      overflow-y: auto;
    }
    
    .da-list-item {
      padding: 10px 12px;
      cursor: pointer;
      border-bottom: 1px solid var(--da-border);
      font-size: 13px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      transition: background 0.15s;
    }
    
    .da-list-item:last-child { border-bottom: none; }
    .da-list-item:hover { background: var(--da-surface); }
    .da-list-item.selected { background: #e0f2fe; border-left: 3px solid var(--da-accent); }
    
    .da-list-item-name { font-weight: 500; }
    
    .da-detail-pane {
      flex: 1;
      border: 1px solid var(--da-border);
      border-radius: 8px;
      padding: 16px;
      background: var(--da-surface);
      min-height: 200px;
    }
    
    .da-detail-title {
      font-size: 14px;
      font-weight: 600;
      margin: 0 0 12px;
      color: var(--da-text);
    }
    
    .da-detail-empty {
      color: var(--da-text3);
      font-size: 13px;
      text-align: center;
      padding: 40px;
    }
    
    /* Bunk Override Form */
    .da-form-row {
      display: flex;
      gap: 12px;
      align-items: flex-end;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }
    
    .da-form-field {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    
    .da-form-field label {
      font-size: 11px;
      font-weight: 500;
      color: var(--da-text2);
    }
    
    .da-override-list {
      margin-top: 16px;
    }
    
    .da-override-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      background: var(--da-bg);
      border: 1px solid var(--da-border);
      border-radius: 6px;
      margin-bottom: 6px;
    }
    
    .da-override-item-info {
      font-size: 13px;
    }
    
    .da-override-item-info strong {
      color: var(--da-text);
    }
    
    .da-override-item-info span {
      color: var(--da-text2);
      font-size: 12px;
    }
    
    .da-btn-sm {
      padding: 4px 8px;
      font-size: 11px;
    }
  </style>`;
}

// =================================================================
// MAIN HTML STRUCTURE
// =================================================================
function getMainHTML() {
  return `
    <div class="da-container">
      <!-- Left Sidebar - Tile Palette -->
      <div class="da-sidebar">
        <div class="da-sidebar-header">
          <h3>Tile Types</h3>
        </div>
        <div id="da-palette" class="da-palette"></div>
      </div>
      
      <!-- Main Content -->
      <div class="da-main">
        <!-- Sub-tabs -->
        <div class="da-subtabs">
          <button class="da-subtab active" data-tab="skeleton">Schedule</button>
          <button class="da-subtab" data-tab="resources">Resources</button>
          <button class="da-subtab" data-tab="bunk-overrides">Bunk Overrides</button>
          <button class="da-subtab" data-tab="trips">Trips</button>
        </div>
        
        <!-- Skeleton Pane -->
        <div id="da-pane-skeleton" class="da-pane active">
          <div id="da-rainy-panel"></div>
          <div id="da-skeleton-toolbar" class="da-toolbar"></div>
          <div id="da-skeleton-container" class="da-grid-wrapper"></div>
        </div>
        
        <!-- Resources Pane -->
        <div id="da-pane-resources" class="da-pane">
          <div id="da-resources-container"></div>
        </div>
        
        <!-- Bunk Overrides Pane -->
        <div id="da-pane-bunk-overrides" class="da-pane">
          <div id="da-bunk-overrides-container"></div>
        </div>
        
        <!-- Trips Pane -->
        <div id="da-pane-trips" class="da-pane">
          <div id="da-trips-container"></div>
        </div>
      </div>
    </div>
    
    <!-- Drag Ghost -->
    <div id="da-drag-ghost"></div>
  `;
}

// =================================================================
// SUB-TAB NAVIGATION
// =================================================================
function setupSubTabs() {
  const tabs = container.querySelectorAll('.da-subtab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      const panes = container.querySelectorAll('.da-pane');
      panes.forEach(p => p.classList.remove('active'));
      
      const tabId = tab.dataset.tab;
      const pane = container.querySelector(`#da-pane-${tabId}`);
      if (pane) pane.classList.add('active');
      
      activeSubTab = tabId;
    });
  });
}

// =================================================================
// SKELETON EDITOR
// =================================================================
function renderSkeletonEditor() {
  renderPalette();
  renderToolbar();
  renderGrid();
}

function renderPalette() {
  const palette = document.getElementById('da-palette');
  if (!palette) return;
  
  palette.innerHTML = '';
  
  const categories = [
    { label: 'Slots', types: ['activity', 'sports', 'special'] },
    { label: 'Advanced', types: ['smart', 'split', 'elective'] },
    { label: 'Leagues', types: ['league', 'specialty_league'] },
    { label: 'Fixed', types: ['swim', 'lunch', 'snacks', 'dismissal', 'custom'] }
  ];
  
  categories.forEach((cat, catIndex) => {
    const label = document.createElement('div');
    label.className = 'da-tile-label';
    label.textContent = cat.label;
    palette.appendChild(label);
    
    cat.types.forEach(type => {
      const tile = TILES.find(t => t.type === type);
      if (!tile) return;
      
      const el = document.createElement('div');
      el.className = 'da-tile';
      el.textContent = tile.name;
      el.style.cssText = tile.style;
      el.draggable = true;
      el.title = tile.description || '';
      
      el.onclick = (e) => {
        if (e.detail === 1) {
          setTimeout(() => { if (!el.dragging) showTileInfo(tile); }, 200);
        }
      };
      
      el.ondragstart = (e) => {
        el.dragging = true;
        e.dataTransfer.setData('application/json', JSON.stringify(tile));
      };
      el.ondragend = () => { el.dragging = false; };
      
      // Mobile touch support
      let touchStartY = 0;
      el.addEventListener('touchstart', (e) => {
        touchStartY = e.touches[0].clientY;
        el.dataset.tileData = JSON.stringify(tile);
        el.style.opacity = '0.6';
      });
      
      el.addEventListener('touchend', (e) => {
        el.style.opacity = '1';
        const touch = e.changedTouches[0];
        if (Math.abs(touch.clientY - touchStartY) < 10) {
          showTileInfo(tile);
          return;
        }
        const elementAtPoint = document.elementFromPoint(touch.clientX, touch.clientY);
        const cell = elementAtPoint?.closest('.da-col-body');
        if (cell) {
          handleDrop(cell, tile, touch.clientY);
        }
      });
      
      palette.appendChild(el);
    });
    
    if (catIndex < categories.length - 1) {
      const divider = document.createElement('div');
      divider.className = 'da-tile-divider';
      palette.appendChild(divider);
    }
  });
}

function showTileInfo(tile) {
  const descriptions = {
    'activity': 'ACTIVITY SLOT\n\nA flexible time block where the scheduler assigns either a sport or special activity based on availability and fairness rules.',
    'sports': 'SPORTS SLOT\n\nDedicated time for sports activities only. The scheduler will assign an available field and sport.',
    'special': 'SPECIAL ACTIVITY\n\nReserved for special activities like arts, drama, music. No field sports during this time.',
    'smart': 'SMART TILE\n\nIntelligent capacity balancing. Fills Activity 1 up to its capacity, overflow goes to Activity 2, then swaps next period.',
    'split': 'SPLIT ACTIVITY\n\nDivides the time in half. First half gets Activity A, second half gets Activity B for all bunks.',
    'elective': 'ELECTIVE\n\nReserve multiple activities exclusively for this division. Other divisions cannot access these during this time.',
    'league': 'LEAGUE GAME\n\nSchedules a competitive league game between two bunks. Requires league setup.',
    'specialty_league': 'SPECIALTY LEAGUE\n\nTournament or bracket-style competitions. Requires specialty league configuration.',
    'swim': 'SWIM (Pinned)\n\nPool/swimming time. Automatically pinned to the pool location.',
    'lunch': 'LUNCH (Pinned)\n\nMeal break. No activities scheduled.',
    'snacks': 'SNACKS (Pinned)\n\nShort refreshment break.',
    'dismissal': 'DISMISSAL (Pinned)\n\nEnd of day. No activities after this.',
    'custom': 'CUSTOM PINNED\n\nCreate a custom fixed event like "Regroup", "Assembly", etc.'
  };
  
  showAlert(descriptions[tile.type] || `${tile.name}\n\n${tile.description}`);
}

function renderToolbar() {
  const toolbar = document.getElementById('da-skeleton-toolbar');
  if (!toolbar) return;
  
  const saved = window.getSavedSkeletons?.() || {};
  const names = Object.keys(saved).sort();
  const loadOptions = names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  
  toolbar.innerHTML = `
    <div class="da-toolbar-group">
      <span class="da-toolbar-label">Template:</span>
      <select id="da-load-select" class="da-select">
        <option value="">Load...</option>
        ${loadOptions}
      </select>
    </div>
    
    <div class="da-toolbar-group">
      <button id="da-clear-btn" class="da-btn da-btn-warning">Clear</button>
      <button id="da-reset-btn" class="da-btn da-btn-ghost">Reset to Default</button>
    </div>
    
    <div style="flex:1;"></div>
    
    <div class="da-toolbar-group" style="border-right:none;">
      <button id="da-generate-btn" class="da-btn da-btn-success">
        <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>
        </svg>
        Generate Schedule
      </button>
    </div>
  `;
  
  // Bind events
  document.getElementById('da-load-select').onchange = async function() {
    const name = this.value;
    if (name && saved[name]) {
      const ok = await showConfirm(`Load template "${name}"? This will replace your current schedule.`);
      if (ok) {
        loadSkeletonToEditor(name);
        renderGrid();
      }
    }
    this.value = '';
  };
  
  document.getElementById('da-clear-btn').onclick = async () => {
    if (!window.AccessControl?.checkEditAccess?.('clear skeleton')) return;
    const ok = await showConfirm('Clear all blocks from today\'s schedule?');
    if (ok) {
      dailyOverrideSkeleton = [];
      saveDailySkeleton();
      renderGrid();
      notify('Schedule cleared');
    }
  };
  
  document.getElementById('da-reset-btn').onclick = async () => {
    if (!window.AccessControl?.checkEditAccess?.('reset skeleton')) return;
    const ok = await showConfirm('Reset to the default template for today?');
    if (ok) {
      window.saveCurrentDailyData?.("manualSkeleton", null);
      loadDailySkeleton();
      renderGrid();
      notify('Reset to default');
    }
  };
  
  document.getElementById('da-generate-btn').onclick = () => {
    runOptimizer();
  };
}

function renderGrid() {
  const gridContainer = document.getElementById('da-skeleton-container');
  if (!gridContainer) return;
  
  const D = window.divisions || {};
  const divs = Object.entries(D).filter(([_, d]) => d?.bunks?.length).sort((a, b) => {
    const numA = parseInt(a[0].replace(/\D/g, '')) || 0;
    const numB = parseInt(b[0].replace(/\D/g, '')) || 0;
    return numA - numB;
  });
  
  if (divs.length === 0) {
    gridContainer.innerHTML = '<div style="padding:40px;text-align:center;color:#64748b;">No divisions configured. Set up divisions in the Setup tab.</div>';
    return;
  }
  
  const bounds = getGridBounds();
  const gridHeight = (bounds.hi - bounds.lo) * PIXELS_PER_MINUTE;
  
  // Build time rail
  let timeRailHTML = '';
  for (let m = bounds.lo; m <= bounds.hi; m += 30) {
    const top = (m - bounds.lo) * PIXELS_PER_MINUTE;
    timeRailHTML += `<div class="da-time-label" style="top:${top}px;">${minutesToTime(m)}</div>`;
  }
  
  // Build columns
  let colsHTML = '';
  divs.forEach(([divName, divData]) => {
    const divStart = parseTimeToMinutes(divData.startTime) || bounds.lo;
    const divEnd = parseTimeToMinutes(divData.endTime) || bounds.hi;
    
    // Off-hours before
    let offBefore = '', offAfter = '';
    if (divStart > bounds.lo) {
      const height = (divStart - bounds.lo) * PIXELS_PER_MINUTE;
      offBefore = `<div class="da-off-hours" style="top:0;height:${height}px;"></div>`;
    }
    if (divEnd < bounds.hi) {
      const top = (divEnd - bounds.lo) * PIXELS_PER_MINUTE;
      const height = (bounds.hi - divEnd) * PIXELS_PER_MINUTE;
      offAfter = `<div class="da-off-hours" style="top:${top}px;height:${height}px;"></div>`;
    }
    
    // Hour lines
    let hourLines = '';
    for (let m = bounds.lo; m <= bounds.hi; m += 60) {
      const top = (m - bounds.lo) * PIXELS_PER_MINUTE;
      hourLines += `<div class="da-hour-line" style="top:${top}px;"></div>`;
    }
    
    // Events for this division
    const divEvents = dailyOverrideSkeleton.filter(ev => {
      if (!ev.divisions) return true;
      return ev.divisions.includes(divName);
    });
    
    let eventsHTML = '';
    divEvents.forEach(ev => {
      const startMin = parseTimeToMinutes(ev.startTime);
      const endMin = parseTimeToMinutes(ev.endTime);
      if (startMin == null || endMin == null) return;
      
      const top = (startMin - bounds.lo) * PIXELS_PER_MINUTE;
      const height = (endMin - startMin) * PIXELS_PER_MINUTE;
      
      const block = BLOCKS[ev.type] || BLOCKS.activity;
      const isDashed = block.dashed ? 'border:2px dashed ' + block.color + ';' : '';
      
      eventsHTML += `
        <div class="da-event ${selectedTileId === ev.id ? 'selected' : ''}" 
             data-id="${ev.id}" data-div="${divName}"
             style="top:${top}px;height:${height}px;background:${block.bg};color:${block.color};${isDashed}">
          <div class="da-event-name">${escapeHtml(ev.name || block.name)}</div>
          <div class="da-event-time">${minutesToTime(startMin)} - ${minutesToTime(endMin)}</div>
          <div class="da-resize-handle da-resize-top"></div>
          <div class="da-resize-handle da-resize-bottom"></div>
        </div>
      `;
    });
    
    colsHTML += `
      <div class="da-col" data-div="${divName}">
        <div class="da-col-header">${escapeHtml(divName)}</div>
        <div class="da-col-body" style="height:${gridHeight}px;">
          ${offBefore}
          ${hourLines}
          ${eventsHTML}
          ${offAfter}
          <div class="da-drop-preview"><div class="da-preview-label"></div></div>
        </div>
      </div>
    `;
  });
  
  gridContainer.innerHTML = `
    <div class="da-grid">
      <div class="da-time-rail" style="height:${gridHeight + 40}px;">
        ${timeRailHTML}
      </div>
      <div class="da-cols">
        ${colsHTML}
      </div>
    </div>
  `;
  
  // Bind event handlers
  bindGridEvents(bounds);
}

function bindGridEvents(bounds) {
  const grid = document.getElementById('da-skeleton-container');
  if (!grid) return;
  
  // Click to select
  grid.querySelectorAll('.da-event').forEach(el => {
    el.onclick = (e) => {
      e.stopPropagation();
      selectTile(el.dataset.id);
    };
    
    el.ondblclick = (e) => {
      e.stopPropagation();
      editTile(el.dataset.id);
    };
  });
  
  // Click grid to deselect
  grid.querySelectorAll('.da-col-body').forEach(body => {
    body.onclick = (e) => {
      if (e.target === body) deselectAllTiles();
    };
    
    // Drop handling
    body.ondragover = (e) => {
      e.preventDefault();
      showDropPreview(body, e.clientY, bounds);
    };
    
    body.ondragleave = () => {
      hideDropPreview(body);
    };
    
    body.ondrop = (e) => {
      e.preventDefault();
      hideDropPreview(body);
      
      try {
        const data = JSON.parse(e.dataTransfer.getData('application/json'));
        handleDrop(body, data, e.clientY, bounds);
      } catch (err) {}
    };
  });
  
  // Resize handles
  grid.querySelectorAll('.da-resize-handle').forEach(handle => {
    handle.onmousedown = (e) => {
      e.stopPropagation();
      e.preventDefault();
      startResize(handle, e, bounds);
    };
  });
}

function selectTile(id) {
  deselectAllTiles();
  selectedTileId = id;
  const el = document.querySelector(`.da-event[data-id="${id}"]`);
  if (el) el.classList.add('selected');
}

function deselectAllTiles() {
  selectedTileId = null;
  document.querySelectorAll('.da-event.selected').forEach(el => el.classList.remove('selected'));
}

async function deleteTile(id) {
  if (!window.AccessControl?.checkEditAccess?.('delete block')) return;
  
  const ok = await showConfirm('Delete this block?');
  if (ok) {
    dailyOverrideSkeleton = dailyOverrideSkeleton.filter(x => x.id !== id);
    selectedTileId = null;
    saveDailySkeleton();
    renderGrid();
    notify('Block deleted');
  }
}

async function editTile(id) {
  const tile = dailyOverrideSkeleton.find(t => t.id === id);
  if (!tile) return;
  
  const result = await showModal({
    title: 'Edit Block',
    fields: [
      { name: 'startTime', label: 'Start Time', type: 'text', default: tile.startTime, placeholder: '9:00 AM' },
      { name: 'endTime', label: 'End Time', type: 'text', default: tile.endTime, placeholder: '10:00 AM' }
    ],
    confirmText: 'Save'
  });
  
  if (result) {
    const startMin = parseTimeToMinutes(result.startTime);
    const endMin = parseTimeToMinutes(result.endTime);
    
    if (startMin == null || endMin == null) {
      await showAlert('Invalid time format. Use format like "9:00 AM" or "2:30pm".');
      return;
    }
    
    if (endMin <= startMin) {
      await showAlert('End time must be after start time.');
      return;
    }
    
    tile.startTime = minutesToTime(startMin);
    tile.endTime = minutesToTime(endMin);
    saveDailySkeleton();
    renderGrid();
    notify('Block updated');
  }
}

function showDropPreview(body, clientY, bounds) {
  const preview = body.querySelector('.da-drop-preview');
  if (!preview) return;
  
  const rect = body.getBoundingClientRect();
  const relY = clientY - rect.top;
  const minutes = Math.round((relY / PIXELS_PER_MINUTE + bounds.lo) / SNAP_MINS) * SNAP_MINS;
  const endMinutes = minutes + INCREMENT_MINS;
  
  const top = (minutes - bounds.lo) * PIXELS_PER_MINUTE;
  const height = INCREMENT_MINS * PIXELS_PER_MINUTE;
  
  preview.style.display = 'block';
  preview.style.top = top + 'px';
  preview.style.height = height + 'px';
  preview.querySelector('.da-preview-label').textContent = `${minutesToTime(minutes)} - ${minutesToTime(endMinutes)}`;
}

function hideDropPreview(body) {
  const preview = body.querySelector('.da-drop-preview');
  if (preview) preview.style.display = 'none';
}

async function handleDrop(body, tileData, clientY, bounds) {
  if (!window.AccessControl?.checkEditAccess?.('add block')) return;
  if (!bounds) bounds = getGridBounds();
  
  const rect = body.getBoundingClientRect();
  const relY = clientY - rect.top;
  const startMinutes = Math.round((relY / PIXELS_PER_MINUTE + bounds.lo) / SNAP_MINS) * SNAP_MINS;
  const endMinutes = startMinutes + INCREMENT_MINS;
  
  const divName = body.closest('.da-col')?.dataset.div;
  
  // Handle special tile types
  if (tileData.type === 'smart') {
    await handleSmartTileDrop(startMinutes, endMinutes, divName);
  } else if (tileData.type === 'split') {
    await handleSplitTileDrop(startMinutes, endMinutes, divName);
  } else if (tileData.type === 'elective') {
    await handleElectiveTileDrop(startMinutes, endMinutes, divName);
  } else if (tileData.type === 'custom') {
    await handleCustomTileDrop(startMinutes, endMinutes, divName);
  } else {
    // Standard tile
    const newEvent = {
      id: genId(),
      type: tileData.type,
      name: tileData.name,
      startTime: minutesToTime(startMinutes),
      endTime: minutesToTime(endMinutes),
      divisions: divName ? [divName] : undefined
    };
    
    dailyOverrideSkeleton.push(newEvent);
    saveDailySkeleton();
    renderGrid();
    notify(`Added ${tileData.name}`);
  }
}

async function handleSmartTileDrop(startMin, endMin, divName) {
  const locations = getAllLocations();
  
  const result = await showModal({
    title: 'Smart Tile Configuration',
    description: 'Smart tiles balance capacity between two activities.',
    fields: [
      { name: 'activity1', label: 'Primary Activity', type: 'select', options: locations },
      { name: 'activity2', label: 'Secondary Activity', type: 'select', options: locations },
      { name: 'fallback', label: 'Fallback Activity', type: 'select', options: ['', ...locations] }
    ],
    confirmText: 'Add Smart Tile'
  });
  
  if (result && result.activity1 && result.activity2) {
    const newEvent = {
      id: genId(),
      type: 'smart',
      name: `Smart: ${result.activity1}/${result.activity2}`,
      startTime: minutesToTime(startMin),
      endTime: minutesToTime(endMin),
      divisions: divName ? [divName] : undefined,
      smartConfig: {
        activity1: result.activity1,
        activity2: result.activity2,
        fallback: result.fallback || null
      }
    };
    
    dailyOverrideSkeleton.push(newEvent);
    saveDailySkeleton();
    renderGrid();
    notify('Added Smart Tile');
  }
}

async function handleSplitTileDrop(startMin, endMin, divName) {
  const result = await showModal({
    title: 'Split Activity Configuration',
    description: 'Split tiles divide time between two activity types.',
    fields: [
      { name: 'type1', label: 'First Half Type', type: 'select', options: ['activity', 'sports', 'special'] },
      { name: 'type2', label: 'Second Half Type', type: 'select', options: ['activity', 'sports', 'special'] }
    ],
    confirmText: 'Add Split Tile'
  });
  
  if (result) {
    const midPoint = startMin + Math.floor((endMin - startMin) / 2);
    
    const newEvent = {
      id: genId(),
      type: 'split',
      name: 'Split Activity',
      startTime: minutesToTime(startMin),
      endTime: minutesToTime(endMin),
      divisions: divName ? [divName] : undefined,
      subEvents: [
        { type: result.type1 || 'activity', startTime: minutesToTime(startMin), endTime: minutesToTime(midPoint) },
        { type: result.type2 || 'special', startTime: minutesToTime(midPoint), endTime: minutesToTime(endMin) }
      ]
    };
    
    dailyOverrideSkeleton.push(newEvent);
    saveDailySkeleton();
    renderGrid();
    notify('Added Split Tile');
  }
}

async function handleElectiveTileDrop(startMin, endMin, divName) {
  const locations = getAllLocations();
  
  const result = await showModal({
    title: 'Elective Configuration',
    description: 'Reserve activities exclusively for this division.',
    fields: [
      { name: 'activities', label: 'Reserved Activities', type: 'checkbox-group', options: locations }
    ],
    confirmText: 'Add Elective'
  });
  
  if (result && result.activities && result.activities.length > 0) {
    const newEvent = {
      id: genId(),
      type: 'elective',
      name: `Elective (${result.activities.length})`,
      startTime: minutesToTime(startMin),
      endTime: minutesToTime(endMin),
      divisions: divName ? [divName] : undefined,
      reservedActivities: result.activities
    };
    
    dailyOverrideSkeleton.push(newEvent);
    saveDailySkeleton();
    renderGrid();
    notify('Added Elective');
  }
}

async function handleCustomTileDrop(startMin, endMin, divName) {
  const result = await showModal({
    title: 'Custom Pinned Event',
    fields: [
      { name: 'name', label: 'Event Name', type: 'text', placeholder: 'e.g., Assembly, Regroup' }
    ],
    confirmText: 'Add Event'
  });
  
  if (result && result.name) {
    const newEvent = {
      id: genId(),
      type: 'custom',
      name: result.name,
      startTime: minutesToTime(startMin),
      endTime: minutesToTime(endMin),
      divisions: divName ? [divName] : undefined
    };
    
    dailyOverrideSkeleton.push(newEvent);
    saveDailySkeleton();
    renderGrid();
    notify(`Added ${result.name}`);
  }
}

function startResize(handle, e, bounds) {
  const eventEl = handle.closest('.da-event');
  if (!eventEl) return;
  
  const id = eventEl.dataset.id;
  const tile = dailyOverrideSkeleton.find(t => t.id === id);
  if (!tile) return;
  
  const isTop = handle.classList.contains('da-resize-top');
  const startY = e.clientY;
  const originalStart = parseTimeToMinutes(tile.startTime);
  const originalEnd = parseTimeToMinutes(tile.endTime);
  
  eventEl.classList.add('resizing');
  
  const onMouseMove = (e) => {
    const deltaY = e.clientY - startY;
    const deltaMinutes = Math.round(deltaY / PIXELS_PER_MINUTE / SNAP_MINS) * SNAP_MINS;
    
    if (isTop) {
      const newStart = Math.max(bounds.lo, originalStart + deltaMinutes);
      if (newStart < originalEnd - 10) {
        tile.startTime = minutesToTime(newStart);
      }
    } else {
      const newEnd = Math.min(bounds.hi, originalEnd + deltaMinutes);
      if (newEnd > originalStart + 10) {
        tile.endTime = minutesToTime(newEnd);
      }
    }
    
    renderGrid();
    selectTile(id);
  };
  
  const onMouseUp = () => {
    eventEl.classList.remove('resizing');
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    saveDailySkeleton();
  };
  
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}

// =================================================================
// RAINY DAY PANEL
// =================================================================
function renderRainyDayPanel() {
  const panel = document.getElementById('da-rainy-panel');
  if (!panel) return;
  
  const isActive = isRainyDayActive();
  const isMidDay = isMidDayModeActive();
  const stats = getRainyDayStats();
  const autoSwitch = isAutoSkeletonSwitchEnabled();
  const rainySkeletonName = getRainyDaySkeletonName();
  const availableSkeletons = getAvailableSkeletons();
  
  // Generate rain drops
  let rainDrops = '';
  for (let i = 0; i < 18; i++) {
    const left = Math.random() * 100;
    const delay = Math.random() * 2;
    const duration = 0.7 + Math.random() * 0.4;
    const height = 12 + Math.random() * 18;
    rainDrops += `<div class="da-rain-drop" style="left:${left}%;animation-delay:${delay}s;animation-duration:${duration}s;height:${height}px;"></div>`;
  }
  
  const midDayInfo = isMidDay ? `
    <div style="padding:0 24px 12px;display:flex;gap:8px;">
      <span style="background:rgba(14,165,233,0.2);color:#7dd3fc;padding:4px 10px;border-radius:20px;font-size:12px;">
        ⏰ Started at ${minutesToTime(getMidDayStartTime())}
      </span>
      <span style="background:rgba(34,197,94,0.2);color:#4ade80;padding:4px 10px;border-radius:20px;font-size:12px;">
        📋 ${getPreservedSlotCount()} slots preserved
      </span>
    </div>
  ` : '';
  
  panel.innerHTML = `
    <div class="da-rainy-card ${isActive ? 'active' : 'inactive'}">
      <div class="da-rain-container">${rainDrops}</div>
      
      <div class="da-rainy-header">
        <div class="da-rainy-title-section">
          <div class="da-rainy-icon">${isActive ? '🌧️' : '☀️'}</div>
          <div>
            <h3 class="da-rainy-title">Rainy Day Mode</h3>
            <p class="da-rainy-subtitle">
              ${isActive 
                ? (isMidDay ? 'Mid-day mode — morning preserved' : 'Indoor schedule — outdoor fields disabled')
                : 'Normal schedule — all fields available'}
            </p>
          </div>
        </div>
        
        <div class="da-rainy-toggle-container">
          <span class="da-rainy-status ${isActive ? 'active' : 'inactive'}">
            <span class="status-dot"></span>
            ${isActive ? (isMidDay ? 'MID-DAY' : 'ACTIVE') : 'INACTIVE'}
          </span>
          
          <label class="da-rainy-toggle">
            <input type="checkbox" id="da-rainy-toggle" ${isActive ? 'checked' : ''}>
            <span class="da-rainy-toggle-track"></span>
            <span class="da-rainy-toggle-thumb">${isActive ? '💧' : '☀️'}</span>
          </label>
        </div>
      </div>
      
      ${midDayInfo}
      
      <div class="da-rainy-stats">
        <div class="da-rainy-stat">
          <span>🏠</span>
          <strong>${stats.indoorFields}</strong>
          <span>Indoor</span>
        </div>
        <div class="da-rainy-stat">
          <span>🌳</span>
          <strong>${stats.outdoorFields}</strong>
          <span>Outdoor ${isActive ? '(Disabled)' : ''}</span>
        </div>
        <div class="da-rainy-stat">
          <span>🎨</span>
          <strong>${stats.rainySpecials}</strong>
          <span>Rainy Activities</span>
        </div>
        ${!isActive ? `
          <div style="margin-left:auto;">
            <button id="da-midday-btn" class="da-btn da-btn-warning">⏰ Start Mid-Day Mode</button>
          </div>
        ` : ''}
      </div>
    </div>
  `;
  
  // Bind events
  const toggle = document.getElementById('da-rainy-toggle');
  if (toggle) {
    toggle.onchange = function() {
      if (this.checked) {
        activateFullDayRainyMode();
      } else {
        deactivateRainyDayMode();
      }
      renderRainyDayPanel();
      renderResourceOverridesUI();
      renderGrid();
    };
  }
  
  const midDayBtn = document.getElementById('da-midday-btn');
  if (midDayBtn) {
    midDayBtn.onclick = async () => {
      const ok = await showConfirm('Start Mid-Day Mode?\n\nThis will preserve the morning schedule and switch to rainy day mode from now onwards.');
      if (ok) {
        activateMidDayRainyMode();
        renderRainyDayPanel();
        renderResourceOverridesUI();
        renderGrid();
      }
    };
  }
}

// =================================================================
// RESOURCE OVERRIDES
// =================================================================
function loadCurrentOverrides() {
  const dailyData = window.loadCurrentDailyData?.() || {};
  const overrides = dailyData.overrides || {};
  
  currentOverrides = {
    dailyFieldAvailability: overrides.dailyFieldAvailability || {},
    leagues: overrides.leagues || [],
    disabledSpecialtyLeagues: overrides.disabledSpecialtyLeagues || [],
    dailyDisabledSportsByField: overrides.dailyDisabledSportsByField || {},
    disabledFields: overrides.disabledFields || [],
    disabledSpecials: overrides.disabledSpecials || [],
    bunkActivityOverrides: overrides.bunkActivityOverrides || []
  };
}

function saveCurrentOverrides() {
  window.saveCurrentDailyData?.("overrides", JSON.parse(JSON.stringify(currentOverrides)));
  window.forceSyncToCloud?.();
}

function renderResourceOverridesUI() {
  const container = document.getElementById('da-resources-container');
  if (!container) return;
  
  const g = masterSettings.global || {};
  const app1 = g.app1 || {};
  const fields = app1.fields || [];
  const specials = app1.specialActivities || [];
  const leagues = g.leagues || [];
  const specialtyLeagues = g.specialtyLeagues || [];
  
  const isRainy = isRainyDayActive();
  
  container.innerHTML = `
    <div class="da-section">
      <h3 class="da-section-title">Fields</h3>
      <p class="da-section-desc">Toggle fields on/off for today only.</p>
      <div id="da-fields-list"></div>
    </div>
    
    <div class="da-section">
      <h3 class="da-section-title">Special Activities</h3>
      <p class="da-section-desc">Toggle special activities on/off for today only.</p>
      <div id="da-specials-list"></div>
    </div>
    
    ${leagues.length > 0 ? `
    <div class="da-section">
      <h3 class="da-section-title">Leagues</h3>
      <p class="da-section-desc">Select which leagues are active today.</p>
      <div id="da-leagues-list"></div>
    </div>
    ` : ''}
    
    ${specialtyLeagues.length > 0 ? `
    <div class="da-section">
      <h3 class="da-section-title">Specialty Leagues</h3>
      <p class="da-section-desc">Toggle specialty leagues on/off for today.</p>
      <div id="da-specialty-leagues-list"></div>
    </div>
    ` : ''}
  `;
  
  // Render fields
  const fieldsContainer = document.getElementById('da-fields-list');
  fields.forEach(field => {
    const isDisabled = currentOverrides.disabledFields.includes(field.name);
    const isRainyDisabled = isRainy && !field.rainyDayAvailable;
    
    const row = document.createElement('div');
    row.className = `da-resource-row ${isDisabled || isRainyDisabled ? 'disabled' : ''}`;
    row.innerHTML = `
      <span class="da-resource-name">${escapeHtml(field.name)} ${isRainyDisabled ? '<span style="color:#f59e0b;font-size:11px;">(Rainy)</span>' : ''}</span>
      <label class="da-toggle" title="${isRainyDisabled ? 'Disabled by Rainy Day Mode' : ''}">
        <input type="checkbox" ${!isDisabled && !isRainyDisabled ? 'checked' : ''} ${isRainyDisabled ? 'disabled' : ''}>
        <span class="da-toggle-track"></span>
      </label>
    `;
    
    const input = row.querySelector('input');
    input.onchange = function() {
      if (this.checked) {
        currentOverrides.disabledFields = currentOverrides.disabledFields.filter(f => f !== field.name);
      } else {
        if (!currentOverrides.disabledFields.includes(field.name)) {
          currentOverrides.disabledFields.push(field.name);
        }
      }
      saveCurrentOverrides();
      row.classList.toggle('disabled', !this.checked);
    };
    
    fieldsContainer.appendChild(row);
  });
  
  // Render specials
  const specialsContainer = document.getElementById('da-specials-list');
  specials.forEach(special => {
    const isDisabled = currentOverrides.disabledSpecials.includes(special.name);
    
    const row = document.createElement('div');
    row.className = `da-resource-row ${isDisabled ? 'disabled' : ''}`;
    row.innerHTML = `
      <span class="da-resource-name">${escapeHtml(special.name)}</span>
      <label class="da-toggle">
        <input type="checkbox" ${!isDisabled ? 'checked' : ''}>
        <span class="da-toggle-track"></span>
      </label>
    `;
    
    const input = row.querySelector('input');
    input.onchange = function() {
      if (this.checked) {
        currentOverrides.disabledSpecials = currentOverrides.disabledSpecials.filter(s => s !== special.name);
      } else {
        if (!currentOverrides.disabledSpecials.includes(special.name)) {
          currentOverrides.disabledSpecials.push(special.name);
        }
      }
      saveCurrentOverrides();
      row.classList.toggle('disabled', !this.checked);
    };
    
    specialsContainer.appendChild(row);
  });
  
  // Render leagues if present
  if (leagues.length > 0) {
    const leaguesContainer = document.getElementById('da-leagues-list');
    leagues.forEach(league => {
      const isEnabled = currentOverrides.leagues.includes(league.name);
      
      const row = document.createElement('div');
      row.className = `da-resource-row ${!isEnabled ? 'disabled' : ''}`;
      row.innerHTML = `
        <span class="da-resource-name">${escapeHtml(league.name)}</span>
        <label class="da-toggle">
          <input type="checkbox" ${isEnabled ? 'checked' : ''}>
          <span class="da-toggle-track"></span>
        </label>
      `;
      
      const input = row.querySelector('input');
      input.onchange = function() {
        if (this.checked) {
          if (!currentOverrides.leagues.includes(league.name)) {
            currentOverrides.leagues.push(league.name);
          }
        } else {
          currentOverrides.leagues = currentOverrides.leagues.filter(l => l !== league.name);
        }
        saveCurrentOverrides();
        row.classList.toggle('disabled', !this.checked);
      };
      
      leaguesContainer.appendChild(row);
    });
  }
  
  // Render specialty leagues if present
  if (specialtyLeagues.length > 0) {
    const slContainer = document.getElementById('da-specialty-leagues-list');
    specialtyLeagues.forEach(sl => {
      const isDisabled = currentOverrides.disabledSpecialtyLeagues.includes(sl.name);
      
      const row = document.createElement('div');
      row.className = `da-resource-row ${isDisabled ? 'disabled' : ''}`;
      row.innerHTML = `
        <span class="da-resource-name">${escapeHtml(sl.name)}</span>
        <label class="da-toggle">
          <input type="checkbox" ${!isDisabled ? 'checked' : ''}>
          <span class="da-toggle-track"></span>
        </label>
      `;
      
      const input = row.querySelector('input');
      input.onchange = function() {
        if (this.checked) {
          currentOverrides.disabledSpecialtyLeagues = currentOverrides.disabledSpecialtyLeagues.filter(s => s !== sl.name);
        } else {
          if (!currentOverrides.disabledSpecialtyLeagues.includes(sl.name)) {
            currentOverrides.disabledSpecialtyLeagues.push(sl.name);
          }
        }
        saveCurrentOverrides();
        row.classList.toggle('disabled', !this.checked);
      };
      
      slContainer.appendChild(row);
    });
  }
}

// =================================================================
// BUNK OVERRIDES
// =================================================================
function renderBunkOverridesUI() {
  const container = document.getElementById('da-bunk-overrides-container');
  if (!container) return;
  
  const D = window.divisions || {};
  const allBunks = [];
  Object.entries(D).forEach(([divName, divData]) => {
    (divData.bunks || []).forEach(b => allBunks.push({ bunk: b, division: divName }));
  });
  
  const locations = getAllLocations();
  const times = window.unifiedTimes || [];
  
  const timeOptions = times.map((t, i) => {
    const label = t.label || `Slot ${i + 1}`;
    return `<option value="${i}">${label}</option>`;
  }).join('');
  
  const bunkOptions = allBunks.map(b => 
    `<option value="${b.bunk}">${b.bunk} (${b.division})</option>`
  ).join('');
  
  const locationOptions = locations.map(l => 
    `<option value="${l}">${l}</option>`
  ).join('');
  
  const overrides = currentOverrides.bunkActivityOverrides || [];
  
  container.innerHTML = `
    <div class="da-section">
      <h3 class="da-section-title">Bunk-Specific Overrides</h3>
      <p class="da-section-desc">Assign specific activities to bunks at specific times.</p>
      
      <div class="da-form-row">
        <div class="da-form-field">
          <label>Bunk</label>
          <select id="da-bunk-select" class="da-select">${bunkOptions}</select>
        </div>
        <div class="da-form-field">
          <label>Time Slot</label>
          <select id="da-slot-select" class="da-select">${timeOptions}</select>
        </div>
        <div class="da-form-field">
          <label>Activity</label>
          <select id="da-activity-select" class="da-select">${locationOptions}</select>
        </div>
        <button id="da-add-override-btn" class="da-btn da-btn-primary">Add Override</button>
      </div>
      
      <div id="da-override-list" class="da-override-list"></div>
    </div>
  `;
  
  // Render existing overrides
  const listEl = document.getElementById('da-override-list');
  overrides.forEach((o, idx) => {
    const slot = times[o.slotIndex];
    const slotLabel = slot?.label || `Slot ${o.slotIndex + 1}`;
    
    const item = document.createElement('div');
    item.className = 'da-override-item';
    item.innerHTML = `
      <div class="da-override-item-info">
        <strong>${escapeHtml(o.bunk)}</strong>
        <span> → ${escapeHtml(o.activity)} at ${slotLabel}</span>
      </div>
      <button class="da-btn da-btn-danger da-btn-sm" data-idx="${idx}">Remove</button>
    `;
    
    item.querySelector('button').onclick = () => {
      currentOverrides.bunkActivityOverrides.splice(idx, 1);
      saveCurrentOverrides();
      renderBunkOverridesUI();
    };
    
    listEl.appendChild(item);
  });
  
  // Add button handler
  document.getElementById('da-add-override-btn').onclick = () => {
    if (!window.AccessControl?.checkEditAccess?.('add bunk override')) return;
    
    const bunk = document.getElementById('da-bunk-select').value;
    const slot = parseInt(document.getElementById('da-slot-select').value);
    const activity = document.getElementById('da-activity-select').value;
    
    if (!bunk || isNaN(slot) || !activity) {
      showAlert('Please select a bunk, time slot, and activity.');
      return;
    }
    
    currentOverrides.bunkActivityOverrides.push({ bunk, slotIndex: slot, activity });
    saveCurrentOverrides();
    renderBunkOverridesUI();
    notify('Override added');
  };
}

// =================================================================
// TRIPS FORM
// =================================================================
function renderTripsForm() {
  const container = document.getElementById('da-trips-container');
  if (!container) return;
  
  const D = window.divisions || {};
  const allBunks = [];
  Object.entries(D).forEach(([divName, divData]) => {
    (divData.bunks || []).forEach(b => allBunks.push({ bunk: b, division: divName }));
  });
  
  const times = window.unifiedTimes || [];
  const dailyData = window.loadCurrentDailyData?.() || {};
  const trips = dailyData.trips || [];
  
  container.innerHTML = `
    <div class="da-section">
      <h3 class="da-section-title">Trips & Outings</h3>
      <p class="da-section-desc">Mark bunks as on a trip for specific time slots. They won't be scheduled during these times.</p>
      
      <div class="da-form-row">
        <div class="da-form-field">
          <label>Bunk(s)</label>
          <select id="da-trip-bunk" class="da-select" multiple style="height:80px;">
            ${allBunks.map(b => `<option value="${b.bunk}">${b.bunk}</option>`).join('')}
          </select>
        </div>
        <div class="da-form-field">
          <label>From Slot</label>
          <select id="da-trip-from" class="da-select">
            ${times.map((t, i) => `<option value="${i}">${t.label || `Slot ${i+1}`}</option>`).join('')}
          </select>
        </div>
        <div class="da-form-field">
          <label>To Slot</label>
          <select id="da-trip-to" class="da-select">
            ${times.map((t, i) => `<option value="${i}">${t.label || `Slot ${i+1}`}</option>`).join('')}
          </select>
        </div>
        <div class="da-form-field">
          <label>Trip Name</label>
          <input type="text" id="da-trip-name" class="da-input" placeholder="e.g., Zoo Trip">
        </div>
        <button id="da-add-trip-btn" class="da-btn da-btn-primary">Add Trip</button>
      </div>
      
      <div id="da-trip-list" class="da-override-list"></div>
    </div>
  `;
  
  // Render existing trips
  const listEl = document.getElementById('da-trip-list');
  trips.forEach((trip, idx) => {
    const fromSlot = times[trip.fromSlot];
    const toSlot = times[trip.toSlot];
    
    const item = document.createElement('div');
    item.className = 'da-override-item';
    item.innerHTML = `
      <div class="da-override-item-info">
        <strong>${escapeHtml(trip.name || 'Trip')}</strong>
        <span> - ${trip.bunks.join(', ')} (${fromSlot?.label || trip.fromSlot} to ${toSlot?.label || trip.toSlot})</span>
      </div>
      <button class="da-btn da-btn-danger da-btn-sm" data-idx="${idx}">Remove</button>
    `;
    
    item.querySelector('button').onclick = () => {
      trips.splice(idx, 1);
      window.saveCurrentDailyData?.("trips", trips);
      window.forceSyncToCloud?.();
      renderTripsForm();
    };
    
    listEl.appendChild(item);
  });
  
  // Add trip handler
  document.getElementById('da-add-trip-btn').onclick = () => {
    if (!window.AccessControl?.checkEditAccess?.('add trip')) return;
    
    const bunkSelect = document.getElementById('da-trip-bunk');
    const selectedBunks = Array.from(bunkSelect.selectedOptions).map(o => o.value);
    const fromSlot = parseInt(document.getElementById('da-trip-from').value);
    const toSlot = parseInt(document.getElementById('da-trip-to').value);
    const name = document.getElementById('da-trip-name').value;
    
    if (selectedBunks.length === 0) {
      showAlert('Please select at least one bunk.');
      return;
    }
    
    trips.push({
      bunks: selectedBunks,
      fromSlot,
      toSlot,
      name: name || 'Trip'
    });
    
    window.saveCurrentDailyData?.("trips", trips);
    window.forceSyncToCloud?.();
    renderTripsForm();
    notify('Trip added');
  };
}

// =================================================================
// RUN OPTIMIZER
// =================================================================
function runOptimizer() {
  if (!window.AccessControl?.checkEditAccess?.('run optimizer')) return;
  
  if (!window.runSkeletonOptimizer) {
    showAlert("Error: 'runSkeletonOptimizer' not found.");
    return;
  }
  
  if (dailyOverrideSkeleton.length === 0) {
    showAlert("Skeleton is empty. Add blocks to the schedule first.");
    return;
  }
  
  saveDailySkeleton();
  
  const success = window.runSkeletonOptimizer(dailyOverrideSkeleton, currentOverrides);
  
  if (success) {
    notify('Schedule Generated!');
    window.showTab?.('schedule');
  } else {
    showAlert("Error generating schedule. Check console for details.");
  }
}

// =================================================================
// PUBLIC API
// =================================================================
window.initDailyAdjustments = init;
window.cleanupDailyAdjustments = cleanup;
window.refreshDailyAdjustmentsFromCloud = refreshFromCloud;
window.dailyOverrideSkeleton = dailyOverrideSkeleton;

})();
