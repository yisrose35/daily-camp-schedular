// =================================================================
// daily_adjustments.js  (v6.1 - Bug Fixes with Original Structure Restored)
// =================================================================
// v6.0 FIXES APPLIED:
// - #2:  confirm() → async showConfirm() for tile deletion
// - #3:  prompt()/alert() → async showPrompt()/showAlert() everywhere
// - #4:  Added showConfirm/showAlert/showPrompt modal definitions
// - #7:  saveDailySkeleton clones before cloud write
// - #8:  Drag reposition clamps to division end boundary
// - #9:  Drop handler clamps startMin to division start
// - #10: Resize enforces 15-min minimum duration
// - #12: mapEventNameForOptimizer handles League/Specialty League
// - #13: Elective location list includes locationZones
// - #16: Mobile touch uses float comparison not strict '0.6'
// - #18: Conflict highlighting shows indicator when unavailable
// - #20: Clear button also clears displaced tiles
// - #24: Guard hours configurable via getGuardHours()
// - #25: Date.now().toString() → uid() for all tile IDs
// - #28: TILES exported to window.CAMPISTRY_TILES
// - #31: window.unifiedTimes → getUnifiedTimeSlots()
// - #32: XSS prevention via escapeHtml() in tile rendering
// - #34: Bunk override 'field' type → 'pinned' not 'special'
// - #37: Removed stale loadDailySkeleton() before trip add
// - #38: Division names escaped in HTML attributes
// - #41: eraseOverlappingTiles accepts custom reason
// - #42: minutesToTime clamps to 0-1440 range
// - #45: refreshFromCloud invalidates localStorage cache
// - #46: refreshFromCloud updates window.divisions
// - #47: parseTimeToMinutes returns null for NaN (implicit)
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
let _keyHandler = null;
let _visHandler = null;
let _rainyToggleDebounce = false;

// Constants
const SMART_TILE_HISTORY_KEY = "smartTileHistory_v1";
const PIXELS_PER_MINUTE = 2;
const INCREMENT_MINS = 30;
const SNAP_MINS = 5;

// =================================================================
// TILES - From v3.9 (working tile definitions)
// =================================================================
const TILES = [
  { type: 'activity', name: 'Activity', style: 'background:#93c5fd;color:#1e3a5f;', description: 'Flexible slot (Sport or Special).' },
  { type: 'sports', name: 'Sports', style: 'background:#86efac;color:#14532d;', description: 'Sports slot only.' },
  { type: 'special', name: 'Special Activity', style: 'background:#c4b5fd;color:#3b1f6b;', description: 'Special Activity slot only.' },
  { type: 'smart', name: 'Smart Tile', style: 'background:#7dd3fc;color:#0c4a6e;border:2px dashed #0284c7;', description: 'Balances 2 activities with a fallback.' },
  { type: 'split', name: 'Split Activity', style: 'background:#fdba74;color:#7c2d12;', description: 'Two activities share the block (Switch halfway).' },
  { type: 'elective', name: 'Elective', style: 'background:#f0abfc;color:#701a75;', description: 'Reserve multiple activities for this division only.' },
  { type: 'league', name: 'League Game', style: 'background:#a5b4fc;color:#312e81;', description: 'Regular League slot (Full Buyout).' },
  { type: 'specialty_league', name: 'Specialty League', style: 'background:#d8b4fe;color:#581c87;', description: 'Specialty League slot (Full Buyout).' },
  { type: 'swim', name: 'Swim', style: 'background:#67e8f9;color:#155e75;', description: 'Pinned swim time.' },
  { type: 'lunch', name: 'Lunch', style: 'background:#fca5a5;color:#7f1d1d;', description: 'Pinned lunch.' },
  { type: 'snacks', name: 'Snacks', style: 'background:#fde047;color:#713f12;', description: 'Pinned snacks.' },
  { type: 'dismissal', name: 'Dismissal', style: 'background:#f87171;color:white;', description: 'Pinned dismissal.' },
  { type: 'custom', name: 'Custom Pinned', style: 'background:#d1d5db;color:#374151;', description: 'Pinned custom (e.g., Regroup).' }
];

// =================================================================
// UTILITY FUNCTIONS
// =================================================================
function uid() {
  return 'id_' + Math.random().toString(36).slice(2, 9);
}

// Fix #32, #38 — XSS prevention
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Fix #47 — returns null for NaN/invalid input
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
  } else {
    // No meridian — return null to prevent ambiguity (#1)
    return null;
  }
  return hh * 60 + mm;
}

// Fix #42 — clamp to valid range, handle NaN
function minutesToTime(min) {
  if (typeof min !== 'number' || isNaN(min)) return '12:00am';
  min = Math.max(0, Math.min(1440, Math.round(min)));
  let h = Math.floor(min / 60), m = min % 60, ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return h + ':' + m.toString().padStart(2, '0') + ap;
}

// =================================================================
// ASYNC MODAL SYSTEM (Fixes #2, #3, #4)
// =================================================================
async function showAlert(message, title) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'da-modal-overlay';
    overlay.innerHTML = `
      <div class="da-modal" style="max-width:400px;">
        <div class="da-modal-header">
          <h3>${escapeHtml(title || 'Notice')}</h3>
          <button class="da-modal-close">×</button>
        </div>
        <div class="da-modal-body">
          <p style="margin:0;color:#475569;white-space:pre-wrap;">${escapeHtml(message)}</p>
        </div>
        <div class="da-modal-footer">
          <button class="da-btn da-btn-primary da-modal-ok">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); resolve(); };
    overlay.querySelector('.da-modal-close').onclick = close;
    overlay.querySelector('.da-modal-ok').onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    overlay.querySelector('.da-modal-ok').focus();
  });
}

async function showConfirm(message, title) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'da-modal-overlay';
    overlay.innerHTML = `
      <div class="da-modal" style="max-width:420px;">
        <div class="da-modal-header">
          <h3>${escapeHtml(title || 'Confirm')}</h3>
          <button class="da-modal-close">×</button>
        </div>
        <div class="da-modal-body">
          <p style="margin:0;color:#475569;white-space:pre-wrap;">${escapeHtml(message)}</p>
        </div>
        <div class="da-modal-footer">
          <button class="da-btn da-btn-ghost da-modal-cancel">Cancel</button>
          <button class="da-btn da-btn-primary da-modal-ok">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('.da-modal-close').onclick = () => close(false);
    overlay.querySelector('.da-modal-cancel').onclick = () => close(false);
    overlay.querySelector('.da-modal-ok').onclick = () => close(true);
    overlay.onclick = (e) => { if (e.target === overlay) close(false); };
    overlay.querySelector('.da-modal-ok').focus();
  });
}

async function showPrompt(message, defaultValue, title) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'da-modal-overlay';
    overlay.innerHTML = `
      <div class="da-modal" style="max-width:440px;">
        <div class="da-modal-header">
          <h3>${escapeHtml(title || 'Input')}</h3>
          <button class="da-modal-close">×</button>
        </div>
        <div class="da-modal-body">
          <p style="margin:0 0 12px;color:#475569;white-space:pre-wrap;">${escapeHtml(message)}</p>
          <input type="text" class="da-input" value="${escapeHtml(defaultValue || '')}" autofocus>
        </div>
        <div class="da-modal-footer">
          <button class="da-btn da-btn-ghost da-modal-cancel">Cancel</button>
          <button class="da-btn da-btn-primary da-modal-ok">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('input');
    input.focus();
    input.select();
    const close = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('.da-modal-close').onclick = () => close(null);
    overlay.querySelector('.da-modal-cancel').onclick = () => close(null);
    overlay.querySelector('.da-modal-ok').onclick = () => close(input.value);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') close(input.value);
      if (e.key === 'Escape') close(null);
    };
    overlay.onclick = (e) => { if (e.target === overlay) close(null); };
  });
}

// Fix #24 — configurable guard hours
function getGuardHours() {
  const g = window.loadGlobalSettings?.() || {};
  return {
    start: g.guardHoursStart ?? 480,   // default 8:00 AM
    end: g.guardHoursEnd ?? 1200       // default 8:00 PM
  };
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
// UNIFIED TIME SLOTS HELPER (Fix #31)
// =================================================================
function getUnifiedTimeSlots() {
  // Priority 1: DivisionTimesSystem (current architecture)
  if (window.DivisionTimesSystem?.getUnifiedSlots) {
    return window.DivisionTimesSystem.getUnifiedSlots();
  }
  // Priority 2: divisionTimes as flat array
  if (Array.isArray(window.divisionTimes)) {
    return window.divisionTimes;
  }
  // Priority 3: divisionTimes as object keyed by division
  if (window.divisionTimes && typeof window.divisionTimes === 'object') {
    const allSlots = [];
    Object.values(window.divisionTimes).forEach(divSlots => {
      if (Array.isArray(divSlots)) allSlots.push(...divSlots);
    });
    if (allSlots.length > 0) return allSlots;
  }
  // Priority 4: Legacy unifiedTimes (deprecated)
  return window.unifiedTimes || [];
}

// =================================================================
// RAINY DAY MODE - UI Components (Enhanced with Mid-Day & Auto-Skeleton)
// =================================================================
function isRainyDayActive() {
  if (window.isRainyDay === true) return true;
  if (window.isRainyDay === false) return false;
  const dailyData = window.loadCurrentDailyData?.() || {};
  return dailyData.rainyDayMode === true || dailyData.isRainyDay === true;
}

function isMidDayModeActive() {
  if (window.rainyDayStartTime !== null && window.rainyDayStartTime !== undefined) return true;
  const dailyData = window.loadCurrentDailyData?.() || {};
  return dailyData.rainyDayStartTime !== null && dailyData.rainyDayStartTime !== undefined;
}

function getMidDayStartTime() {
  if (window.rainyDayStartTime !== null && window.rainyDayStartTime !== undefined) {
    return window.rainyDayStartTime;
  }
  const dailyData = window.loadCurrentDailyData?.() || {};
  return dailyData.rainyDayStartTime || null;
}

// Fix #31 — uses getUnifiedTimeSlots() instead of window.unifiedTimes
function getPreservedSlotCount() {
  const startTime = getMidDayStartTime();
  if (startTime === null) return 0;
  const times = getUnifiedTimeSlots();
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
  
  const indoorFields = fields.filter(f => f.rainyDayAvailable === true);
  const outdoorFields = fields.filter(f => f.rainyDayAvailable !== true);
  const rainyOnlySpecials = specials.filter(s => s.rainyDayOnly === true);
  const indoorSpecials = specials.filter(s => s.isOutdoor !== true);
  
  const indoorSportsSet = new Set();
  indoorFields.forEach(f => {
    (f.activities || []).forEach(act => indoorSportsSet.add(act));
  });
  
  const outdoorSportsSet = new Set();
  outdoorFields.forEach(f => {
    (f.activities || []).forEach(act => outdoorSportsSet.add(act));
  });
     
  return {
    indoorFields: indoorFields.length,
    outdoorFields: outdoorFields.length,
    indoorFieldNames: indoorFields.map(f => f.name),
    outdoorFieldNames: outdoorFields.map(f => f.name),
    rainySpecials: rainyOnlySpecials.length,
    indoorSpecials: indoorSpecials.length,
    indoorSportsCount: indoorSportsSet.size,
    outdoorSportsCount: outdoorSportsSet.size,
    totalIndoorActivities: indoorSportsSet.size + indoorSpecials.length,
    totalOutdoorActivities: outdoorSportsSet.size + specials.filter(s => s.isOutdoor === true).length
  };
}

function renderRainyDayPanel() {
  const panel = document.getElementById('da-rainy-panel');
  if (!panel) return;
  
  const isActive = isRainyDayActive();
  const isMidDay = isMidDayModeActive();
  const midDayStartTime = getMidDayStartTime();
  const preservedSlots = getPreservedSlotCount();
  const stats = getRainyDayStats();
  const autoSwitch = isAutoSkeletonSwitchEnabled();
  const rainySkeletonName = getRainyDaySkeletonName();
  const availableSkeletons = getAvailableSkeletons();
  
  const isExpanded = isActive || panel.dataset.expanded === 'true';
     
  let rainDrops = '';
  for (let i = 0; i < 25; i++) {
    const left = Math.random() * 100;
    const delay = Math.random() * 2;
    const duration = 0.5 + Math.random() * 0.5;
    const height = 15 + Math.random() * 20;
    rainDrops += `<div class="da-rain-drop" style="left:${left}%;animation-delay:${delay}s;animation-duration:${duration}s;height:${height}px;"></div>`;
  }
     
  const skeletonOptions = availableSkeletons.map(name => 
    `<option value="${escapeHtml(name)}" ${name === rainySkeletonName ? 'selected' : ''}>${escapeHtml(name)}</option>`
  ).join('');
  
  const dailyData = window.loadCurrentDailyData?.() || {};
  const midDayAnalysis = dailyData.midDayRainAnalysis || null;
     
  let midDayInfo = '';
  if (isMidDay) {
    midDayInfo = `
      <div class="da-rainy-midday-info">
        <span class="da-rainy-midday-badge">⏰ Rain started at ${minutesToTime(midDayStartTime)}</span>
        <span class="da-rainy-preserved-badge">✅ ${preservedSlots} kept</span>
        ${midDayAnalysis ? `
          <span class="da-rainy-cutshort-badge">⚠️ ${midDayAnalysis.inProgressCount || 0} cut short</span>
          <span class="da-rainy-cleared-badge">🗑️ ${midDayAnalysis.futureCount || 0} cleared</span>
        ` : ''}
      </div>
    `;
  }
     
  panel.innerHTML = `
    <div class="da-rainy-dropdown ${isExpanded ? 'expanded' : ''} ${isActive ? 'active' : ''}">
      <div class="da-rainy-dropdown-header" id="da-rainy-dropdown-toggle">
        <div class="da-rainy-dropdown-title">
          <span class="da-rainy-dropdown-icon">${isActive ? '🌧️' : '☀️'}</span>
          <span>${isActive ? 'Rainy Day Mode' : 'Regular Day'}</span>
          ${isActive ? `<span class="da-rainy-active-badge">${isMidDay ? 'MID-DAY' : 'ACTIVE'}</span>` : ''}
        </div>
        <span class="da-rainy-dropdown-arrow">${isExpanded ? '▼' : '▶'}</span>
      </div>
      
      <div class="da-rainy-dropdown-content" style="display:${isExpanded ? 'block' : 'none'};">
        <div class="da-rainy-card ${isActive ? 'active' : 'inactive'}">
          <div class="da-rain-container">${rainDrops}</div>
            
          <div class="da-rainy-header">
            <div class="da-rainy-title-section">
              <div class="da-rainy-icon">${isActive ? '🌧️' : '☀️'}</div>
              <div>
                <h3 class="da-rainy-title">${isActive ? 'Rainy Day Mode' : 'Regular Day'}</h3>
                <p class="da-rainy-subtitle">
                  ${isActive 
                    ? (isMidDay ? 'Mid-day mode — morning schedule preserved' : 'Indoor activities only — outdoor fields disabled')
                    : 'Normal schedule — all fields and activities available'}
                </p>
              </div>
            </div>
            
            <div class="da-rainy-toggle-container">
              <label class="da-rainy-toggle" onclick="event.stopPropagation();">
                <input type="checkbox" id="da-rainy-toggle-input" ${isActive ? 'checked' : ''}>
                <span class="da-rainy-toggle-track">
                  <span class="da-rainy-toggle-label-off">OFF</span>
                  <span class="da-rainy-toggle-label-on">ON</span>
                </span>
                <span class="da-rainy-toggle-thumb"></span>
              </label>
            </div>
          </div>
            
          ${midDayInfo}
            
          <div class="da-rainy-stats">
            ${isActive ? `
              <div class="da-rainy-stat available">
                <span>🏠</span>
                <strong>${stats.indoorFields}</strong>
                <span>Indoor Fields</span>
              </div>
              <div class="da-rainy-stat available">
                <span>🎨</span>
                <strong>${stats.indoorSpecials}</strong>
                <span>Indoor Specials</span>
              </div>
              <div class="da-rainy-stat highlight">
                <span>🌧️</span>
                <strong>${stats.rainySpecials}</strong>
                <span>Rainy-Only Activities</span>
              </div>
              <div class="da-rainy-stat disabled">
                <span>🚫</span>
                <strong>${stats.outdoorFields}</strong>
                <span>Outdoor (Disabled)</span>
              </div>
            ` : `
              <div class="da-rainy-stat">
                <span>🏠</span>
                <strong>${stats.indoorFields}</strong>
                <span>Indoor Fields</span>
              </div>
              <div class="da-rainy-stat">
                <span>🌳</span>
                <strong>${stats.outdoorFields}</strong>
                <span>Outdoor Fields</span>
              </div>
              <div class="da-rainy-stat">
                <span>🎨</span>
                <strong>${stats.indoorSpecials + stats.rainySpecials}</strong>
                <span>Special Activities</span>
              </div>
              <div class="da-rainy-stat" style="margin-left:auto;">
                <button id="da-rainy-midday-btn" class="da-btn da-btn-warning da-btn-sm">⏰ Mid-Day Mode</button>
              </div>
            `}
          </div>
          
          <div class="da-rainy-settings-toggle">
            <button id="da-rainy-settings-btn" class="da-rainy-settings-btn">⚙️ Settings</button>
          </div>
            
          <div id="da-rainy-settings-panel" class="da-rainy-settings-panel" style="display:none;">
            <div class="da-rainy-settings-row">
              <div>
                <span class="da-rainy-settings-label">Auto-Switch Skeleton</span>
                <div class="da-rainy-settings-sublabel">Automatically load rainy day template when activating</div>
              </div>
              <label class="da-mini-toggle">
                <input type="checkbox" id="da-rainy-auto-skeleton-toggle" ${autoSwitch ? 'checked' : ''}>
                <span class="da-mini-track"></span>
                <span class="da-mini-thumb"></span>
              </label>
            </div>
            
            <div class="da-rainy-settings-row">
              <div>
                <span class="da-rainy-settings-label">Rainy Day Skeleton</span>
                <div class="da-rainy-settings-sublabel">Template to use when rainy mode activates</div>
              </div>
              <select id="da-rainy-skeleton-select" class="da-select" ${!autoSwitch ? 'disabled' : ''}>
                <option value="">-- Select Template --</option>
                ${skeletonOptions}
              </select>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  
  bindRainyDayEvents();
}

function bindRainyDayEvents() {
  const dropdownToggle = document.getElementById('da-rainy-dropdown-toggle');
  const panel = document.getElementById('da-rainy-panel');
  
  if (dropdownToggle) {
    dropdownToggle.onclick = function(e) {
      if (e.target.closest('.da-rainy-toggle') || e.target.closest('.da-rainy-settings-btn')) return;
      
      const dropdown = dropdownToggle.closest('.da-rainy-dropdown');
      const content = dropdown.querySelector('.da-rainy-dropdown-content');
      const arrow = dropdown.querySelector('.da-rainy-dropdown-arrow');
      const isExpanded = content.style.display !== 'none';
      
      content.style.display = isExpanded ? 'none' : 'block';
      arrow.textContent = isExpanded ? '▶' : '▼';
      dropdown.classList.toggle('expanded', !isExpanded);
      
      if (panel) panel.dataset.expanded = (!isExpanded).toString();
    };
  }
  
  const toggle = document.getElementById('da-rainy-toggle-input');
  const autoSkeletonToggle = document.getElementById('da-rainy-auto-skeleton-toggle');
  const skeletonSelect = document.getElementById('da-rainy-skeleton-select');
  const midDayBtn = document.getElementById('da-rainy-midday-btn');
  const settingsBtn = document.getElementById('da-rainy-settings-btn');
  const settingsPanel = document.getElementById('da-rainy-settings-panel');
     
  if (settingsBtn && settingsPanel) {
    settingsBtn.onclick = function(e) {
      e.stopPropagation();
      const isOpen = settingsPanel.style.display !== 'none';
      settingsPanel.style.display = isOpen ? 'none' : 'block';
      settingsBtn.textContent = isOpen ? '⚙️ Settings' : '⚙️ Close';
    };
  }
     
  if (toggle) {
    toggle.onchange = function(e) {
      e.stopPropagation();
      
      if (_rainyToggleDebounce) {
        console.log("[RainyDay] Toggle debounced - ignoring duplicate");
        return;
      }
      _rainyToggleDebounce = true;
      setTimeout(() => { _rainyToggleDebounce = false; }, 500);
      
      console.log("[RainyDay] Toggle changed, checked =", this.checked);
      
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
     
  if (autoSkeletonToggle) {
    autoSkeletonToggle.onchange = function(e) {
      e.stopPropagation();
      setAutoSkeletonSwitch(this.checked);
      const skeletonDropdown = document.getElementById('da-rainy-skeleton-select');
      if (skeletonDropdown) {
        skeletonDropdown.disabled = !this.checked;
      }
    };
  }
     
  if (skeletonSelect) {
    skeletonSelect.onchange = function(e) {
      e.stopPropagation();
      setRainyDaySkeletonName(this.value || null);
    };
  }
     
  if (midDayBtn) {
    midDayBtn.onclick = function(e) {
      e.stopPropagation();
      showMidDayRainModal();
    };
  }
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
  
  window.isRainyDay = true;
  window.rainyDayStartTime = null;
  
  window.saveCurrentDailyData?.("rainyDayMode", true);
  window.saveCurrentDailyData?.("rainyDayStartTime", null);
  window.saveCurrentDailyData?.("isRainyDay", true);
  
  let skeletonSwitched = false;
  if (isAutoSkeletonSwitchEnabled()) {
    skeletonSwitched = switchToRainySkeleton();
  }
  
  showRainyDayNotification(true, stats.outdoorFieldNames.length, false, skeletonSwitched);
}

function activateMidDayRainyMode(customStartTime = null) {
  if (!window.AccessControl?.checkEditAccess?.('activate mid-day rainy mode')) return;
  
  const dailyData = window.loadCurrentDailyData?.() || {};
  const overrides = dailyData.overrides || {};
  const stats = getRainyDayStats();
  
  let rainStartMin;
  if (customStartTime !== null) {
    rainStartMin = customStartTime;
  } else {
    const now = new Date();
    rainStartMin = now.getHours() * 60 + now.getMinutes();
  }
  
  console.log(`[RainyDay] Mid-day mode starting at ${minutesToTime(rainStartMin)}`);
  
  if (!dailyData.preRainyDayDisabledFields) {
    window.saveCurrentDailyData?.("preRainyDayDisabledFields", overrides.disabledFields || []);
  }
  
  const activityAnalysis = analyzeActivitiesForMidDayRain(rainStartMin);
  console.log("[RainyDay] Activity analysis:", activityAnalysis);
  
  backupPreservedSchedule(rainStartMin);
  clearActivitiesFromRainStart(rainStartMin, activityAnalysis);
  
  const existingDisabled = overrides.disabledFields || [];
  const newDisabled = [...new Set([...existingDisabled, ...stats.outdoorFieldNames])];
  
  overrides.disabledFields = newDisabled;
  currentOverrides.disabledFields = newDisabled;
  window.saveCurrentDailyData?.("overrides", overrides);
  
  window.isRainyDay = true;
  window.rainyDayStartTime = rainStartMin;
  
  window.saveCurrentDailyData?.("rainyDayMode", true);
  window.saveCurrentDailyData?.("rainyDayStartTime", rainStartMin);
  window.saveCurrentDailyData?.("isRainyDay", true);
  window.saveCurrentDailyData?.("midDayRainAnalysis", activityAnalysis);
  
  let skeletonSwitched = false;
  if (isAutoSkeletonSwitchEnabled()) {
    skeletonSwitched = switchToRainySkeleton();
  }
  
  showRainyDayNotification(true, stats.outdoorFieldNames.length, true, skeletonSwitched, activityAnalysis.completedCount);
  console.log("[RainyDay] Activated mid-day mode at", minutesToTime(rainStartMin));
  console.log("[RainyDay] Kept:", activityAnalysis.completedCount, "| Cut short:", activityAnalysis.inProgressCount, "| Cleared:", activityAnalysis.futureCount);
}

// Fix #31 — uses getUnifiedTimeSlots()
function analyzeActivitiesForMidDayRain(rainStartMin) {
  const times = getUnifiedTimeSlots();
  const schedules = window.scheduleAssignments || {};
  
  const analysis = {
    completed: [],
    inProgress: [],
    future: [],
    completedCount: 0,
    inProgressCount: 0,
    futureCount: 0,
    rainStartTime: rainStartMin,
    rainStartFormatted: minutesToTime(rainStartMin)
  };
  
  for (let i = 0; i < times.length; i++) {
    const slot = times[i];
    if (!slot || !slot.start || !slot.end) continue;
    
    const slotStart = new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes();
    const slotEnd = new Date(slot.end).getHours() * 60 + new Date(slot.end).getMinutes();
    
    const slotInfo = {
      index: i,
      startTime: minutesToTime(slotStart),
      endTime: minutesToTime(slotEnd),
      startMin: slotStart,
      endMin: slotEnd
    };
    
    if (slotEnd <= rainStartMin) {
      analysis.completed.push(slotInfo);
      analysis.completedCount++;
    } else if (slotStart < rainStartMin && slotEnd > rainStartMin) {
      slotInfo.cutAt = minutesToTime(rainStartMin);
      analysis.inProgress.push(slotInfo);
      analysis.inProgressCount++;
    } else if (slotStart >= rainStartMin) {
      analysis.future.push(slotInfo);
      analysis.futureCount++;
    }
  }
  
  return analysis;
}

function clearActivitiesFromRainStart(rainStartMin, analysis) {
  const schedules = window.scheduleAssignments || {};
  
  const slotsToClear = new Set();
  analysis.inProgress.forEach(slot => slotsToClear.add(slot.index));
  analysis.future.forEach(slot => slotsToClear.add(slot.index));
  
  if (slotsToClear.size === 0) {
    console.log("[RainyDay] No slots to clear");
    return;
  }
  
  let clearedCount = 0;
  Object.keys(schedules).forEach(bunk => {
    slotsToClear.forEach(slotIdx => {
      if (schedules[bunk] && schedules[bunk][slotIdx]) {
        schedules[bunk][slotIdx] = null;
        clearedCount++;
      }
    });
  });
  
  window.scheduleAssignments = schedules;
  window.saveCurrentDailyData?.("scheduleAssignments", schedules);
  
  console.log(`[RainyDay] Cleared ${clearedCount} assignments from ${slotsToClear.size} slots`);
}

function showMidDayRainModal() {
  const existingModal = document.getElementById('da-midday-rain-modal');
  if (existingModal) existingModal.remove();
  
  const now = new Date();
  const currentHour = now.getHours();
  const currentMin = Math.floor(now.getMinutes() / 5) * 5;
  const currentTimeStr = `${String(currentHour).padStart(2, '0')}:${String(currentMin).padStart(2, '0')}`;
  
  const modal = document.createElement('div');
  modal.id = 'da-midday-rain-modal';
  modal.className = 'da-modal-overlay';
  modal.innerHTML = `
    <div class="da-modal" style="max-width:450px;">
      <div class="da-modal-header">
        <h3>🌧️ Mid-Day Rain Change</h3>
        <button class="da-modal-close" onclick="this.closest('.da-modal-overlay').remove()">×</button>
      </div>
      <div class="da-modal-body">
        <p style="margin-bottom:16px;color:#64748b;">
          This will preserve activities that <strong>completed before</strong> the rain start time, 
          discard any activities that were <strong>in progress</strong> (cut short by rain), 
          and clear all <strong>future</strong> activities for you to reschedule with indoor options.
        </p>
        
        <div class="da-form-field" style="margin-bottom:16px;">
          <label style="font-weight:600;margin-bottom:6px;display:block;">When did rain start?</label>
          <div style="display:flex;gap:12px;align-items:center;">
            <input type="time" id="da-midday-rain-time" class="da-input" value="${currentTimeStr}" style="flex:1;font-size:16px;padding:10px;">
            <button id="da-midday-use-now-btn" class="da-btn da-btn-secondary" style="white-space:nowrap;">Use Current Time</button>
          </div>
        </div>
        
        <div id="da-midday-preview" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin-bottom:16px;">
          <div style="font-weight:600;margin-bottom:8px;">Preview:</div>
          <div id="da-midday-preview-content">Calculating...</div>
        </div>
        
        <div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:12px;margin-bottom:16px;">
          <div style="font-weight:600;color:#92400e;margin-bottom:4px;">⚠️ Warning</div>
          <div style="font-size:13px;color:#a16207;">
            Activities that were <strong>in progress</strong> when rain started will be marked as incomplete and won't count toward rotation.
          </div>
        </div>
      </div>
      <div class="da-modal-footer">
        <button class="da-btn da-btn-secondary" onclick="this.closest('.da-modal-overlay').remove()">Cancel</button>
        <button id="da-midday-confirm-btn" class="da-btn da-btn-primary">🌧️ Activate Mid-Day Rain</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  const updatePreview = () => {
    const timeInput = document.getElementById('da-midday-rain-time');
    const previewContent = document.getElementById('da-midday-preview-content');
    
    if (!timeInput || !previewContent) return;
    
    const [hours, mins] = timeInput.value.split(':').map(Number);
    const rainStartMin = hours * 60 + mins;
    
    const analysis = analyzeActivitiesForMidDayRain(rainStartMin);
    
    previewContent.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;text-align:center;">
        <div style="background:#d1fae5;padding:8px;border-radius:6px;">
          <div style="font-size:20px;font-weight:700;color:#065f46;">${analysis.completedCount}</div>
          <div style="font-size:11px;color:#047857;">✅ Keep</div>
        </div>
        <div style="background:#fef3c7;padding:8px;border-radius:6px;">
          <div style="font-size:20px;font-weight:700;color:#92400e;">${analysis.inProgressCount}</div>
          <div style="font-size:11px;color:#a16207;">⚠️ Cut Short</div>
        </div>
        <div style="background:#fee2e2;padding:8px;border-radius:6px;">
          <div style="font-size:20px;font-weight:700;color:#991b1b;">${analysis.futureCount}</div>
          <div style="font-size:11px;color:#dc2626;">🗑️ Clear</div>
        </div>
      </div>
      ${analysis.inProgressCount > 0 ? `
        <div style="margin-top:10px;font-size:12px;color:#64748b;">
          <strong>Cut short slots:</strong> ${analysis.inProgress.map(s => s.startTime + '-' + s.endTime).join(', ')}
        </div>
      ` : ''}
    `;
  };
  
  document.getElementById('da-midday-rain-time').addEventListener('change', updatePreview);
  document.getElementById('da-midday-rain-time').addEventListener('input', updatePreview);
  
  document.getElementById('da-midday-use-now-btn').onclick = () => {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(Math.floor(now.getMinutes() / 5) * 5).padStart(2, '0');
    document.getElementById('da-midday-rain-time').value = `${h}:${m}`;
    updatePreview();
  };
  
  document.getElementById('da-midday-confirm-btn').onclick = () => {
    const timeInput = document.getElementById('da-midday-rain-time');
    const [hours, mins] = timeInput.value.split(':').map(Number);
    const rainStartMin = hours * 60 + mins;
    
    modal.remove();
    
    activateMidDayRainyMode(rainStartMin);
    renderRainyDayPanel();
    renderResourceOverridesUI();
    renderGrid();
  };
  
  modal.onclick = (e) => {
    if (e.target === modal) modal.remove();
  };
  
  updatePreview();
}

// Fix #31 — uses getUnifiedTimeSlots()
function backupPreservedSchedule(startTimeMin) {
  const times = getUnifiedTimeSlots();
  const schedules = window.scheduleAssignments || {};
  const preserved = [];
  
  for (let i = 0; i < times.length; i++) {
    const slot = times[i];
    if (slot && slot.start) {
      const slotStart = new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes();
      if (slotStart < startTimeMin) {
        preserved.push(i);
      }
    }
  }
  
  if (preserved.length === 0) return null;
  
  const backup = {};
  Object.keys(schedules).forEach(bunk => {
    backup[bunk] = {};
    preserved.forEach(slotIdx => {
      if (schedules[bunk]?.[slotIdx]) {
        backup[bunk][slotIdx] = JSON.parse(JSON.stringify(schedules[bunk][slotIdx]));
      }
    });
  });
  
  window.saveCurrentDailyData?.("preservedScheduleBackup", backup);
  console.log(`[RainyDay] Backed up ${preserved.length} preserved slots`);
  return backup;
}

function switchToRainySkeleton() {
  const skeletonName = getRainyDaySkeletonName();
  if (!skeletonName) {
    console.log("[RainyDay] No rainy day skeleton configured");
    return false;
  }
  
  const g = window.loadGlobalSettings?.() || {};
  const savedSkeletons = g.app1?.savedSkeletons || {};
  const skeleton = savedSkeletons[skeletonName];
  
  if (!skeleton || skeleton.length === 0) {
    console.warn(`[RainyDay] Rainy day skeleton "${skeletonName}" not found or empty`);
    return false;
  }
  
  const dailyData = window.loadCurrentDailyData?.() || {};
  const currentSkeleton = dailyData.manualSkeleton || [];
  if (currentSkeleton.length > 0) {
    window.saveCurrentDailyData?.("preRainyDayManualSkeleton", JSON.parse(JSON.stringify(currentSkeleton)));
  }
  
  window.saveCurrentDailyData?.("manualSkeleton", JSON.parse(JSON.stringify(skeleton)));
  dailyOverrideSkeleton = JSON.parse(JSON.stringify(skeleton));
  window.dailyOverrideSkeleton = dailyOverrideSkeleton;
  
  console.log(`[RainyDay] Loaded rainy day skeleton "${skeletonName}"`);
  return true;
}

function deactivateRainyDayMode() {
  const dailyData = window.loadCurrentDailyData?.() || {};
  const preRainyDisabled = dailyData.preRainyDayDisabledFields || [];
  
  const overrides = dailyData.overrides || {};
  overrides.disabledFields = preRainyDisabled;
  currentOverrides.disabledFields = preRainyDisabled;
  
  // Fix #14 — explicitly reset window.isRainyDay
  window.isRainyDay = false;
  window.rainyDayStartTime = null;
  
  window.saveCurrentDailyData?.("overrides", overrides);
  window.saveCurrentDailyData?.("preRainyDayDisabledFields", null);
  window.saveCurrentDailyData?.("rainyDayMode", false);
  window.saveCurrentDailyData?.("rainyDayStartTime", null);
  window.saveCurrentDailyData?.("preservedScheduleBackup", null);
  window.saveCurrentDailyData?.("isRainyDay", false);
  
  if (isAutoSkeletonSwitchEnabled()) {
    restorePreRainySkeleton();
  }
  
  showRainyDayNotification(false);
  console.log("[RainyDay] Deactivated rainy mode, window.isRainyDay =", window.isRainyDay);
}

function restorePreRainySkeleton() {
  const dailyData = window.loadCurrentDailyData?.() || {};
  const backup = dailyData.preRainyDayManualSkeleton;
  
  if (backup && backup.length > 0) {
    window.saveCurrentDailyData?.("manualSkeleton", JSON.parse(JSON.stringify(backup)));
    window.saveCurrentDailyData?.("preRainyDayManualSkeleton", null);
    dailyOverrideSkeleton = JSON.parse(JSON.stringify(backup));
    window.dailyOverrideSkeleton = dailyOverrideSkeleton;
    console.log(`[RainyDay] Restored pre-rainy skeleton`);
    return true;
  }
  return false;
}

function showRainyDayNotification(activated, disabledCount = 0, isMidDay = false, skeletonSwitched = false, preservedCount = 0) {
  const existing = document.getElementById('da-rainy-notification');
  if (existing) existing.remove();
  
  const notif = document.createElement('div');
  notif.id = 'da-rainy-notification';
  notif.className = 'da-notif ' + (activated ? 'da-notif-rainy' : 'da-notif-sunny');
  
  if (activated) {
    let subtitle = `${disabledCount} outdoor field${disabledCount !== 1 ? 's' : ''} disabled`;
    if (isMidDay) {
      subtitle = `${preservedCount} slot${preservedCount !== 1 ? 's' : ''} preserved • ${disabledCount} field${disabledCount !== 1 ? 's' : ''} disabled`;
    }
    if (skeletonSwitched) subtitle += ' • Skeleton switched';
    
    notif.innerHTML = `
      <span class="da-notif-icon">${isMidDay ? '⏰' : '🌧️'}</span>
      <div>
        <div class="da-notif-title">${isMidDay ? 'Mid-Day Rainy Mode Activated' : 'Rainy Day Mode Activated'}</div>
        <div class="da-notif-subtitle">${subtitle}</div>
      </div>
    `;
  } else {
    notif.innerHTML = `
      <span class="da-notif-icon">☀️</span>
      <div>
        <div class="da-notif-title">Normal Mode Restored</div>
        <div class="da-notif-subtitle">All fields back to normal availability</div>
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
// FIELD RESERVATION HELPERS (Fix #3 — async)
// =================================================================
async function promptForReservedFields(eventName) {
  const allFields = (masterSettings.app1?.fields || []).map(f => f.name);
  const specialActivities = (masterSettings.app1?.specialActivities || []).map(s => s.name);
  const allLocations = [...new Set([...allFields, ...specialActivities])].sort();
  if (allLocations.length === 0) return [];
  
  const fieldInput = await showPrompt(
    `Which field(s) will "${eventName}" use?\n\n` +
    `This reserves the field so the scheduler won't assign it to other bunks.\n\n` +
    `Available fields:\n${allLocations.join(', ')}\n\n` +
    `Enter field names separated by commas (or leave blank if none):`,
    ''
  );
  if (!fieldInput || !fieldInput.trim()) return [];
  
  const requested = fieldInput.split(',').map(f => f.trim()).filter(Boolean);
  const validated = [], invalid = [];
  requested.forEach(name => {
    const match = allLocations.find(loc => loc.toLowerCase() === name.toLowerCase());
    if (match) validated.push(match);
    else invalid.push(name);
  });
  if (invalid.length > 0) await showAlert("Warning: These fields were not found and will be ignored:\n" + invalid.join(', '));
  return validated;
}

// =================================================================
// DISPLACED TILES
// =================================================================
function addDisplacedTile(event, reason) {
  displacedTiles.push({
    event: event.event, type: event.type, division: event.division,
    originalStart: event.startTime, originalEnd: event.endTime,
    reason: reason, timestamp: Date.now()
  });
  renderDisplacedTilesPanel();
}

function clearDisplacedTiles() {
  displacedTiles = [];
  renderDisplacedTilesPanel();
}

// Fix #32 — XSS in displaced tiles display
function renderDisplacedTilesPanel() {
  const panel = document.getElementById('da-displaced-tiles-panel');
  if (!panel) return;
  if (displacedTiles.length === 0) { panel.style.display = 'none'; return; }
  
  panel.style.display = 'block';
  panel.innerHTML = `
    <div class="da-displaced-panel">
      <div class="da-displaced-header">
        <strong>📋 Displaced Tiles (${displacedTiles.length})</strong>
        <button id="da-clear-displaced-btn" class="da-btn da-btn-ghost da-btn-sm">Clear</button>
      </div>
      <div class="da-displaced-list">
        ${displacedTiles.map(d => `
          <div class="da-displaced-item">
            <strong>${escapeHtml(d.event)}</strong> (${escapeHtml(d.division)}) - ${escapeHtml(d.originalStart)} - ${escapeHtml(d.originalEnd)}
          </div>
        `).join('')}
      </div>
    </div>
  `;
  document.getElementById('da-clear-displaced-btn').onclick = clearDisplacedTiles;
}

// =================================================================
// OVERLAP HANDLING
// =================================================================
// Fix #41 — accepts custom reason parameter
function eraseOverlappingTiles(newEvent, divName, reason) {
  const newStartMin = parseTimeToMinutes(newEvent.startTime);
  const newEndMin = parseTimeToMinutes(newEvent.endTime);
  const displacedReason = reason || ('Erased by ' + (newEvent.event || 'new tile'));
  
  dailyOverrideSkeleton = dailyOverrideSkeleton.filter(ev => {
    if (ev.id === newEvent.id || ev.division !== divName) return true;
    const evStart = parseTimeToMinutes(ev.startTime);
    const evEnd = parseTimeToMinutes(ev.endTime);
    if (evStart == null || evEnd == null) return true;
    const overlaps = (evStart < newEndMin && evEnd > newStartMin);
    if (overlaps) {
      addDisplacedTile(ev, displacedReason);
    }
    return !overlaps;
  });
}

// Fix #11 — adds bumped tiles to displaced panel when they overflow
function bumpOverlappingTiles(newEvent, divName) {
  const newStartMin = parseTimeToMinutes(newEvent.startTime);
  const newEndMin = parseTimeToMinutes(newEvent.endTime);
  const div = window.divisions?.[divName] || {};
  const divEndMin = parseTimeToMinutes(div.endTime) || 960;
  
  const overlapping = dailyOverrideSkeleton.filter(ev => {
    if (ev.id === newEvent.id || ev.division !== divName) return false;
    const evStart = parseTimeToMinutes(ev.startTime);
    const evEnd = parseTimeToMinutes(ev.endTime);
    if (evStart == null || evEnd == null) return false;
    return (evStart < newEndMin && evEnd > newStartMin);
  });
  
  if (overlapping.length === 0) return;
  overlapping.sort((a, b) => parseTimeToMinutes(a.startTime) - parseTimeToMinutes(b.startTime));
  
  let currentEndMin = newEndMin;
  overlapping.forEach(ev => {
    const evStart = parseTimeToMinutes(ev.startTime);
    const evEnd = parseTimeToMinutes(ev.endTime);
    const duration = evEnd - evStart;
    const newStart = currentEndMin;
    const newEnd = newStart + duration;
    
    if (newEnd > divEndMin) {
      // Fix #35 — displaced tiles are now tracked
      addDisplacedTile(ev, 'Bumped out of division boundary');
      dailyOverrideSkeleton = dailyOverrideSkeleton.filter(e => e.id !== ev.id);
    } else {
      ev.startTime = minutesToTime(newStart);
      ev.endTime = minutesToTime(newEnd);
      currentEndMin = newEnd;
    }
  });
}

// =================================================================
// TILE INFO DESCRIPTIONS
// =================================================================
const TILE_DESCRIPTIONS = {
  'activity': 'ACTIVITY SLOT: A flexible time block where the scheduler assigns either a sport or special activity based on availability and fairness rules.',
  'sports': 'SPORTS SLOT: Dedicated time for sports activities only. The scheduler will assign an available field and sport, rotating fairly among bunks.',
  'special': 'SPECIAL ACTIVITY: Time reserved for special activities like Art, Music, Drama, etc. Scheduler assigns based on capacity and usage limits.',
  'smart': 'SMART TILE: Balances two activities (e.g., Swim/Art) across bunks. One group gets Activity A while another gets Activity B, then they swap. Includes fallback if primary is full.',
  'split': 'SPLIT ACTIVITY: Divides the time block in half. First half is one activity, second half is another. Good for combining short activities.',
  'elective': 'ELECTIVE: Reserves specific fields/activities for THIS division only. Other divisions cannot use the selected resources during this time.',
  'league': 'LEAGUE GAME: Full buyout for a regular league matchup. All bunks in the division play head-to-head games. Fields are locked from other divisions.',
  'specialty_league': 'SPECIALTY LEAGUE: Similar to regular leagues but for special sports (e.g., Hockey, Flag Football). Multiple games can run on the same field.',
  'swim': 'SWIM: Pinned swim time. Automatically reserves the pool/swim area for this division.',
  'lunch': 'LUNCH: Fixed lunch period. No scheduling occurs during this time.',
  'snacks': 'SNACKS: Fixed snack break. No scheduling occurs during this time.',
  'dismissal': 'DISMISSAL: End of day marker. Schedule generation stops at this point.',
  'custom': 'CUSTOM PINNED: Create any fixed event (e.g., "Assembly", "Special Program"). You can optionally reserve specific fields.'
};

// Fix #3 — async
async function showTileInfo(tile) {
  const desc = TILE_DESCRIPTIONS[tile.type] || tile.description || 'No description available.';
  await showAlert(desc, tile.name.toUpperCase());
}

// Fix #12 — handles League/Specialty League types
function mapEventNameForOptimizer(name) {
  if (!name) name = "Free";
  const lower = name.toLowerCase().trim();
  if (lower === 'activity') return { type: 'slot', event: 'General Activity Slot' };
  if (lower === 'sports') return { type: 'slot', event: 'Sports Slot' };
  if (lower === 'special activity' || lower === 'special') return { type: 'slot', event: 'Special Activity' };
  if (lower.includes('specialty league')) return { type: 'specialty_league', event: 'Specialty League', buyout: true };
  if (lower.includes('league')) return { type: 'league', event: 'League Game', buyout: true };
  if (['swim','lunch','snacks','dismissal'].includes(lower)) return { type: 'pinned', event: name };
  return { type: 'pinned', event: name };
}

// =================================================================
// RENDER PALETTE
// =================================================================
function renderPalette() {
  const paletteEl = document.getElementById('da-palette');
  if (!paletteEl) return;
  
  paletteEl.innerHTML = '';
  
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
    paletteEl.appendChild(label);
    
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
        e.dataTransfer.effectAllowed = 'copy';
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
        const touchEndY = e.changedTouches[0].clientY;
        if (Math.abs(touchEndY - touchStartY) < 10) {
          showTileInfo(tile);
        }
      });
      
      paletteEl.appendChild(el);
    });
    
    if (catIndex < categories.length - 1) {
      const divider = document.createElement('div');
      divider.className = 'da-tile-divider';
      paletteEl.appendChild(divider);
    }
  });
}

// =================================================================
// RENDER GRID
// =================================================================
function renderGrid() {
  const gridEl = document.getElementById('da-skeleton-grid');
  if (!gridEl) return;
  
  const divisions = window.divisions || {};
  const availableDivisions = window.availableDivisions || [];
  if (availableDivisions.length === 0) {
    gridEl.innerHTML = `<div class="da-empty-state">No divisions found. Please go to Setup to create divisions.</div>`;
    return;
  }
  
  let earliestMin = null, latestMin = null;
  Object.values(divisions).forEach(div => {
    const s = parseTimeToMinutes(div.startTime);
    const e = parseTimeToMinutes(div.endTime);
    if (s !== null && (earliestMin === null || s < earliestMin)) earliestMin = s;
    if (e !== null && (latestMin === null || e > latestMin)) latestMin = e;
  });
  if (earliestMin === null) earliestMin = 540;
  if (latestMin === null) latestMin = 960;
  
  // Check for night activities and extend grid
  const nightEvents = dailyOverrideSkeleton.filter(ev => ev.isNightActivity);
  if (nightEvents.length > 0) {
    const latestNightEnd = Math.max(...nightEvents.map(ev => parseTimeToMinutes(ev.endTime) || 0));
    if (latestNightEnd > latestMin) {
      latestMin = latestNightEnd + 30;
    }
  }
  
  const latestPinned = Math.max(-Infinity, ...dailyOverrideSkeleton.map(e => parseTimeToMinutes(e.endTime) || -Infinity));
  if (latestPinned > -Infinity) latestMin = Math.max(latestMin, latestPinned);
  if (latestMin <= earliestMin) latestMin = earliestMin + 60;
  
  const totalHeight = (latestMin - earliestMin) * PIXELS_PER_MINUTE;
  gridEl.dataset.earliestMin = earliestMin;
  
  let html = `<div class="da-grid" style="grid-template-columns:60px repeat(${availableDivisions.length}, 1fr);">`;
  
  // Header row — Fix #38 XSS
  html += `<div class="da-grid-header da-time-header">Time</div>`;
  availableDivisions.forEach((divName) => {
    const color = divisions[divName]?.color || '#444';
    html += `<div class="da-grid-header" style="background:${color};color:#fff;">${escapeHtml(divName)}</div>`;
  });
  
  // Time column
  html += `<div class="da-time-column" style="height:${totalHeight}px;">`;
  for (let m = earliestMin; m < latestMin; m += INCREMENT_MINS) {
    const top = (m - earliestMin) * PIXELS_PER_MINUTE;
    html += `<div class="da-time-marker" style="top:${top}px;">${minutesToTime(m)}</div>`;
  }
  html += `</div>`;
  
  // Division columns — Fix #38 XSS in data-div attribute
  availableDivisions.forEach((divName) => {
    const div = divisions[divName];
    const s = parseTimeToMinutes(div?.startTime);
    const e = parseTimeToMinutes(div?.endTime);
    
    html += `<div class="da-grid-cell" data-div="${escapeHtml(divName)}" data-start-min="${earliestMin}" style="height:${totalHeight}px;">`;
    
    if (s !== null && s > earliestMin) {
      html += `<div class="da-grid-disabled" style="top:0;height:${(s - earliestMin) * PIXELS_PER_MINUTE}px;"></div>`;
    }
    if (e !== null && e < latestMin) {
      html += `<div class="da-grid-disabled da-grid-night-zone" style="top:${(e - earliestMin) * PIXELS_PER_MINUTE}px;height:${(latestMin - e) * PIXELS_PER_MINUTE}px;"></div>`;
    }
    
    dailyOverrideSkeleton.filter(ev => ev.division === divName).forEach(ev => {
      const start = parseTimeToMinutes(ev.startTime);
      const end = parseTimeToMinutes(ev.endTime);
      if (start != null && end != null && end > start) {
        const top = (start - earliestMin) * PIXELS_PER_MINUTE;
        const height = (end - start) * PIXELS_PER_MINUTE;
        html += renderEventTile(ev, top, height);
      }
    });
    
    html += `<div class="da-drop-preview"></div>`;
    html += `</div>`;
  });
  
  html += `</div>`;
  gridEl.innerHTML = html;
  
  addDropListeners(gridEl);
  addDragToRepositionListeners(gridEl);
  addResizeListeners(gridEl);
  addRemoveListeners(gridEl);
  applyConflictHighlighting(gridEl);
}

// Fix #32 — All user content escaped via escapeHtml()
function renderEventTile(ev, top, height) {
  let tile = TILES.find(t => t.name === ev.event);
  if (!tile && ev.type) tile = TILES.find(t => t.type === ev.type);
  if (!tile) {
    if (ev.event === 'General Activity Slot') tile = TILES.find(t => t.type === 'activity');
    else if (ev.event === 'Sports Slot') tile = TILES.find(t => t.type === 'sports');
    else if (ev.event === 'Special Activity') tile = TILES.find(t => t.type === 'special');
    else tile = TILES.find(t => t.type === 'custom');
  }
  
  let style = tile ? tile.style : 'background:#d1d5db;color:#374151;';
  const adjustedHeight = Math.max(height - 2, 18);
  
  const isNight = !!ev.isNightActivity;
  if (isNight) {
    style = 'background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);border:2px solid #e94560;color:#fff;';
  }
  
  const selectedClass = selectedTileId === ev.id ? ' selected' : '';
  const nightClass = isNight ? ' da-night-activity' : '';
  
  let fontSize, lineHeight, padding;
  if (adjustedHeight < 24) {
    fontSize = '9px'; lineHeight = '1.1'; padding = '1px 4px';
  } else if (adjustedHeight < 35) {
    fontSize = '10px'; lineHeight = '1.2'; padding = '2px 5px';
  } else if (adjustedHeight < 50) {
    fontSize = '11px'; lineHeight = '1.2'; padding = '3px 5px';
  } else {
    fontSize = '12px'; lineHeight = '1.3'; padding = '4px 6px';
  }
  
  const eventName = escapeHtml(ev.event || 'Event');
  const timeStr = `${escapeHtml(ev.startTime)}-${escapeHtml(ev.endTime)}`;
  
  let content;
  if (adjustedHeight < 24) {
    const shortName = eventName.length > 12 ? eventName.substring(0, 10) + '..' : eventName;
    content = `<span style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${shortName}${isNight ? ' 🌙' : ''}</span>`;
  } else if (adjustedHeight < 35) {
    content = `<span style="font-weight:600;">${eventName}</span>${isNight ? ' 🌙' : ''} <span style="font-size:9px;opacity:0.8;">${timeStr}</span>`;
  } else {
    content = `<strong>${eventName}</strong>`;
    if (isNight) content += ' 🌙';
    content += `<div style="font-size:10px;opacity:0.85;">${timeStr}</div>`;
    
    if (adjustedHeight > 50) {
      const locationDisplay = ev.location || (ev.reservedFields?.length > 0 ? ev.reservedFields.join(', ') : null);
      if (locationDisplay && ev.type !== 'elective') {
        content += `<div style="font-size:9px;opacity:0.8;">📍 ${escapeHtml(locationDisplay)}</div>`;
      }
      
      if (ev.type === 'elective' && ev.electiveActivities?.length > 0) {
        const actList = escapeHtml(ev.electiveActivities.slice(0, 3).join(', '));
        const more = ev.electiveActivities.length > 3 ? ` +${ev.electiveActivities.length - 3}` : '';
        content += `<div style="font-size:9px;opacity:0.8;">🎯 ${actList}${more}</div>`;
      }
      
      if (ev.type === 'smart' && ev.smartData) {
        content += `<div style="font-size:9px;opacity:0.8;">F: ${escapeHtml(ev.smartData.fallbackActivity)}</div>`;
      }
    }
  }
  
  return `<div class="da-event${selectedClass}${nightClass}" data-id="${escapeHtml(ev.id)}" draggable="true" 
          title="${eventName} (${timeStr})${isNight ? ' - Night Activity' : ''} - Double-click to remove"
          style="${style}top:${top}px;height:${adjustedHeight}px;font-size:${fontSize};line-height:${lineHeight};padding:${padding};">
          <div class="da-resize-handle da-resize-top"></div>
          ${content}
          <div class="da-resize-handle da-resize-bottom"></div>
          </div>`;
}

// =================================================================
// CONFLICT HIGHLIGHTING
// =================================================================
// Fix #18 — shows indicator when SkeletonSandbox not loaded
function applyConflictHighlighting(gridEl) {
  if (!window.SkeletonSandbox) {
    const indicator = gridEl.querySelector('.da-conflict-status');
    if (!indicator) {
      const note = document.createElement('div');
      note.className = 'da-conflict-status';
      note.style.cssText = 'position:absolute;top:4px;right:8px;font-size:10px;color:#94a3b8;z-index:11;';
      note.textContent = '⚠️ Conflict detection unavailable';
      const wrapper = gridEl.closest('.da-grid-wrapper');
      if (wrapper) { wrapper.style.position = 'relative'; wrapper.appendChild(note); }
    }
    return;
  }
  
  window.SkeletonSandbox.loadRules();
  const conflicts = window.SkeletonSandbox.detectConflicts(dailyOverrideSkeleton);
  
  if (!conflicts || conflicts.length === 0) {
    gridEl.querySelectorAll('.da-event').forEach(tile => {
      tile.classList.remove('da-conflict-warn', 'da-conflict-notice');
    });
    return;
  }
  
  const conflictMap = {};
  conflicts.forEach(c => {
    const severity = c.type;
    if (c.event1?.id) conflictMap[c.event1.id] = severity;
    if (c.event2?.id) conflictMap[c.event2.id] = severity;
  });
  
  gridEl.querySelectorAll('.da-event').forEach(tile => {
    tile.classList.remove('da-conflict-warn', 'da-conflict-notice');
    const id = tile.dataset.id;
    const severity = conflictMap[id];
    if (severity === 'warn' || severity === 'critical') {
      tile.classList.add('da-conflict-warn');
    } else if (severity === 'notice' || severity === 'warning') {
      tile.classList.add('da-conflict-notice');
    }
  });
}

// =================================================================
// EVENT LISTENERS - RESIZE (Fix #10 — minimum 15-min duration)
// =================================================================
function addResizeListeners(gridEl) {
  const earliestMin = parseInt(gridEl.dataset.earliestMin, 10) || 540;
  
  let tooltip = document.getElementById('da-resize-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'da-resize-tooltip';
    document.body.appendChild(tooltip);
  }
  
  gridEl.querySelectorAll('.da-event').forEach(tile => {
    const topHandle = tile.querySelector('.da-resize-top');
    const bottomHandle = tile.querySelector('.da-resize-bottom');
    
    [topHandle, bottomHandle].forEach(handle => {
      if (!handle) return;
      const direction = handle.classList.contains('da-resize-top') ? 'top' : 'bottom';
      let isResizing = false, startY = 0, startTop = 0, startHeight = 0, eventId = null;
      
      handle.onmousedown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        isResizing = true;
        startY = e.clientY;
        startTop = parseInt(tile.style.top, 10);
        startHeight = tile.offsetHeight;
        eventId = tile.dataset.id;
        tile.classList.add('da-resizing');
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      };
      
      function onMouseMove(e) {
        if (!isResizing) return;
        const event = dailyOverrideSkeleton.find(ev => ev.id === eventId);
        if (!event) return;
        
        const deltaY = e.clientY - startY;
        let newTop = startTop, newHeight = startHeight;
        
        if (direction === 'bottom') {
          newHeight = Math.max(SNAP_MINS * PIXELS_PER_MINUTE, startHeight + deltaY);
          newHeight = Math.round(newHeight / (SNAP_MINS * PIXELS_PER_MINUTE)) * (SNAP_MINS * PIXELS_PER_MINUTE);
        } else {
          const maxDelta = startHeight - (SNAP_MINS * PIXELS_PER_MINUTE);
          const constrainedDelta = Math.min(deltaY, maxDelta);
          const snappedDelta = Math.round(constrainedDelta / (SNAP_MINS * PIXELS_PER_MINUTE)) * (SNAP_MINS * PIXELS_PER_MINUTE);
          newTop = startTop + snappedDelta;
          newHeight = startHeight - snappedDelta;
        }
        
        tile.style.top = newTop + 'px';
        tile.style.height = newHeight + 'px';
        
        const newStartMin = earliestMin + (newTop / PIXELS_PER_MINUTE);
        const newEndMin = newStartMin + (newHeight / PIXELS_PER_MINUTE);
        const duration = newEndMin - newStartMin;
        const durationStr = duration < 60 ? `${duration}m` : `${Math.floor(duration/60)}h${duration%60 > 0 ? duration%60+'m' : ''}`;
        
        tooltip.innerHTML = `${minutesToTime(newStartMin)} - ${minutesToTime(newEndMin)}<br><span>${durationStr}</span>`;
        tooltip.style.display = 'block';
        tooltip.style.left = (e.clientX + 15) + 'px';
        tooltip.style.top = (e.clientY - 40) + 'px';
      }
      
      function onMouseUp() {
        if (!isResizing) return;
        isResizing = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        tile.classList.remove('da-resizing');
        tooltip.style.display = 'none';
        
        const event = dailyOverrideSkeleton.find(ev => ev.id === eventId);
        if (!event) return;
        
        const newTop = parseInt(tile.style.top, 10);
        const newHeightPx = parseInt(tile.style.height, 10);
        const newStartMin = earliestMin + (newTop / PIXELS_PER_MINUTE);
        const newEndMin = newStartMin + (newHeightPx / PIXELS_PER_MINUTE);
        
        const MIN_DURATION = 15; // Fix #10 — enforce 15-minute minimum
        const div = window.divisions?.[event.division] || {};
        const divStartMin = parseTimeToMinutes(div.startTime) || 540;
        const divEndMin = parseTimeToMinutes(div.endTime) || 960;
        
        let finalStart, finalEnd;
        if (event.isNightActivity) {
          finalStart = Math.max(divStartMin, Math.round(newStartMin / SNAP_MINS) * SNAP_MINS);
          finalEnd = Math.round(newEndMin / SNAP_MINS) * SNAP_MINS;
        } else {
          finalStart = Math.max(divStartMin, Math.round(newStartMin / SNAP_MINS) * SNAP_MINS);
          finalEnd = Math.min(divEndMin, Math.round(newEndMin / SNAP_MINS) * SNAP_MINS);
        }
        // Enforce minimum duration
        if (finalEnd - finalStart < MIN_DURATION) {
          if (direction === 'bottom') finalEnd = finalStart + MIN_DURATION;
          else finalStart = finalEnd - MIN_DURATION;
        }
        event.startTime = minutesToTime(finalStart);
        event.endTime = minutesToTime(finalEnd);
        
        saveDailySkeleton();
        renderGrid();
      }
    });
  });
}

// =================================================================
// EVENT LISTENERS - DRAG TO REPOSITION (Fix #8, #9)
// =================================================================
function addDragToRepositionListeners(gridEl) {
  const earliestMin = parseInt(gridEl.dataset.earliestMin, 10) || 540;
  
  let ghost = document.getElementById('da-drag-ghost');
  if (!ghost) {
    ghost = document.createElement('div');
    ghost.id = 'da-drag-ghost';
    document.body.appendChild(ghost);
  }
  
  let dragData = null;
  
  gridEl.querySelectorAll('.da-event').forEach(tile => {
    tile.addEventListener('dragstart', (e) => {
      if (e.target.classList.contains('da-resize-handle')) { e.preventDefault(); return; }
      
      const eventId = tile.dataset.id;
      const event = dailyOverrideSkeleton.find(ev => ev.id === eventId);
      if (!event) return;
      
      const duration = parseTimeToMinutes(event.endTime) - parseTimeToMinutes(event.startTime);
      dragData = { type: 'move', id: eventId, event, duration };
      
      e.dataTransfer.setData('text/event-move', eventId);
      e.dataTransfer.effectAllowed = 'move';
      
      ghost.innerHTML = `<strong>${escapeHtml(event.event)}</strong><br><span>${event.startTime} - ${event.endTime}</span>`;
      ghost.style.display = 'block';
      
      const img = new Image();
      img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      e.dataTransfer.setDragImage(img, 0, 0);
      
      tile.style.opacity = '0.4';
    });
    
    tile.addEventListener('drag', (e) => {
      if (e.clientX === 0 && e.clientY === 0) return;
      ghost.style.left = (e.clientX + 12) + 'px';
      ghost.style.top = (e.clientY + 12) + 'px';
    });
    
    tile.addEventListener('dragend', () => {
      tile.style.opacity = '1';
      ghost.style.display = 'none';
      dragData = null;
      gridEl.querySelectorAll('.da-drop-preview').forEach(p => { p.style.display = 'none'; p.innerHTML = ''; });
      gridEl.querySelectorAll('.da-grid-cell').forEach(c => c.style.background = '');
    });
  });
  
  gridEl.querySelectorAll('.da-grid-cell').forEach(cell => {
    const preview = cell.querySelector('.da-drop-preview');
    
    cell.addEventListener('dragover', (e) => {
      const isEventMove = e.dataTransfer.types.includes('text/event-move');
      const isNewTile = e.dataTransfer.types.includes('application/json');
      if (!isEventMove && !isNewTile) return;
      
      e.preventDefault();
      e.dataTransfer.dropEffect = isEventMove ? 'move' : 'copy';
      cell.style.background = 'rgba(59,130,246,0.1)';
      
      if (isEventMove && dragData && preview) {
        const rect = cell.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const snapMin = Math.round(y / PIXELS_PER_MINUTE / SNAP_MINS) * SNAP_MINS;
        const cellStartMin = parseInt(cell.dataset.startMin, 10);
        const previewStartTime = minutesToTime(cellStartMin + snapMin);
        const previewEndTime = minutesToTime(cellStartMin + snapMin + dragData.duration);
        
        preview.style.display = 'block';
        preview.style.top = (snapMin * PIXELS_PER_MINUTE) + 'px';
        preview.style.height = (dragData.duration * PIXELS_PER_MINUTE) + 'px';
        preview.innerHTML = `<div class="da-preview-time">${previewStartTime} - ${previewEndTime}</div>`;
      }
    });
    
    cell.addEventListener('dragleave', (e) => {
      if (!cell.contains(e.relatedTarget)) {
        cell.style.background = '';
        if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }
      }
    });
    
    cell.addEventListener('drop', (e) => {
      cell.style.background = '';
      if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }
      
      if (e.dataTransfer.types.includes('text/event-move')) {
        e.preventDefault();
        const eventId = e.dataTransfer.getData('text/event-move');
        const event = dailyOverrideSkeleton.find(ev => ev.id === eventId);
        if (!event) return;
        
        const divName = cell.dataset.div;
        const cellStartMin = parseInt(cell.dataset.startMin, 10);
        const rect = cell.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const snapMin = Math.round(y / PIXELS_PER_MINUTE / SNAP_MINS) * SNAP_MINS;
        
        const duration = parseTimeToMinutes(event.endTime) - parseTimeToMinutes(event.startTime);
        
        // Fix #9, #8 — clamp to division boundaries
        const div = window.divisions?.[divName] || {};
        const divStartMin = parseTimeToMinutes(div.startTime);
        const divEndMin = parseTimeToMinutes(div.endTime);
        let newStart = cellStartMin + snapMin;
        if (divStartMin !== null && newStart < divStartMin) newStart = divStartMin;
        if (divEndMin !== null && newStart + duration > divEndMin && !event.isNightActivity) {
          newStart = divEndMin - duration;
        }
        
        event.division = divName;
        event.startTime = minutesToTime(newStart);
        event.endTime = minutesToTime(newStart + duration);
        
        bumpOverlappingTiles(event, divName);
        saveDailySkeleton();
        renderGrid();
        return;
      }
    });
  });
}


// =================================================================
// EVENT LISTENERS - DROP (New Tile Creation) - All async (#2, #3, #4, #9, #24)
// =================================================================
function addDropListeners(gridEl) {
  const earliestMin = parseInt(gridEl.dataset.earliestMin, 10) || 540;
  
  gridEl.querySelectorAll('.da-grid-cell').forEach(cell => {
    cell.ondragover = (e) => {
      if (e.dataTransfer.types.includes('text/event-move')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      cell.style.background = 'rgba(59,130,246,0.08)';
    };
    
    cell.ondragleave = (e) => {
      if (!cell.contains(e.relatedTarget)) {
        cell.style.background = '';
      }
    };
    
    cell.ondrop = async (e) => {
      if (e.dataTransfer.types.includes('text/event-move')) return;
      e.preventDefault();
      cell.style.background = '';
      
      let tileData;
      try {
        tileData = JSON.parse(e.dataTransfer.getData('application/json'));
      } catch (err) { return; }
      if (!tileData) return;
      
      if (!window.AccessControl?.checkEditAccess?.('add skeleton tile')) return;
      
      const divName = cell.dataset.div;
      const div = window.divisions?.[divName] || {};
      const divStartMin = parseTimeToMinutes(div.startTime);
      const divEndMin = parseTimeToMinutes(div.endTime);
      
      const rect = cell.getBoundingClientRect();
      const offsetY = e.clientY - rect.top;
      let minOffset = Math.round(offsetY / PIXELS_PER_MINUTE / 15) * 15;
      let startMin = earliestMin + minOffset;
      // Fix #9 — clamp default start to division boundaries
      if (divStartMin !== null && startMin < divStartMin) startMin = divStartMin;
      let endMin = startMin + INCREMENT_MINS;
      if (divEndMin !== null && endMin > divEndMin) endMin = divEndMin;
      const startStr = minutesToTime(startMin);
      const endStr = minutesToTime(endMin);
      
      let newEvent = null;
      let isNightActivity = false;
      
      // Fix #24 — configurable guard hours via getGuardHours()
      const validateTime = async (timeStr, isStartTime, allowNightActivity = false) => {
        const timeMin = parseTimeToMinutes(timeStr);
        if (timeMin === null) {
          await showAlert("Invalid time format. Please use '9:00am' or '2:30pm'.");
          return { valid: false, minutes: null, isNight: false };
        }
        
        const guardHours = getGuardHours();
        const outsideDefaultHours = (timeMin < guardHours.start || timeMin > guardHours.end);
        const coveredByDivision = (divStartMin !== null && divEndMin !== null && timeMin >= divStartMin && timeMin <= divEndMin);
        if (outsideDefaultHours && !coveredByDivision) {
          const guardStartStr = minutesToTime(guardHours.start);
          const guardEndStr = minutesToTime(guardHours.end);
          const ok = await showConfirm(
            `⚠️ Unusual Time Warning\n\n"${timeStr}" is outside normal camp hours (${guardStartStr} – ${guardEndStr}).\n\nJust confirming — is this tile correct?\n\nClick OK to proceed, Cancel to re-enter.`
          );
          if (!ok) return { valid: false, minutes: null, isNight: false };
        }
        
        if (divStartMin !== null && timeMin < divStartMin) {
          await showAlert("Error: " + timeStr + " is before this division's start time of " + div.startTime + ".");
          return { valid: false, minutes: null, isNight: false };
        }
        
        if (divEndMin !== null && (isStartTime ? timeMin >= divEndMin : timeMin > divEndMin)) {
          if (allowNightActivity) {
            return { valid: true, minutes: timeMin, isNight: true };
          }
          
          const isNight = await showConfirm(
            `⏰ "${timeStr}" is after this division's end time (${div.endTime}).\n\n` +
            `Is this a NIGHT ACTIVITY / LATE NIGHT event?\n\n` +
            `Click OK for Night Activity, Cancel to re-enter time.`
          );
          
          if (isNight) {
            return { valid: true, minutes: timeMin, isNight: true };
          } else {
            return { valid: false, minutes: null, isNight: false };
          }
        }
        
        return { valid: true, minutes: timeMin, isNight: false };
      };
      
      // ---------------------------------------------------------------
      // Handle SMART TILE
      // ---------------------------------------------------------------
      if (tileData.type === 'smart') {
        let startTime, endTime, startResult, endResult;
        while (true) {
          startTime = await showPrompt("Smart Tile for " + divName + ".\n\nEnter Start Time:", startStr);
          if (!startTime) return;
          startResult = await validateTime(startTime, true);
          if (startResult.valid) {
            isNightActivity = startResult.isNight;
            break;
          }
        }
        while (true) {
          endTime = await showPrompt("Enter End Time:");
          if (!endTime) return;
          endResult = await validateTime(endTime, false, isNightActivity);
          if (endResult.valid) {
            if (endResult.minutes <= startResult.minutes) await showAlert("End time must be after start time.");
            else {
              if (endResult.isNight) isNightActivity = true;
              break;
            }
          }
        }
        const rawMains = await showPrompt("Enter the TWO MAIN activities (e.g., Swim / Special):");
        if (!rawMains) return;
        const mains = rawMains.split(/,|\//).map(s => s.trim()).filter(Boolean);
        if (mains.length < 2) { await showAlert("Please enter TWO distinct activities."); return; }
        const [main1, main2] = mains;
        const pick = await showPrompt("Which activity requires a fallback?\n\n1: " + main1 + "\n2: " + main2);
        if (!pick) return;
        let fallbackFor;
        if (pick.trim() === "1" || pick.trim().toLowerCase() === main1.toLowerCase()) fallbackFor = main1;
        else if (pick.trim() === "2" || pick.trim().toLowerCase() === main2.toLowerCase()) fallbackFor = main2;
        else { await showAlert("Invalid choice."); return; }
        const fallbackActivity = await showPrompt("If \"" + fallbackFor + "\" is unavailable, what should be played?\nExample: Sports");
        if (!fallbackActivity) return;
        
        const reservedFields = await promptForReservedFields('Smart Tile');
        
        newEvent = {
          id: uid(), type: 'smart', event: 'Smart Tile',
          division: divName, startTime, endTime,
          isNightActivity,
          reservedFields,
          smartData: { main1, main2, fallbackFor, fallbackActivity }
        };
      }
      
      // ---------------------------------------------------------------
      // Handle SPLIT TILE
      // ---------------------------------------------------------------
      else if (tileData.type === 'split') {
        let startTime, endTime, startResult, endResult;
        
        while (true) {
          startTime = await showPrompt("Enter Start Time for the *full* block:", startStr);
          if (!startTime) return;
          startResult = await validateTime(startTime, true);
          if (startResult.valid) {
            isNightActivity = startResult.isNight;
            break;
          }
        }
        
        while (true) {
          endTime = await showPrompt("Enter End Time for the *full* block:");
          if (!endTime) return;
          endResult = await validateTime(endTime, false, isNightActivity);
          if (endResult.valid) {
            if (endResult.minutes <= startResult.minutes) await showAlert("End time must be after start time.");
            else {
              if (endResult.isNight) isNightActivity = true;
              break;
            }
          }
        }
        
        const eventName1 = await showPrompt(
          "Enter name for FIRST activity (Main 1):\n\n" +
          "• Group 1 does this FIRST half\n" +
          "• Group 2 does this SECOND half\n\n" +
          "Examples: Swim, Sports, Art"
        );
        if (!eventName1) return;
        
        const eventName2 = await showPrompt(
          "Enter name for SECOND activity (Main 2):\n\n" +
          "• Group 2 does this FIRST half\n" +
          "• Group 1 does this SECOND half\n\n" +
          "Examples: Swim, Sports, Art"
        );
        if (!eventName2) return;
        
        const midMin = startResult.minutes + Math.floor((endResult.minutes - startResult.minutes) / 2);
        const midTime = minutesToTime(midMin);
        
        const reservedFields = await promptForReservedFields('Split Tile');
        
        newEvent = {
          id: uid(), type: 'split', event: 'Split: ' + eventName1 + ' / ' + eventName2,
          division: divName, startTime, endTime,
          isNightActivity,
          reservedFields,
          splitData: {
            activity1: eventName1, activity2: eventName2,
            midTime,
            startTime1: startTime, endTime1: midTime,
            startTime2: midTime, endTime2: endTime
          }
        };
      }
      
      // ---------------------------------------------------------------
      // Handle ELECTIVE (Fix #13 — locationZones included)
      // ---------------------------------------------------------------
      else if (tileData.type === 'elective') {
        let startTime, endTime, startResult, endResult;
        while (true) {
          startTime = await showPrompt("Elective for " + divName + ".\n\nEnter Start Time:", startStr);
          if (!startTime) return;
          startResult = await validateTime(startTime, true);
          if (startResult.valid) {
            isNightActivity = startResult.isNight;
            break;
          }
        }
        while (true) {
          endTime = await showPrompt("Enter End Time:");
          if (!endTime) return;
          endResult = await validateTime(endTime, false, isNightActivity);
          if (endResult.valid) {
            if (endResult.minutes <= startResult.minutes) await showAlert("End time must be after start time.");
            else {
              if (endResult.isNight) isNightActivity = true;
              break;
            }
          }
        }
        
        const allFields = (masterSettings.app1?.fields || []).map(f => f.name);
        const allSpecials = (masterSettings.app1?.specialActivities || []).map(s => s.name);
        // Fix #13 — include locationZones (Pool, Lunchroom, etc.)
        const locationZones = masterSettings.global?.locationZones || {};
        const zoneLocations = [];
        Object.values(locationZones).forEach(zone => {
          if (zone?.locations) Object.keys(zone.locations).forEach(loc => zoneLocations.push(loc));
        });
        const allLocations = [...new Set([...allFields, ...allSpecials, ...zoneLocations])].sort();
        
        const activitiesInput = await showPrompt(
          "Which activities should be RESERVED for " + divName + " during this time?\n\n" +
          "Available:\n" + allLocations.join(', ') + "\n\n" +
          "Enter names separated by commas:"
        );
        if (!activitiesInput) return;
        
        const electiveActivities = activitiesInput.split(',').map(s => s.trim()).filter(Boolean);
        if (electiveActivities.length === 0) { await showAlert("Please enter at least one activity."); return; }
        
        newEvent = {
          id: uid(), type: 'elective', event: 'Elective',
          division: divName, startTime, endTime,
          isNightActivity,
          electiveActivities,
          reservedFields: electiveActivities
        };
      }
      
      // ---------------------------------------------------------------
      // Handle LEAGUE tiles
      // ---------------------------------------------------------------
      else if (tileData.type === 'league') {
        let startTime, endTime, startResult, endResult;
        while (true) {
          startTime = await showPrompt("League Game start time:", startStr);
          if (!startTime) return;
          startResult = await validateTime(startTime, true);
          if (startResult.valid) {
            isNightActivity = startResult.isNight;
            break;
          }
        }
        while (true) {
          endTime = await showPrompt("League Game end time:");
          if (!endTime) return;
          endResult = await validateTime(endTime, false, isNightActivity);
          if (endResult.valid) {
            if (endResult.minutes <= startResult.minutes) await showAlert("End time must be after start time.");
            else {
              if (endResult.isNight) isNightActivity = true;
              break;
            }
          }
        }
        
        newEvent = {
          id: uid(), type: 'league', event: 'League Game',
          division: divName, startTime, endTime,
          isNightActivity, buyout: true, reservedFields: []
        };
      }
      
      // ---------------------------------------------------------------
      // Handle SPECIALTY LEAGUE tiles
      // ---------------------------------------------------------------
      else if (tileData.type === 'specialty_league') {
        let startTime, endTime, startResult, endResult;
        while (true) {
          startTime = await showPrompt("Specialty League start time:", startStr);
          if (!startTime) return;
          startResult = await validateTime(startTime, true);
          if (startResult.valid) {
            isNightActivity = startResult.isNight;
            break;
          }
        }
        while (true) {
          endTime = await showPrompt("Specialty League end time:");
          if (!endTime) return;
          endResult = await validateTime(endTime, false, isNightActivity);
          if (endResult.valid) {
            if (endResult.minutes <= startResult.minutes) await showAlert("End time must be after start time.");
            else {
              if (endResult.isNight) isNightActivity = true;
              break;
            }
          }
        }
        
        newEvent = {
          id: uid(), type: 'specialty_league', event: 'Specialty League',
          division: divName, startTime, endTime,
          isNightActivity, buyout: true, reservedFields: []
        };
      }
      
      // ---------------------------------------------------------------
      // Handle PINNED TILES (swim, lunch, snacks, dismissal, custom)
      // ---------------------------------------------------------------
      else if (['swim','lunch','snacks','dismissal','custom'].includes(tileData.type)) {
        let name = tileData.name;
        
        if (tileData.type === 'custom') {
          name = await showPrompt("Event Name:", "Regroup");
          if (!name) return;
          const manualFields = await promptForReservedFields(name);
          
          let st, et, stResult, etResult;
          while (true) {
            st = await showPrompt(name + " Start:", startStr);
            if (!st) return;
            stResult = await validateTime(st, true);
            if (stResult.valid) {
              isNightActivity = stResult.isNight;
              break;
            }
          }
          while (true) {
            et = await showPrompt(name + " End:", endStr);
            if (!et) return;
            etResult = await validateTime(et, false, isNightActivity);
            if (etResult.valid) {
              if (etResult.minutes <= stResult.minutes) await showAlert("End time must be after start time.");
              else {
                if (etResult.isNight) isNightActivity = true;
                break;
              }
            }
          }
          
          newEvent = {
            id: uid(), type: 'pinned',
            event: name, division: divName,
            startTime: st, endTime: et,
            isNightActivity,
            reservedFields: manualFields
          };
        } else {
          // swim, lunch, snacks, dismissal
          let st, et, stResult, etResult;
          while (true) {
            st = await showPrompt(name + " Start:", startStr);
            if (!st) return;
            stResult = await validateTime(st, true);
            if (stResult.valid) {
              isNightActivity = stResult.isNight;
              break;
            }
          }
          while (true) {
            et = await showPrompt(name + " End:", endStr);
            if (!et) return;
            etResult = await validateTime(et, false, isNightActivity);
            if (etResult.valid) {
              if (etResult.minutes <= stResult.minutes) await showAlert("End time must be after start time.");
              else {
                if (etResult.isNight) isNightActivity = true;
                break;
              }
            }
          }
          
          let reservedFields = [];
          if (tileData.type === 'swim') {
            const poolFields = (masterSettings.app1?.fields || [])
              .filter(f => (f.name || '').toLowerCase().includes('pool') || (f.activities || []).some(a => a.toLowerCase().includes('swim')))
              .map(f => f.name);
            reservedFields = poolFields;
          }
          
          newEvent = {
            id: uid(), type: 'pinned',
            event: name, division: divName,
            startTime: st, endTime: et,
            isNightActivity,
            reservedFields
          };
        }
      }
      
      // ---------------------------------------------------------------
      // Handle standard slots (Activity, Sports, Special)
      // ---------------------------------------------------------------
      else {
        let name = tileData.name;
        let finalType = tileData.type;
        if (tileData.type === 'activity') { name = "General Activity Slot"; finalType = 'slot'; }
        else if (tileData.type === 'sports') { name = "Sports Slot"; finalType = 'slot'; }
        else if (tileData.type === 'special') { name = "Special Activity"; finalType = 'slot'; }
        if (!name) return;
        
        let st, et, stResult, etResult;
        while (true) {
          st = await showPrompt(name + " Start:", startStr);
          if (!st) return;
          stResult = await validateTime(st, true);
          if (stResult.valid) {
            isNightActivity = stResult.isNight;
            break;
          }
        }
        while (true) {
          et = await showPrompt(name + " End:", endStr);
          if (!et) return;
          etResult = await validateTime(et, false, isNightActivity);
          if (etResult.valid) {
            if (etResult.minutes <= stResult.minutes) await showAlert("End time must be after start time.");
            else {
              if (etResult.isNight) isNightActivity = true;
              break;
            }
          }
        }
        newEvent = {
          id: uid(), type: finalType,
          event: name, division: divName,
          startTime: st, endTime: et,
          isNightActivity,
          reservedFields: []
        };
      }
      
      // ---------------------------------------------------------------
      // COMMON: Push new event and render
      // ---------------------------------------------------------------
      if (newEvent) {
        dailyOverrideSkeleton.push(newEvent);
        saveDailySkeleton();
        renderGrid();
      }
    };
    
    // ---------------------------------------------------------------
    // Mobile touch drop support (Fix #16 — float comparison)
    // ---------------------------------------------------------------
    cell.addEventListener('touchend', async (e) => {
      const tiles = document.querySelectorAll('.da-tile');
      const draggedTile = Array.from(tiles).find(t => parseFloat(t.style.opacity) > 0 && parseFloat(t.style.opacity) < 0.8);
      if (!draggedTile) return;
      
      let tileData;
      try {
        tileData = JSON.parse(draggedTile.dataset.tileData);
      } catch (err) { return; }
      if (!tileData) return;
      
      draggedTile.style.opacity = '1';
      
      const touch = e.changedTouches[0];
      const fakeEvent = {
        preventDefault: () => {},
        clientX: touch.clientX,
        clientY: touch.clientY,
        dataTransfer: {
          types: ['application/json'],
          getData: () => JSON.stringify(tileData)
        }
      };
      
      // Trigger the same async drop handler
      await cell.ondrop(fakeEvent);
    });
  });
}

// =================================================================
// EVENT LISTENERS - REMOVE (Double-click + Selection) — Fix #2
// =================================================================
function addRemoveListeners(gridEl) {
  gridEl.querySelectorAll('.da-event').forEach(tile => {
    // Selection
    tile.onclick = (e) => {
      e.stopPropagation();
      if (e.target.classList.contains('da-resize-handle')) return;
      const id = tile.dataset.id;
      if (selectedTileId === id) {
        selectedTileId = null;
      } else {
        selectedTileId = id;
      }
      gridEl.querySelectorAll('.da-event').forEach(t => t.classList.remove('selected'));
      if (selectedTileId) tile.classList.add('selected');
    };
    
    // Fix #2 — async showConfirm instead of blocking confirm()
    tile.ondblclick = async (e) => {
      e.stopPropagation();
      if (e.target.classList.contains('da-resize-handle')) return;
      const id = tile.dataset.id;
      if (!id) return;
      if (await showConfirm("Delete this block?")) {
        dailyOverrideSkeleton = dailyOverrideSkeleton.filter(x => x.id !== id);
        selectedTileId = null;
        saveDailySkeleton();
        renderGrid();
      }
    };
  });
  
  // Deselect on click outside
  gridEl.onclick = (e) => {
    if (e.target.classList.contains('da-grid-cell') || e.target.classList.contains('da-grid-disabled')) {
      selectedTileId = null;
      gridEl.querySelectorAll('.da-event').forEach(t => t.classList.remove('selected'));
    }
  };
}

// =================================================================
// SAVE / LOAD SKELETON (Fix #7 — clone before write)
// =================================================================
function saveDailySkeleton() {
  const dateKey = window.currentScheduleDate;
  if (!dateKey) return;
  
  window.dailyOverrideSkeleton = dailyOverrideSkeleton;
  
  // Save to daily data
  window.saveCurrentDailyData?.("manualSkeleton", JSON.parse(JSON.stringify(dailyOverrideSkeleton)));
  
  // Save to masterSettings (Fix #7 — deep clone to prevent reference mutation)
  if (!masterSettings.app1) masterSettings.app1 = {};
  if (!masterSettings.app1.dailySkeletons) masterSettings.app1.dailySkeletons = {};
  masterSettings.app1.dailySkeletons[dateKey] = JSON.parse(JSON.stringify(dailyOverrideSkeleton));
  
  // Cloud sync
  window.saveGlobalSettings?.("app1", masterSettings.app1);
  
  // localStorage cache
  try {
    localStorage.setItem(`campManualSkeleton_${dateKey}`, JSON.stringify(dailyOverrideSkeleton));
  } catch (e) { /* quota exceeded */ }
}

function loadDailySkeleton() {
  const dateKey = window.currentScheduleDate;
  if (!dateKey) { dailyOverrideSkeleton = []; return; }
  
  // Priority 1: localStorage (fastest, offline-capable)
  try {
    const stored = localStorage.getItem(`campManualSkeleton_${dateKey}`);
    if (stored) {
      dailyOverrideSkeleton = JSON.parse(stored);
      window.dailyOverrideSkeleton = dailyOverrideSkeleton;
      return;
    }
  } catch (e) { /* corrupt cache */ }
  
  // Priority 2: Cloud (masterSettings)
  const cloudSkeleton = masterSettings?.app1?.dailySkeletons?.[dateKey];
  if (cloudSkeleton && cloudSkeleton.length > 0) {
    dailyOverrideSkeleton = JSON.parse(JSON.stringify(cloudSkeleton));
    window.dailyOverrideSkeleton = dailyOverrideSkeleton;
    localStorage.setItem(`campManualSkeleton_${dateKey}`, JSON.stringify(dailyOverrideSkeleton));
    return;
  }
  
  // Priority 3: Daily data (legacy)
  const dailyData = window.loadCurrentDailyData?.() || {};
  if (dailyData.manualSkeleton && dailyData.manualSkeleton.length > 0) {
    dailyOverrideSkeleton = JSON.parse(JSON.stringify(dailyData.manualSkeleton));
    window.dailyOverrideSkeleton = dailyOverrideSkeleton;
    return;
  }
  
  dailyOverrideSkeleton = [];
  window.dailyOverrideSkeleton = dailyOverrideSkeleton;
}

// =================================================================
// LOAD OVERRIDES
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
  
  window.currentOverrides = currentOverrides;
}

function saveOverrides() {
  const dailyData = window.loadCurrentDailyData?.() || {};
  dailyData.overrides = JSON.parse(JSON.stringify(currentOverrides));
  window.saveCurrentDailyData?.("overrides", dailyData.overrides);
  window.currentOverrides = currentOverrides;
}

// =================================================================
// REFRESH FROM CLOUD (Fix #45, #46)
// =================================================================
function refreshFromCloud() {
  masterSettings.global = window.loadGlobalSettings?.() || {};
  masterSettings.app1 = masterSettings.global.app1 || {};
  masterSettings.leaguesByName = masterSettings.global.leaguesByName || {};
  masterSettings.specialtyLeagues = masterSettings.global.specialtyLeagues || {};
  
  // Fix #46 — update global division state
  if (masterSettings.app1.divisions) {
    window.divisions = masterSettings.app1.divisions;
  }
  if (masterSettings.app1.availableDivisions) {
    window.availableDivisions = masterSettings.app1.availableDivisions;
  }
  if (masterSettings.app1.divisionTimes) {
    window.divisionTimes = masterSettings.app1.divisionTimes;
  }
  
  // Fix #45 — invalidate localStorage skeleton cache so cloud data takes priority
  try {
    const dateKey = window.currentScheduleDate;
    if (dateKey) {
      localStorage.removeItem(`campManualSkeleton_${dateKey}`);
    }
  } catch (e) { /* ignore */ }
  
  loadDailySkeleton();
  loadCurrentOverrides();
  renderGrid();
  renderResourceOverridesUI();
}

// =================================================================
// REGISTER EXISTING SCHEDULES (Fix #43 — type coercion)
// =================================================================
function registerExistingSchedules() {
  const schedules = window.scheduleAssignments || {};
  const bunks = window.availableBunks || [];
  
  Object.keys(schedules).forEach(bunkKey => {
    // Fix #43 — use loose equality to handle number/string bunk IDs
    const matchedBunk = bunks.find(b => String(b.id) === String(bunkKey) || String(b.name) === String(bunkKey));
    if (!matchedBunk) return;
    
    const bunkSchedule = schedules[bunkKey];
    if (!bunkSchedule || typeof bunkSchedule !== 'object') return;
    
    Object.keys(bunkSchedule).forEach(slotIdx => {
      const assignment = bunkSchedule[slotIdx];
      if (!assignment) return;
      // Register for conflict tracking
      if (window.GlobalFieldLocks?.registerAssignment) {
        window.GlobalFieldLocks.registerAssignment(assignment.field, matchedBunk.division, slotIdx);
      }
    });
  });
}

// =================================================================
// RUN OPTIMIZER (Fix #3 — async)
// =================================================================
async function runOptimizer() {
  if (!window.AccessControl?.checkEditAccess?.('run optimizer')) return;
  if (!window.runSkeletonOptimizer) { await showAlert("Error: 'runSkeletonOptimizer' not found."); return; }
  if (dailyOverrideSkeleton.length === 0) { await showAlert("Skeleton is empty."); return; }
  saveDailySkeleton();
  const success = window.runSkeletonOptimizer(dailyOverrideSkeleton, currentOverrides);
  if (success) { await showAlert("Schedule Generated!"); window.showTab?.('schedule'); }
  else { await showAlert("Error. Check console."); }
}

// =================================================================
// RENDER SUBTABS
// =================================================================
function setupSubTabs() {
  const tabs = container.querySelectorAll('.da-subtab');
  tabs.forEach(tab => {
    tab.onclick = () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      container.querySelectorAll('.da-pane').forEach(p => p.classList.remove('active'));
      const tabId = tab.dataset.tab;
      const pane = container.querySelector(`#da-pane-${tabId}`);
      if (pane) pane.classList.add('active');
      
      activeSubTab = tabId;
    };
  });
}

// =================================================================
// RENDER TOOLBAR (Fix #3 — async save/load/clear, Fix #20 — clear displaced)
// =================================================================
function renderToolbar() {
  const toolbar = document.getElementById('da-skeleton-toolbar');
  if (!toolbar) return;
  
  const g = window.loadGlobalSettings?.() || {};
  const savedSkeletons = g.app1?.savedSkeletons || {};
  const templateNames = Object.keys(savedSkeletons).sort();
  
  const optionsHtml = templateNames.map(name =>
    `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`
  ).join('');
  
  toolbar.innerHTML = `
    <div class="da-toolbar-row">
      <button id="da-generate-btn" class="da-btn da-btn-primary">▶ Generate Schedule</button>
      <div class="da-toolbar-divider"></div>
      <input type="text" id="da-save-name" class="da-input" placeholder="Template name..." style="width:160px;">
      <button id="da-save-btn" class="da-btn da-btn-secondary">💾 Save</button>
      <select id="da-load-select" class="da-select" style="width:160px;">
        <option value="">Load template...</option>
        ${optionsHtml}
      </select>
      <button id="da-clear-btn" class="da-btn da-btn-ghost">🗑️ Clear</button>
    </div>
  `;
  
  // Generate
  document.getElementById('da-generate-btn').onclick = () => runOptimizer();
  
  // Save
  document.getElementById('da-save-btn').onclick = async () => {
    const nameEl = document.getElementById('da-save-name');
    const name = nameEl.value.trim();
    if (!name) { await showAlert("Please enter a template name."); return; }
    if (!window.AccessControl?.checkEditAccess?.('save skeleton template')) return;
    
    if (!masterSettings.app1.savedSkeletons) masterSettings.app1.savedSkeletons = {};
    masterSettings.app1.savedSkeletons[name] = JSON.parse(JSON.stringify(dailyOverrideSkeleton));
    window.saveGlobalSettings?.("app1", masterSettings.app1);
    await showAlert("Template \"" + name + "\" saved!");
    nameEl.value = '';
    renderToolbar();
  };
  
  // Load (Fix #3 — async confirm)
  document.getElementById('da-load-select').onchange = async function() {
    const name = this.value;
    if (name && savedSkeletons[name] && await showConfirm('Load "' + name + '"?')) {
      dailyOverrideSkeleton = JSON.parse(JSON.stringify(savedSkeletons[name]));
      saveDailySkeleton();
      renderGrid();
    }
    this.value = '';
  };
  
  // Clear (Fix #3 — async confirm, Fix #20 — clear displaced)
  document.getElementById('da-clear-btn').onclick = async () => {
    if (await showConfirm('Clear all blocks?')) {
      dailyOverrideSkeleton = [];
      clearDisplacedTiles();
      saveDailySkeleton();
      renderGrid();
    }
  };
}

// =================================================================
// RENDER TRIPS FORM (Fix #3 — async, Fix #37 — no stale loadDailySkeleton)
// =================================================================
function renderTripsForm() {
  const section = document.getElementById('da-trips-container');
  if (!section) return;
  
  const divisions = window.availableDivisions || [];
  const divOptions = divisions.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
  
  section.innerHTML = `
    <div class="da-card">
      <h3 class="da-card-title">🚌 Add Trip / Special Event</h3>
      <p class="da-card-desc">Trips erase overlapping tiles and pin a fixed block for the division.</p>
      
      <div class="da-form-grid">
        <div class="da-form-field">
          <label>Division</label>
          <select id="da-trip-division" class="da-select">${divOptions}</select>
        </div>
        <div class="da-form-field">
          <label>Trip / Event Name</label>
          <input type="text" id="da-trip-name" class="da-input" placeholder="e.g., Museum Trip">
        </div>
        <div class="da-form-field">
          <label>Start Time</label>
          <input type="text" id="da-trip-start" class="da-input" placeholder="e.g., 9:00am">
        </div>
        <div class="da-form-field">
          <label>End Time</label>
          <input type="text" id="da-trip-end" class="da-input" placeholder="e.g., 2:00pm">
        </div>
      </div>
      
      <button id="da-apply-trip-btn" class="da-btn da-btn-primary" style="margin-top:16px;">🚌 Add Trip</button>
    </div>
    <div id="da-displaced-tiles-panel"></div>
  `;
  
  // Fix #3 — async, Fix #37 — removed stale loadDailySkeleton() call
  document.getElementById("da-apply-trip-btn").onclick = async () => {
    const division = document.getElementById("da-trip-division").value;
    const tripName = document.getElementById("da-trip-name").value.trim();
    const startTime = document.getElementById("da-trip-start").value.trim();
    const endTime = document.getElementById("da-trip-end").value.trim();
    
    if (!division || !tripName || !startTime || !endTime) { await showAlert("Complete all fields."); return; }
    const startMin = parseTimeToMinutes(startTime);
    const endMin = parseTimeToMinutes(endTime);
    if (startMin == null || endMin == null) { await showAlert("Invalid time."); return; }
    if (endMin <= startMin) { await showAlert("End must be after start."); return; }
    
    const newEvent = { id: 'trip_' + uid(), type: "pinned", event: tripName, division, startTime, endTime, reservedFields: [] };
    eraseOverlappingTiles(newEvent, division, 'Erased by trip: ' + tripName);
    dailyOverrideSkeleton.push(newEvent);
    saveDailySkeleton();
    renderGrid();
    
    document.querySelector('.da-subtab[data-tab="skeleton"]')?.click();
    await showAlert("Trip added!");
  };
  
  renderDisplacedTilesPanel();
}

// =================================================================
// RENDER BUNK OVERRIDES UI (Fix #34 — field type)
// =================================================================
function renderBunkOverridesUI() {
  const section = document.getElementById('da-bunk-overrides-container');
  if (!section) return;
  
  const divisions = window.availableDivisions || [];
  const allFields = (masterSettings.app1?.fields || []);
  const allSpecials = (masterSettings.app1?.specialActivities || []);
  
  // Build activity options grouped by type
  let activityOptions = '<option value="">Select activity...</option>';
  activityOptions += '<optgroup label="Sports (by field)">';
  allFields.forEach(f => {
    (f.activities || []).forEach(act => {
      activityOptions += `<option value="${escapeHtml(act)}" data-type="sport" data-field="${escapeHtml(f.name)}">${escapeHtml(act)} (${escapeHtml(f.name)})</option>`;
    });
  });
  activityOptions += '</optgroup>';
  activityOptions += '<optgroup label="Special Activities">';
  allSpecials.forEach(s => {
    activityOptions += `<option value="${escapeHtml(s.name)}" data-type="special">${escapeHtml(s.name)}</option>`;
  });
  activityOptions += '</optgroup>';
  activityOptions += '<optgroup label="Fields (Location Lock)">';
  allFields.forEach(f => {
    activityOptions += `<option value="${escapeHtml(f.name)}" data-type="field">${escapeHtml(f.name)} (Full Field)</option>`;
  });
  activityOptions += '</optgroup>';
  activityOptions += '<optgroup label="Fixed Events">';
  ['Swim','Lunch','Snacks','Dismissal'].forEach(name => {
    activityOptions += `<option value="${escapeHtml(name)}" data-type="pinned">${escapeHtml(name)}</option>`;
  });
  activityOptions += '</optgroup>';
  
  // Bunk checkboxes
  let bunkCheckboxes = '';
  divisions.forEach(divName => {
    const divBunks = (window.availableBunks || []).filter(b => b.division === divName);
    if (divBunks.length === 0) return;
    bunkCheckboxes += `<div class="da-bunk-group"><strong>${escapeHtml(divName)}</strong><div class="da-bunk-checks">`;
    divBunks.forEach(bunk => {
      bunkCheckboxes += `<label class="da-check-label"><input type="checkbox" class="da-bunk-check" value="${escapeHtml(bunk.name)}" data-division="${escapeHtml(divName)}"> ${escapeHtml(bunk.name)}</label>`;
    });
    bunkCheckboxes += `</div></div>`;
  });
  
  // Existing overrides list
  const existingOverrides = currentOverrides.bunkActivityOverrides || [];
  let overridesList = '';
  if (existingOverrides.length > 0) {
    overridesList = `<div class="da-overrides-list"><h4>Active Overrides (${existingOverrides.length})</h4>`;
    existingOverrides.forEach((ov, idx) => {
      overridesList += `
        <div class="da-override-item ${selectedOverrideId === idx ? 'selected' : ''}" data-idx="${idx}">
          <div class="da-override-info">
            <strong>${escapeHtml(ov.activity)}</strong>
            <span>${escapeHtml(ov.startTime)} - ${escapeHtml(ov.endTime)}</span>
            <span class="da-override-bunks">${(ov.bunks || []).map(b => escapeHtml(b)).join(', ')}</span>
          </div>
          <button class="da-btn da-btn-ghost da-btn-sm da-remove-override" data-idx="${idx}">✕</button>
        </div>
      `;
    });
    overridesList += '</div>';
  }
  
  section.innerHTML = `
    <div class="da-card">
      <h3 class="da-card-title">🔧 Bunk Activity Overrides</h3>
      <p class="da-card-desc">Force specific bunks to do a particular activity at a set time. Overrides the scheduler's auto-assignment.</p>
      
      <div class="da-form-grid">
        <div class="da-form-field">
          <label>Activity</label>
          <select id="da-bunk-override-activity" class="da-select">${activityOptions}</select>
        </div>
        <div class="da-form-field">
          <label>Start Time</label>
          <input type="text" id="da-bunk-override-start" class="da-input" placeholder="e.g., 9:00am">
        </div>
        <div class="da-form-field">
          <label>End Time</label>
          <input type="text" id="da-bunk-override-end" class="da-input" placeholder="e.g., 10:00am">
        </div>
      </div>
      
      <div class="da-form-field" style="margin-top:12px;">
        <label>Select Bunks</label>
        ${bunkCheckboxes}
      </div>
      
      <button id="da-add-override-btn" class="da-btn da-btn-primary" style="margin-top:16px;">➕ Add Override</button>
    </div>
    ${overridesList}
  `;
  
  // Fix #3 — async handler, Fix #34 — field type → pinned
  document.getElementById('da-add-override-btn').onclick = async () => {
    const activityEl = document.getElementById('da-bunk-override-activity');
    const startEl = document.getElementById('da-bunk-override-start');
    const endEl = document.getElementById('da-bunk-override-end');
    const activity = activityEl.value;
    const selectedOption = activityEl.options[activityEl.selectedIndex];
    const activityType = selectedOption?.dataset?.type || 'special';
    
    const selectedBunks = [];
    document.querySelectorAll('.da-bunk-check:checked').forEach(cb => {
      selectedBunks.push(cb.value);
    });
    
    if (!activity) { await showAlert('Please select an activity.'); return; }
    if (!startEl.value || !endEl.value) { await showAlert('Please enter a start and end time.'); return; }
    if (selectedBunks.length === 0) { await showAlert('Please select at least one bunk.'); return; }
    
    const startMin = parseTimeToMinutes(startEl.value);
    const endMin = parseTimeToMinutes(endEl.value);
    
    if (startMin == null || endMin == null || endMin <= startMin) {
      await showAlert('Invalid time range.');
      return;
    }
    
    // Fix #34 — field type maps to 'pinned', not fall-through to 'special'
    let type = 'special';
    if (activityType === 'pinned' || activityType === 'facility') {
      type = 'pinned';
    } else if (activityType === 'field') {
      type = 'pinned'; // Fields are location-based, need pinned/lock behavior
    } else if (activityType === 'sport') {
      type = 'sport';
    }
    
    const override = {
      id: uid(),
      activity,
      type,
      field: selectedOption?.dataset?.field || null,
      startTime: startEl.value.trim(),
      endTime: endEl.value.trim(),
      bunks: selectedBunks
    };
    
    currentOverrides.bunkActivityOverrides.push(override);
    saveOverrides();
    renderBunkOverridesUI();
  };
  
  // Remove override buttons
  section.querySelectorAll('.da-remove-override').forEach(btn => {
    btn.onclick = async () => {
      const idx = parseInt(btn.dataset.idx, 10);
      if (await showConfirm('Remove this override?')) {
        currentOverrides.bunkActivityOverrides.splice(idx, 1);
        saveOverrides();
        renderBunkOverridesUI();
      }
    };
  });
}

// =================================================================
// RENDER RESOURCE OVERRIDES UI
// =================================================================
function renderResourceOverridesUI() {
  const section = document.getElementById('da-resources-container');
  if (!section) return;
  
  const allFields = (masterSettings.app1?.fields || []);
  const allSpecials = (masterSettings.app1?.specialActivities || []);
  const disabledFields = currentOverrides.disabledFields || [];
  const disabledSpecials = currentOverrides.disabledSpecials || [];
  const isRainy = isRainyDayActive();
  
  let fieldsHtml = '<div class="da-toggle-grid">';
  allFields.forEach(field => {
    const isDisabled = disabledFields.includes(field.name);
    const isOutdoor = field.rainyDayAvailable !== true;
    const rainyLocked = isRainy && isOutdoor && isDisabled;
    
    fieldsHtml += `
      <div class="da-toggle-item ${isDisabled ? 'disabled' : ''}">
        <label class="da-toggle-label">
          <input type="checkbox" class="da-field-toggle" value="${escapeHtml(field.name)}" 
                 ${isDisabled ? '' : 'checked'} ${rainyLocked ? 'disabled title="Disabled by rainy day mode"' : ''}>
          <span>${escapeHtml(field.name)}</span>
          ${rainyLocked ? '<span class="da-rainy-lock">🌧️</span>' : ''}
          ${field.rainyDayAvailable === true ? '<span class="da-indoor-badge">🏠</span>' : ''}
        </label>
      </div>
    `;
  });
  fieldsHtml += '</div>';
  
  let specialsHtml = '<div class="da-toggle-grid">';
  allSpecials.forEach(special => {
    const isDisabled = disabledSpecials.includes(special.name);
    const isRainyOnly = special.rainyDayOnly === true;
    
    specialsHtml += `
      <div class="da-toggle-item ${isDisabled ? 'disabled' : ''}">
        <label class="da-toggle-label">
          <input type="checkbox" class="da-special-toggle" value="${escapeHtml(special.name)}" ${isDisabled ? '' : 'checked'}>
          <span>${escapeHtml(special.name)}</span>
          ${isRainyOnly ? '<span class="da-rainy-badge">🌧️ Only</span>' : ''}
          ${special.isOutdoor ? '<span class="da-outdoor-badge">🌳</span>' : '<span class="da-indoor-badge">🏠</span>'}
        </label>
      </div>
    `;
  });
  specialsHtml += '</div>';
  
  // Per-field sport disabling
  let sportTogglesHtml = '';
  allFields.forEach(field => {
    if (!field.activities || field.activities.length === 0) return;
    const disabledSports = (currentOverrides.dailyDisabledSportsByField || {})[field.name] || [];
    
    sportTogglesHtml += `<div class="da-sport-field-group"><strong>${escapeHtml(field.name)}</strong><div class="da-sport-checks">`;
    field.activities.forEach(sport => {
      const isOff = disabledSports.includes(sport);
      sportTogglesHtml += `
        <label class="da-check-label">
          <input type="checkbox" class="da-sport-toggle" data-field="${escapeHtml(field.name)}" value="${escapeHtml(sport)}" ${isOff ? '' : 'checked'}>
          ${escapeHtml(sport)}
        </label>
      `;
    });
    sportTogglesHtml += '</div></div>';
  });
  
  section.innerHTML = `
    <div class="da-card">
      <h3 class="da-card-title">🏟️ Field Availability</h3>
      <p class="da-card-desc">Toggle fields on/off for today's schedule. Disabled fields won't be assigned.</p>
      ${fieldsHtml}
    </div>
    
    <div class="da-card">
      <h3 class="da-card-title">🎨 Special Activities</h3>
      <p class="da-card-desc">Toggle special activities on/off for today.</p>
      ${specialsHtml}
    </div>
    
    ${sportTogglesHtml ? `
    <div class="da-card">
      <h3 class="da-card-title">⚽ Per-Field Sport Availability</h3>
      <p class="da-card-desc">Disable specific sports on specific fields for today.</p>
      ${sportTogglesHtml}
    </div>
    ` : ''}
  `;
  
  // Field toggles
  section.querySelectorAll('.da-field-toggle').forEach(toggle => {
    toggle.onchange = function() {
      const fieldName = this.value;
      if (this.checked) {
        currentOverrides.disabledFields = currentOverrides.disabledFields.filter(f => f !== fieldName);
      } else {
        if (!currentOverrides.disabledFields.includes(fieldName)) {
          currentOverrides.disabledFields.push(fieldName);
        }
      }
      saveOverrides();
    };
  });
  
  // Special toggles
  section.querySelectorAll('.da-special-toggle').forEach(toggle => {
    toggle.onchange = function() {
      const specialName = this.value;
      if (this.checked) {
        currentOverrides.disabledSpecials = currentOverrides.disabledSpecials.filter(s => s !== specialName);
      } else {
        if (!currentOverrides.disabledSpecials.includes(specialName)) {
          currentOverrides.disabledSpecials.push(specialName);
        }
      }
      saveOverrides();
    };
  });
  
  // Sport toggles
  section.querySelectorAll('.da-sport-toggle').forEach(toggle => {
    toggle.onchange = function() {
      const fieldName = this.dataset.field;
      const sportName = this.value;
      if (!currentOverrides.dailyDisabledSportsByField) currentOverrides.dailyDisabledSportsByField = {};
      if (!currentOverrides.dailyDisabledSportsByField[fieldName]) currentOverrides.dailyDisabledSportsByField[fieldName] = [];
      
      if (this.checked) {
        currentOverrides.dailyDisabledSportsByField[fieldName] =
          currentOverrides.dailyDisabledSportsByField[fieldName].filter(s => s !== sportName);
      } else {
        if (!currentOverrides.dailyDisabledSportsByField[fieldName].includes(sportName)) {
          currentOverrides.dailyDisabledSportsByField[fieldName].push(sportName);
        }
      }
      saveOverrides();
    };
  });
}


// =================================================================
// CSS STYLES
// =================================================================
function getStyles() {
  return `<style>
    /* ============ Modal System ============ */
    .da-modal-overlay {
      position:fixed;top:0;left:0;right:0;bottom:0;
      background:rgba(0,0,0,0.5);z-index:10000;
      display:flex;align-items:center;justify-content:center;
      animation:daFadeIn 0.15s ease;
    }
    .da-modal {
      background:#fff;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,0.3);
      width:90%;overflow:hidden;animation:daSlideUp 0.2s ease;
    }
    .da-modal-header {
      display:flex;justify-content:space-between;align-items:center;
      padding:16px 20px;border-bottom:1px solid #e2e8f0;
    }
    .da-modal-header h3 { margin:0;font-size:16px;color:#1e293b; }
    .da-modal-close {
      background:none;border:none;font-size:20px;color:#94a3b8;cursor:pointer;padding:4px 8px;border-radius:4px;
    }
    .da-modal-close:hover { background:#f1f5f9;color:#475569; }
    .da-modal-body { padding:20px; }
    .da-modal-footer {
      display:flex;justify-content:flex-end;gap:8px;
      padding:16px 20px;border-top:1px solid #e2e8f0;
    }
    @keyframes daFadeIn { from{opacity:0} to{opacity:1} }
    @keyframes daSlideUp { from{transform:translateY(20px);opacity:0} to{transform:translateY(0);opacity:1} }
    
    /* ============ Buttons ============ */
    .da-btn {
      display:inline-flex;align-items:center;gap:6px;
      padding:8px 16px;border-radius:6px;font-size:13px;font-weight:500;
      border:none;cursor:pointer;transition:all 0.15s;
    }
    .da-btn:hover { filter:brightness(0.95); }
    .da-btn-primary { background:#3b82f6;color:#fff; }
    .da-btn-primary:hover { background:#2563eb; }
    .da-btn-secondary { background:#e2e8f0;color:#475569; }
    .da-btn-secondary:hover { background:#cbd5e1; }
    .da-btn-ghost { background:transparent;color:#64748b; }
    .da-btn-ghost:hover { background:#f1f5f9; }
    .da-btn-warning { background:#f59e0b;color:#fff; }
    .da-btn-warning:hover { background:#d97706; }
    .da-btn-sm { padding:4px 10px;font-size:12px; }
    
    /* ============ Form Elements ============ */
    .da-input, .da-select {
      padding:8px 12px;border:1px solid #d1d5db;border-radius:6px;
      font-size:13px;color:#1e293b;background:#fff;
      transition:border-color 0.15s;
    }
    .da-input:focus, .da-select:focus { outline:none;border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,0.1); }
    .da-form-grid { display:grid;grid-template-columns:1fr 1fr;gap:12px; }
    .da-form-field label { display:block;font-size:12px;font-weight:600;color:#475569;margin-bottom:4px; }
    
    /* ============ Cards ============ */
    .da-card {
      background:#fff;border:1px solid #e2e8f0;border-radius:10px;
      padding:20px;margin-bottom:16px;
    }
    .da-card-title { font-size:16px;font-weight:600;color:#1e293b;margin:0 0 4px; }
    .da-card-desc { font-size:13px;color:#64748b;margin:0 0 16px; }
    
    /* ============ Grid ============ */
    .da-grid {
      display:grid;position:relative;gap:0;
      border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;
    }
    .da-grid-header {
      padding:8px 12px;font-size:12px;font-weight:600;text-align:center;
      border-bottom:2px solid #e2e8f0;
    }
    .da-time-header { background:#f8fafc;color:#64748b; }
    .da-grid-cell {
      position:relative;border-left:1px solid #f1f5f9;
      background:repeating-linear-gradient(to bottom, transparent 0px, transparent ${PIXELS_PER_MINUTE * INCREMENT_MINS - 1}px, #f1f5f9 ${PIXELS_PER_MINUTE * INCREMENT_MINS - 1}px, #f1f5f9 ${PIXELS_PER_MINUTE * INCREMENT_MINS}px);
    }
    .da-grid-disabled {
      position:absolute;left:0;right:0;
      background:repeating-linear-gradient(45deg, #f8fafc, #f8fafc 4px, #f1f5f9 4px, #f1f5f9 8px);
      opacity:0.7;z-index:1;pointer-events:none;
    }
    .da-grid-night-zone { background:linear-gradient(to bottom, rgba(15,23,42,0.05), rgba(15,23,42,0.15)); }
    .da-time-column { position:relative;background:#f8fafc;border-right:1px solid #e2e8f0; }
    .da-time-marker {
      position:absolute;right:4px;font-size:10px;color:#94a3b8;
      transform:translateY(-50%);white-space:nowrap;
    }
    
    /* ============ Event Tiles ============ */
    .da-event {
      position:absolute;left:3px;right:3px;border-radius:5px;
      overflow:hidden;cursor:grab;z-index:5;
      box-shadow:0 1px 3px rgba(0,0,0,0.1);
      transition:box-shadow 0.15s, outline 0.15s;
    }
    .da-event:hover { box-shadow:0 2px 8px rgba(0,0,0,0.15);z-index:6; }
    .da-event.selected { outline:2px solid #3b82f6;outline-offset:1px;z-index:7; }
    .da-event.da-night-activity { box-shadow:0 0 8px rgba(233,69,96,0.4); }
    .da-event.da-conflict-warn { outline:2px solid #ef4444;outline-offset:1px; }
    .da-event.da-conflict-notice { outline:2px solid #f59e0b;outline-offset:1px; }
    .da-event.da-resizing { opacity:0.8;cursor:ns-resize; }
    
    /* ============ Resize Handles ============ */
    .da-resize-handle {
      position:absolute;left:0;right:0;height:6px;cursor:ns-resize;z-index:10;
    }
    .da-resize-top { top:0; }
    .da-resize-bottom { bottom:0; }
    .da-resize-handle:hover { background:rgba(59,130,246,0.3); }
    
    /* ============ Drag Preview ============ */
    .da-drop-preview {
      display:none;position:absolute;left:3px;right:3px;
      background:rgba(59,130,246,0.15);border:2px dashed #3b82f6;
      border-radius:5px;z-index:4;pointer-events:none;
    }
    .da-preview-time {
      font-size:10px;color:#3b82f6;font-weight:600;
      text-align:center;padding:4px;
    }
    #da-drag-ghost {
      display:none;position:fixed;background:#1e293b;color:#fff;
      padding:6px 12px;border-radius:6px;font-size:11px;
      box-shadow:0 4px 12px rgba(0,0,0,0.2);z-index:10001;
      pointer-events:none;
    }
    #da-resize-tooltip {
      display:none;position:fixed;background:#1e293b;color:#fff;
      padding:4px 10px;border-radius:4px;font-size:11px;
      z-index:10001;pointer-events:none;white-space:nowrap;
    }
    
    /* ============ Palette ============ */
    .da-tile {
      padding:6px 12px;border-radius:6px;font-size:12px;font-weight:500;
      cursor:grab;text-align:center;user-select:none;
      transition:transform 0.1s, box-shadow 0.1s;
    }
    .da-tile:hover { transform:translateY(-1px);box-shadow:0 2px 6px rgba(0,0,0,0.15); }
    .da-tile:active { cursor:grabbing; }
    .da-tile-label { font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;margin:8px 0 4px;padding:0 4px; }
    .da-tile-divider { height:1px;background:#e2e8f0;margin:8px 0; }
    
    /* ============ Subtabs ============ */
    .da-subtab {
      padding:8px 16px;border:none;background:transparent;
      font-size:13px;font-weight:500;color:#64748b;cursor:pointer;
      border-bottom:2px solid transparent;transition:all 0.15s;
    }
    .da-subtab:hover { color:#1e293b;background:#f8fafc; }
    .da-subtab.active { color:#3b82f6;border-bottom-color:#3b82f6; }
    
    /* ============ Panes ============ */
    .da-pane { display:none; flex:1; overflow:auto; padding:16px; }
    .da-pane.active { display:block; }
    
    /* ============ Toolbar ============ */
    .da-toolbar { display:flex; align-items:center; gap:12px; padding:12px 16px; background:#f8fafc; border-bottom:1px solid #e2e8f0; flex-wrap:wrap; }
    .da-toolbar-group { display:flex; align-items:center; gap:8px; }
    .da-toolbar-label { font-size:12px; color:#475569; font-weight:500; }
    .da-toolbar-row {
      display:flex;align-items:center;gap:8px;flex-wrap:wrap;
      padding:12px 0;
    }
    .da-toolbar-divider { width:1px;height:24px;background:#e2e8f0; }
    
    /* ============ Rainy Day ============ */
    .da-rainy-dropdown { border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:16px; }
    .da-rainy-dropdown.active { border-color:#3b82f6; }
    .da-rainy-dropdown-header {
      display:flex;justify-content:space-between;align-items:center;
      padding:12px 16px;cursor:pointer;background:#f8fafc;
    }
    .da-rainy-dropdown-header:hover { background:#f1f5f9; }
    .da-rainy-dropdown-title { display:flex;align-items:center;gap:8px;font-weight:500; }
    .da-rainy-dropdown-icon { font-size:18px; }
    .da-rainy-dropdown-arrow { color:#94a3b8;font-size:12px; }
    .da-rainy-active-badge {
      font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;
      background:#dbeafe;color:#1d4ed8;
    }
    .da-rainy-card { position:relative;overflow:hidden;padding:20px; }
    .da-rainy-card.active { background:linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%); }
    .da-rainy-card.inactive { background:#f8fafc; }
    .da-rain-container { position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;overflow:hidden; }
    .da-rain-drop {
      position:absolute;top:-20px;width:2px;background:linear-gradient(to bottom, transparent, #93c5fd);
      border-radius:1px;animation:daRainFall linear infinite;opacity:0.4;
    }
    @keyframes daRainFall { 0%{transform:translateY(-20px)} 100%{transform:translateY(200px)} }
    .da-rainy-header { display:flex;justify-content:space-between;align-items:flex-start;position:relative;z-index:1; }
    .da-rainy-title-section { display:flex;gap:12px;align-items:flex-start; }
    .da-rainy-icon { font-size:28px; }
    .da-rainy-title { font-size:16px;font-weight:600;color:#1e293b;margin:0; }
    .da-rainy-subtitle { font-size:12px;color:#64748b;margin:4px 0 0; }
    
    /* Toggle */
    .da-rainy-toggle { position:relative;display:inline-block;width:56px;height:28px;cursor:pointer; }
    .da-rainy-toggle input { opacity:0;width:0;height:0; }
    .da-rainy-toggle-track {
      position:absolute;inset:0;background:#cbd5e1;border-radius:14px;
      transition:background 0.3s;overflow:hidden;
    }
    .da-rainy-toggle input:checked + .da-rainy-toggle-track { background:#3b82f6; }
    .da-rainy-toggle-thumb {
      position:absolute;top:2px;left:2px;width:24px;height:24px;
      background:#fff;border-radius:50%;transition:transform 0.3s;
      box-shadow:0 1px 3px rgba(0,0,0,0.2);z-index:1;
    }
    .da-rainy-toggle input:checked ~ .da-rainy-toggle-thumb { transform:translateX(28px); }
    .da-rainy-toggle-label-off, .da-rainy-toggle-label-on {
      position:absolute;top:50%;transform:translateY(-50%);
      font-size:9px;font-weight:700;color:#fff;
    }
    .da-rainy-toggle-label-off { right:6px; }
    .da-rainy-toggle-label-on { left:6px; }
    
    /* Stats */
    .da-rainy-stats {
      display:flex;gap:12px;margin-top:16px;position:relative;z-index:1;flex-wrap:wrap;
    }
    .da-rainy-stat {
      display:flex;flex-direction:column;align-items:center;gap:2px;
      padding:8px 12px;border-radius:8px;background:rgba(255,255,255,0.7);
      font-size:11px;color:#475569;min-width:70px;
    }
    .da-rainy-stat strong { font-size:18px;color:#1e293b; }
    .da-rainy-stat.available { background:rgba(209,250,229,0.7); }
    .da-rainy-stat.disabled { background:rgba(254,226,226,0.7); }
    .da-rainy-stat.highlight { background:rgba(219,234,254,0.7); }
    
    /* Mid-day badges */
    .da-rainy-midday-info { display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;position:relative;z-index:1; }
    .da-rainy-midday-badge, .da-rainy-preserved-badge, .da-rainy-cutshort-badge, .da-rainy-cleared-badge {
      font-size:11px;font-weight:600;padding:4px 10px;border-radius:12px;
    }
    .da-rainy-midday-badge { background:#dbeafe;color:#1d4ed8; }
    .da-rainy-preserved-badge { background:#d1fae5;color:#065f46; }
    .da-rainy-cutshort-badge { background:#fef3c7;color:#92400e; }
    .da-rainy-cleared-badge { background:#fee2e2;color:#991b1b; }
    
    /* Settings */
    .da-rainy-settings-btn {
      background:none;border:none;font-size:12px;color:#64748b;cursor:pointer;
      padding:4px 8px;border-radius:4px;position:relative;z-index:1;
    }
    .da-rainy-settings-btn:hover { background:rgba(0,0,0,0.05); }
    .da-rainy-settings-panel { padding:12px 0 0;position:relative;z-index:1; }
    .da-rainy-settings-row {
      display:flex;justify-content:space-between;align-items:center;
      padding:8px 0;border-top:1px solid rgba(0,0,0,0.06);
    }
    .da-rainy-settings-label { font-size:13px;font-weight:500;color:#1e293b; }
    .da-rainy-settings-sublabel { font-size:11px;color:#94a3b8; }
    .da-rainy-settings-toggle { text-align:center;margin-top:8px;position:relative;z-index:1; }
    
    /* Mini toggle */
    .da-mini-toggle { position:relative;display:inline-block;width:36px;height:20px;cursor:pointer; }
    .da-mini-toggle input { opacity:0;width:0;height:0; }
    .da-mini-track {
      position:absolute;inset:0;background:#cbd5e1;border-radius:10px;transition:background 0.3s;
    }
    .da-mini-toggle input:checked + .da-mini-track { background:#3b82f6; }
    .da-mini-thumb {
      position:absolute;top:2px;left:2px;width:16px;height:16px;
      background:#fff;border-radius:50%;transition:transform 0.3s;
      box-shadow:0 1px 2px rgba(0,0,0,0.2);
    }
    .da-mini-toggle input:checked ~ .da-mini-thumb { transform:translateX(16px); }
    
    /* ============ Notifications ============ */
    .da-notif {
      position:fixed;top:20px;right:20px;z-index:10001;
      display:flex;align-items:center;gap:12px;
      padding:14px 20px;border-radius:12px;
      box-shadow:0 10px 30px rgba(0,0,0,0.15);
      transform:translateX(120%);transition:transform 0.3s ease;
    }
    .da-notif.show { transform:translateX(0); }
    .da-notif-rainy { background:linear-gradient(135deg, #1e40af, #3b82f6);color:#fff; }
    .da-notif-sunny { background:linear-gradient(135deg, #f59e0b, #fbbf24);color:#78350f; }
    .da-notif-icon { font-size:24px; }
    .da-notif-title { font-weight:600;font-size:14px; }
    .da-notif-subtitle { font-size:12px;opacity:0.85; }
    
    /* ============ Toggle Grids ============ */
    .da-toggle-grid { display:grid;grid-template-columns:repeat(auto-fill, minmax(180px, 1fr));gap:8px; }
    .da-toggle-item { padding:6px 10px;border-radius:6px;border:1px solid #e2e8f0; }
    .da-toggle-item.disabled { background:#fef2f2;border-color:#fecaca; }
    .da-toggle-label { display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer; }
    .da-indoor-badge, .da-outdoor-badge, .da-rainy-badge, .da-rainy-lock {
      font-size:10px;margin-left:auto;
    }
    
    /* ============ Bunk Overrides ============ */
    .da-bunk-group { margin-bottom:12px; }
    .da-bunk-checks { display:flex;flex-wrap:wrap;gap:8px;margin-top:4px; }
    .da-check-label { display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer; }
    .da-overrides-list { margin-top:16px; }
    .da-override-item {
      display:flex;justify-content:space-between;align-items:center;
      padding:10px 12px;border:1px solid #e2e8f0;border-radius:6px;margin-bottom:6px;
    }
    .da-override-item.selected { border-color:#3b82f6;background:#eff6ff; }
    .da-override-info { display:flex;flex-direction:column;gap:2px; }
    .da-override-bunks { font-size:11px;color:#64748b; }
    
    /* ============ Detail Pane ============ */
    .da-detail-empty { text-align:center;color:#94a3b8;padding:40px 20px;font-size:13px; }
    .da-detail-card { background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px; }
    .da-detail-card h4 { margin:0 0 10px;font-size:14px;color:#1e293b; }
    .da-detail-row { display:flex;justify-content:space-between;font-size:12px;color:#475569;padding:3px 0; }
    .da-detail-section { margin-top:10px;padding-top:10px;border-top:1px solid #e2e8f0; }
    .da-detail-actions { display:flex;gap:8px;margin-top:12px;justify-content:flex-end; }
    
    /* Time rules */
    .da-rules-list { margin-top:8px; }
    .da-rule-item {
      display:flex;justify-content:space-between;align-items:center;
      padding:4px 8px;background:#fff;border:1px solid #e2e8f0;
      border-radius:4px;margin-bottom:4px;font-size:12px;
    }
    
    /* ============ Displaced Tiles ============ */
    .da-displaced-panel { background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:12px;margin-top:12px; }
    .da-displaced-header { display:flex;justify-content:space-between;align-items:center;margin-bottom:8px; }
    .da-displaced-item { font-size:12px;color:#92400e;padding:4px 0;border-bottom:1px solid #fde68a; }
    .da-displaced-item:last-child { border-bottom:none; }
    
    /* ============ Empty State ============ */
    .da-empty-state {
      text-align:center;padding:60px 20px;color:#94a3b8;
      font-size:14px;background:#f8fafc;border-radius:8px;
    }
    
    /* ============ Sport field groups ============ */
    .da-sport-field-group { margin-bottom:12px; }
    .da-sport-checks { display:flex;flex-wrap:wrap;gap:8px;margin-top:4px; }
  </style>`;
}

// =================================================================
// MAIN HTML TEMPLATE
// =================================================================
function getMainHTML() {
  return `
    <div class="da-container">
      <div class="da-sidebar">
        <div class="da-sidebar-header"><h3>Tile Types</h3></div>
        <div id="da-palette" class="da-palette"></div>
      </div>
      
      <div class="da-main">
        <div class="da-subtabs">
          <button class="da-subtab active" data-tab="skeleton">Schedule</button>
          <button class="da-subtab" data-tab="trips">Trips</button>
          <button class="da-subtab" data-tab="bunk-overrides">Bunk Overrides</button>
          <button class="da-subtab" data-tab="resources">Resources</button>
        </div>
        
        <div id="da-pane-skeleton" class="da-pane active">
          <div id="da-rainy-panel"></div>
          <div id="da-displaced-tiles-panel" style="display:none;"></div>
          <div id="da-skeleton-toolbar" class="da-toolbar"></div>
          <div class="da-grid-wrapper">
            <div id="da-skeleton-grid"></div>
          </div>
        </div>
        
        <div id="da-pane-trips" class="da-pane">
          <div id="da-trips-container"></div>
        </div>
        
        <div id="da-pane-bunk-overrides" class="da-pane">
          <div id="da-bunk-overrides-container"></div>
        </div>
        
        <div id="da-pane-resources" class="da-pane">
          <div id="da-resources-container"></div>
        </div>
      </div>
    </div>
  `;
}

// =================================================================
// KEYBOARD HANDLER (Fix #2 — async showConfirm, Fix #5 — leak prevention)
// =================================================================
function setupKeyboardHandler() {
  if (_keyHandler) document.removeEventListener('keydown', _keyHandler);
  
  // Fix #2 — async keyboard delete handler
  _keyHandler = async (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedTileId) {
      e.preventDefault();
      if (await showConfirm("Delete this block?")) {
        dailyOverrideSkeleton = dailyOverrideSkeleton.filter(x => x.id !== selectedTileId);
        selectedTileId = null;
        saveDailySkeleton();
        renderGrid();
      }
    }
    
    if (e.key === 'Escape' && selectedTileId) {
      selectedTileId = null;
      const gridEl = document.getElementById('da-skeleton-grid');
      if (gridEl) gridEl.querySelectorAll('.da-event').forEach(t => t.classList.remove('selected'));
    }
  };
  document.addEventListener('keydown', _keyHandler);
}

// =================================================================
// VISIBILITY HANDLER
// =================================================================
function setupVisibilityHandler() {
  if (_visHandler) document.removeEventListener('visibilitychange', _visHandler);
  _visHandler = () => {
    if (document.visibilityState === 'visible') {
      refreshFromCloud();
    }
  };
  document.addEventListener('visibilitychange', _visHandler);
}

// =================================================================
// INIT (Fix #5 — keyboard listener leak prevention)
// =================================================================
function init() {
  container = document.getElementById('daily-adjustments-content');
  if (!container) {
    console.error("[DA] Container not found");
    return;
  }
  
  // Load settings
  masterSettings.global = window.loadGlobalSettings?.() || {};
  masterSettings.app1 = masterSettings.global.app1 || {};
  masterSettings.leaguesByName = masterSettings.global.leaguesByName || {};
  masterSettings.specialtyLeagues = masterSettings.global.specialtyLeagues || {};
  smartTileHistory = loadSmartTileHistory();
  
  loadCurrentOverrides();
  
  // Initialize window.isRainyDay from loaded daily data
  const dailyData = window.loadCurrentDailyData?.() || {};
  if (window.isRainyDay === undefined) {
    window.isRainyDay = dailyData.isRainyDay === true || dailyData.rainyDayMode === true;
  }
  console.log("[DailyAdj] Initialized window.isRainyDay =", window.isRainyDay);
  
  container.innerHTML = getStyles() + getMainHTML();
  
  setupSubTabs();
  setupKeyboardHandler();
  setupVisibilityHandler();
  
  loadDailySkeleton();
  registerExistingSchedules();
  
  renderPalette();
  renderRainyDayPanel();
  renderDisplacedTilesPanel();
  renderToolbar();
  renderGrid();
  renderTripsForm();
  renderBunkOverridesUI();
  renderResourceOverridesUI();
  
  console.log("[DA] v6.1 initialized with all bug fixes");
}

// =================================================================
// CLEANUP
// =================================================================
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

// =================================================================
// PUBLIC API
// =================================================================
window.initDailyAdjustments = init;
window.cleanupDailyAdjustments = cleanup;
window.refreshDailyAdjustmentsFromCloud = refreshFromCloud;
window.parseTimeToMinutes = parseTimeToMinutes;
window.minutesToTime = minutesToTime;
window.isRainyDayActive = isRainyDayActive;
window.isMidDayModeActive = isMidDayModeActive;
window.getMidDayStartTime = getMidDayStartTime;
window.refreshSkeletonConflicts = function() { renderGrid(); };
window.renderGrid = renderGrid;
window.saveDailySkeleton = saveDailySkeleton;
window.loadDailySkeleton = loadDailySkeleton;

// Fix #28 — export TILES for MSB to reference instead of maintaining duplicate
window.CAMPISTRY_TILES = TILES;

})();
