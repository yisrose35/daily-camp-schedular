// =================================================================
// daily_adjustments.js  (v5.2 - In-App Modals + Merged: v3.9 Logic + v5.0 UI)
// =================================================================
// MERGED VERSION:
// - v5.0 UI: Sidebar layout, modern CSS, subtabs, modal system
// - v3.9 Logic: Split tile fix, night activities, proper tile handlers
// - Professional Rainy Day Mode toggle with animations
// - Mid-day rainy mode (preserve morning schedule)
// - Auto-skeleton switch (swap to rainy day template)
// - Drag-to-reposition with live preview
// - Resize handles on tiles (drag edges)
// - Conflict highlighting using styles.css palette
// - Displaced tiles panel
// - Full Bunk-Specific Overrides UI
// - Full Resource Availability with Detail Pane
// - Smart Tiles passed to Core Optimizer for capacity awareness
// - Integration with getPinnedTileDefaultLocation for Pinned Events
// - Mobile Touch Support for Drag & Drop
// - RBAC checks for Editing & Optimizer
// - Split Tile subEvents structure fix
// - v5.2: In-App Modal System (daShowModal/daShowConfirm/daShowAlert)
//   replaces ALL browser prompt()/confirm()/alert() dialogs
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

const SNAP_MINS = 5;

// =================================================================
// IN-APP MODAL SYSTEM (replaces browser prompt/confirm/alert)
// =================================================================
function daShowModal(config) {
  return new Promise((resolve) => {
    const existing = document.getElementById('da-modal-input-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'da-modal-input-overlay';
    overlay.className = 'da-modal-overlay';
    overlay.innerHTML = `
      <div class="da-modal" style="max-width:${config.wide ? '560px' : '460px'};">
        <div class="da-modal-header">
          <h3>${config.title || 'Input Required'}</h3>
          <button class="da-modal-close da-modal-close-x">&times;</button>
        </div>
        <div class="da-modal-body">
          ${config.description ? '<p class="da-modal-desc">' + config.description + '</p>' : ''}
          <div class="da-modal-fields-container"></div>
          ${config.warning ? '<div class="da-modal-warning">' + config.warning + '</div>' : ''}
        </div>
        <div class="da-modal-footer">
          <button class="da-btn da-btn-ghost da-modal-cancel-x">Cancel</button>
          <button class="da-btn da-btn-primary da-modal-confirm-x">${config.confirmText || 'Confirm'}</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    const fieldsContainer = overlay.querySelector('.da-modal-fields-container');
    const inputs = {};

    (config.fields || []).forEach(function(field) {
      const fieldEl = document.createElement('div');
      fieldEl.className = 'da-modal-field';

      if (field.type === 'text' || field.type === 'time') {
        fieldEl.innerHTML = '<label>' + field.label + '</label>' +
          '<input type="text" class="da-input da-modal-focusable" data-field="' + field.name + '"' +
          ' value="' + (field.default || '') + '" placeholder="' + (field.placeholder || '') + '">';
        inputs[field.name] = function() { return fieldEl.querySelector('input').value.trim(); };
      }
      else if (field.type === 'select') {
        var options = (field.options || []).map(function(o) {
          var val = typeof o === 'object' ? (o.value !== undefined ? o.value : o) : o;
          var label = typeof o === 'object' ? (o.label !== undefined ? o.label : o) : o;
          var selected = val === field.default ? ' selected' : '';
          return '<option value="' + val + '"' + selected + '>' + label + '</option>';
        }).join('');
        fieldEl.innerHTML = '<label>' + field.label + '</label>' +
          '<select class="da-select da-modal-focusable" data-field="' + field.name + '">' + options + '</select>';
        inputs[field.name] = function() { return fieldEl.querySelector('select').value; };
      }
      else if (field.type === 'checkbox-group') {
        var checkboxes = (field.options || []).map(function(o) {
          return '<label class="da-modal-cb-item">' +
            '<input type="checkbox" value="' + o + '" data-group="' + field.name + '">' +
            '<span>' + o + '</span></label>';
        }).join('');
        fieldEl.innerHTML = '<label>' + field.label + '</label>' +
          '<div class="da-modal-cb-group">' + checkboxes + '</div>';
        inputs[field.name] = function() {
          var checked = fieldEl.querySelectorAll('input[data-group="' + field.name + '"]:checked');
          return Array.from(checked).map(function(c) { return c.value; });
        };
      }

      fieldsContainer.appendChild(fieldEl);
    });

    setTimeout(function() {
      var firstInput = overlay.querySelector('.da-modal-focusable');
      if (firstInput) firstInput.focus();
    }, 50);

    var close = function(result) { overlay.remove(); resolve(result); };

    overlay.querySelector('.da-modal-close-x').onclick = function() { close(null); };
    overlay.querySelector('.da-modal-cancel-x').onclick = function() { close(null); };
    overlay.onclick = function(e) { if (e.target === overlay) close(null); };

    overlay.querySelector('.da-modal-confirm-x').onclick = function() {
      var result = {};
      Object.keys(inputs).forEach(function(key) { result[key] = inputs[key](); });
      close(result);
    };

    overlay.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
        overlay.querySelector('.da-modal-confirm-x').click();
      }
      if (e.key === 'Escape') close(null);
    });
  });
}

function daShowConfirm(message, opts) {
  opts = opts || {};
  return new Promise(function(resolve) {
    var existing = document.getElementById('da-modal-input-overlay');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'da-modal-input-overlay';
    overlay.className = 'da-modal-overlay';
    overlay.innerHTML =
      '<div class="da-modal" style="max-width:420px;">' +
        '<div class="da-modal-body" style="padding:24px;">' +
          '<p style="margin:0;font-size:14px;color:#334155;line-height:1.6;">' + message + '</p>' +
        '</div>' +
        '<div class="da-modal-footer">' +
          '<button class="da-btn da-btn-ghost da-confirm-no">' + (opts.cancelText || 'Cancel') + '</button>' +
          '<button class="da-btn ' + (opts.danger ? 'da-btn-danger' : 'da-btn-primary') + ' da-confirm-yes">' + (opts.confirmText || 'Confirm') + '</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    overlay.querySelector('.da-confirm-no').onclick = function() { overlay.remove(); resolve(false); };
    overlay.querySelector('.da-confirm-yes').onclick = function() { overlay.remove(); resolve(true); };
    overlay.onclick = function(e) { if (e.target === overlay) { overlay.remove(); resolve(false); } };
    overlay.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { overlay.remove(); resolve(true); }
      if (e.key === 'Escape') { overlay.remove(); resolve(false); }
    });
    setTimeout(function() { overlay.querySelector('.da-confirm-yes').focus(); }, 50);
  });
}

function daShowAlert(message) {
  return new Promise(function(resolve) {
    var existing = document.getElementById('da-modal-input-overlay');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'da-modal-input-overlay';
    overlay.className = 'da-modal-overlay';
    overlay.innerHTML =
      '<div class="da-modal" style="max-width:400px;">' +
        '<div class="da-modal-body" style="padding:24px;">' +
          '<p style="margin:0;font-size:14px;color:#334155;line-height:1.6;">' + message + '</p>' +
        '</div>' +
        '<div class="da-modal-footer">' +
          '<button class="da-btn da-btn-primary da-alert-ok">OK</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    overlay.querySelector('.da-alert-ok').onclick = function() { overlay.remove(); resolve(); };
    overlay.onclick = function(e) { if (e.target === overlay) { overlay.remove(); resolve(); } };
    overlay.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === 'Escape') { overlay.remove(); resolve(); }
    });
    setTimeout(function() { overlay.querySelector('.da-alert-ok').focus(); }, 50);
  });
}

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
// RAINY DAY MODE - UI Components (Enhanced with Mid-Day & Auto-Skeleton)
// =================================================================
function isRainyDayActive() {
  // Check window.isRainyDay first (this is what the save system uses)
  // Must be strictly true, not just truthy
  if (window.isRainyDay === true) return true;
  if (window.isRainyDay === false) return false;
  
  // Fallback to dailyData for backward compatibility (only if window.isRainyDay is undefined)
  const dailyData = window.loadCurrentDailyData?.() || {};
  return dailyData.rainyDayMode === true || dailyData.isRainyDay === true;
}

function isMidDayModeActive() {
  // Check window.rainyDayStartTime first
  if (window.rainyDayStartTime !== null && window.rainyDayStartTime !== undefined) return true;
  
  // Fallback to dailyData
  const dailyData = window.loadCurrentDailyData?.() || {};
  return dailyData.rainyDayStartTime !== null && dailyData.rainyDayStartTime !== undefined;
}

function getMidDayStartTime() {
  // Check window.rainyDayStartTime first
  if (window.rainyDayStartTime !== null && window.rainyDayStartTime !== undefined) {
    return window.rainyDayStartTime;
  }
  
  // Fallback to dailyData
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
  
  // Indoor fields = marked as rainyDayAvailable
  const indoorFields = fields.filter(f => f.rainyDayAvailable === true);
  // Outdoor fields = NOT marked as rainyDayAvailable
  const outdoorFields = fields.filter(f => f.rainyDayAvailable !== true);
  
  // Rainy day special activities = marked as rainyDayOnly
  const rainyOnlySpecials = specials.filter(s => s.rainyDayOnly === true);
  // Indoor special activities = NOT marked as outdoor (available indoors)
  const indoorSpecials = specials.filter(s => s.isOutdoor !== true);
  
  // Count unique indoor activities from indoor fields
  const indoorSportsSet = new Set();
  indoorFields.forEach(f => {
    (f.activities || []).forEach(act => indoorSportsSet.add(act));
  });
  
  // Count outdoor activities from outdoor fields
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
  
  // Check if panel should be expanded (auto-expand if active)
  const isExpanded = isActive || panel.dataset.expanded === 'true';
     
  // Generate rain drops for animation
  let rainDrops = '';
  for (let i = 0; i < 25; i++) {
    const left = Math.random() * 100;
    const delay = Math.random() * 2;
    const duration = 0.5 + Math.random() * 0.5;
    const height = 15 + Math.random() * 20;
    rainDrops += `<div class="da-rain-drop" style="left:${left}%;animation-delay:${delay}s;animation-duration:${duration}s;height:${height}px;"></div>`;
  }
     
  // Skeleton options
  const skeletonOptions = availableSkeletons.map(name => 
    `<option value="${name}" ${name === rainySkeletonName ? 'selected' : ''}>${name}</option>`
  ).join('');
  
  // Get mid-day analysis if available
  const dailyData = window.loadCurrentDailyData?.() || {};
  const midDayAnalysis = dailyData.midDayRainAnalysis || null;
     
  // Mid-day info
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
              <!-- RAINY DAY STATS -->
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
              <!-- REGULAR DAY STATS -->
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
          
          <!-- Settings Toggle -->
          <div class="da-rainy-settings-toggle">
            <button id="da-rainy-settings-btn" class="da-rainy-settings-btn">⚙️ Settings</button>
          </div>
            
          <!-- Settings Panel -->
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
  // Dropdown toggle
  const dropdownToggle = document.getElementById('da-rainy-dropdown-toggle');
  const panel = document.getElementById('da-rainy-panel');
  
  if (dropdownToggle) {
    dropdownToggle.onclick = function(e) {
      // Don't toggle if clicking on the actual toggle switch
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
      
      // Debounce to prevent double-triggering
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
      // Just update the skeleton dropdown state instead of re-rendering entire panel
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
  
  // Set window.isRainyDay (this is what saveCurrentDailyData syncs)
  window.isRainyDay = true;
  window.rainyDayStartTime = null;
  
  // Also save for backward compatibility
  window.saveCurrentDailyData?.("rainyDayMode", true);
  window.saveCurrentDailyData?.("rainyDayStartTime", null);
  
  // Trigger a save to sync isRainyDay to cloud
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
  
  // Use custom start time or current time
  let rainStartMin;
  if (customStartTime !== null) {
    rainStartMin = customStartTime;
  } else {
    const now = new Date();
    rainStartMin = now.getHours() * 60 + now.getMinutes();
  }
  
  console.log(`[RainyDay] Mid-day mode starting at ${minutesToTime(rainStartMin)}`);
  
  // Backup pre-rainy state
  if (!dailyData.preRainyDayDisabledFields) {
    window.saveCurrentDailyData?.("preRainyDayDisabledFields", overrides.disabledFields || []);
  }
  
  // Analyze and categorize activities
  const activityAnalysis = analyzeActivitiesForMidDayRain(rainStartMin);
  console.log("[RainyDay] Activity analysis:", activityAnalysis);
  
  // Backup the schedule before making changes
  backupPreservedSchedule(rainStartMin);
  
  // Clear in-progress and future activities from schedule
  clearActivitiesFromRainStart(rainStartMin, activityAnalysis);
  
  // Disable outdoor fields
  const existingDisabled = overrides.disabledFields || [];
  const newDisabled = [...new Set([...existingDisabled, ...stats.outdoorFieldNames])];
  
  overrides.disabledFields = newDisabled;
  currentOverrides.disabledFields = newDisabled;
  window.saveCurrentDailyData?.("overrides", overrides);
  
  // Set window.isRainyDay
  window.isRainyDay = true;
  window.rainyDayStartTime = rainStartMin;
  
  window.saveCurrentDailyData?.("rainyDayMode", true);
  window.saveCurrentDailyData?.("rainyDayStartTime", rainStartMin);
  window.saveCurrentDailyData?.("isRainyDay", true);
  
  // Store analysis for UI display
  window.saveCurrentDailyData?.("midDayRainAnalysis", activityAnalysis);
  
  let skeletonSwitched = false;
  if (isAutoSkeletonSwitchEnabled()) {
    skeletonSwitched = switchToRainySkeleton();
  }
  
  showRainyDayNotification(true, stats.outdoorFieldNames.length, true, skeletonSwitched, activityAnalysis.completedCount);
  console.log("[RainyDay] Activated mid-day mode at", minutesToTime(rainStartMin));
  console.log("[RainyDay] Kept:", activityAnalysis.completedCount, "| Cut short:", activityAnalysis.inProgressCount, "| Cleared:", activityAnalysis.futureCount);
}

// Analyze activities relative to rain start time
function analyzeActivitiesForMidDayRain(rainStartMin) {
  const times = window.unifiedTimes || [];
  const schedules = window.scheduleAssignments || {};
  
  const analysis = {
    completed: [],      // Slots that finished before rain (KEEP)
    inProgress: [],     // Slots that were in progress when rain started (CUT SHORT)
    future: [],         // Slots that hadn't started yet (CLEAR)
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
      // Slot ended before rain started → COMPLETED (keep)
      analysis.completed.push(slotInfo);
      analysis.completedCount++;
    } else if (slotStart < rainStartMin && slotEnd > rainStartMin) {
      // Slot was in progress when rain started → CUT SHORT (discard)
      slotInfo.cutAt = minutesToTime(rainStartMin);
      analysis.inProgress.push(slotInfo);
      analysis.inProgressCount++;
    } else if (slotStart >= rainStartMin) {
      // Slot hadn't started yet → FUTURE (clear)
      analysis.future.push(slotInfo);
      analysis.futureCount++;
    }
  }
  
  return analysis;
}

// Clear schedule assignments from rain start onwards
function clearActivitiesFromRainStart(rainStartMin, analysis) {
  const schedules = window.scheduleAssignments || {};
  
  // Get slot indices to clear (in-progress + future)
  const slotsToClear = new Set();
  analysis.inProgress.forEach(slot => slotsToClear.add(slot.index));
  analysis.future.forEach(slot => slotsToClear.add(slot.index));
  
  if (slotsToClear.size === 0) {
    console.log("[RainyDay] No slots to clear");
    return;
  }
  
  // Clear assignments for these slots across all bunks
  let clearedCount = 0;
  Object.keys(schedules).forEach(bunk => {
    slotsToClear.forEach(slotIdx => {
      if (schedules[bunk] && schedules[bunk][slotIdx]) {
        schedules[bunk][slotIdx] = null;
        clearedCount++;
      }
    });
  });
  
  // Save the updated schedule
  window.scheduleAssignments = schedules;
  window.saveCurrentDailyData?.("scheduleAssignments", schedules);
  
  console.log(`[RainyDay] Cleared ${clearedCount} assignments from ${slotsToClear.size} slots`);
}

// Show mid-day rain start time picker modal
function showMidDayRainModal() {
  // Remove any existing modal
  const existingModal = document.getElementById('da-midday-rain-modal');
  if (existingModal) existingModal.remove();
  
  const now = new Date();
  const currentHour = now.getHours();
  const currentMin = Math.floor(now.getMinutes() / 5) * 5; // Round to nearest 5
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
  
  // Preview function
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
  
  // Event handlers
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
  
  // Close on overlay click
  modal.onclick = (e) => {
    if (e.target === modal) modal.remove();
  };
  
  // Initial preview
  updatePreview();
}

function backupPreservedSchedule(startTimeMin) {
  const times = window.unifiedTimes || [];
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
  
  // Set window.isRainyDay = false (this is what the save system uses)
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
// FIELD RESERVATION HELPERS
// =================================================================
async function promptForReservedFields(eventName) {
  const allFields = (masterSettings.app1?.fields || []).map(f => f.name);
  const specialActivities = (masterSettings.app1?.specialActivities || []).map(s => s.name);
  const allLocations = [...new Set([...allFields, ...specialActivities])].sort();
  if (allLocations.length === 0) return [];

  const result = await daShowModal({
    title: 'Reserve Fields for "' + eventName + '"',
    description: 'Select which field(s) this event will use. This reserves them so the scheduler won\'t assign them to other bunks.',
    fields: [
      { name: 'fields', label: 'Available Fields & Activities', type: 'checkbox-group', options: allLocations }
    ],
    confirmText: 'Reserve Selected'
  });

  if (!result) return [];
  return result.fields || [];
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
            <strong>${d.event}</strong> (${d.division}) - ${d.originalStart} - ${d.originalEnd}
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
function eraseOverlappingTiles(newEvent, divName) {
  const newStartMin = parseTimeToMinutes(newEvent.startTime);
  const newEndMin = parseTimeToMinutes(newEvent.endTime);
  
  dailyOverrideSkeleton = dailyOverrideSkeleton.filter(ev => {
    if (ev.id === newEvent.id || ev.division !== divName) return true;
    const evStart = parseTimeToMinutes(ev.startTime);
    const evEnd = parseTimeToMinutes(ev.endTime);
    if (evStart == null || evEnd == null) return true;
    const overlaps = (evStart < newEndMin && evEnd > newStartMin);
    if (overlaps) {
      addDisplacedTile(ev, 'Erased by trip');
    }
    return !overlaps;
  });
}

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
      addDisplacedTile(ev, 'No room');
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

function showTileInfo(tile) {
  const desc = TILE_DESCRIPTIONS[tile.type] || tile.description || 'No description available.';
  daShowAlert('<strong>' + tile.name.toUpperCase() + '</strong><br><br>' + desc);
}

function mapEventNameForOptimizer(name) {
  if (!name) name = "Free";
  const lower = name.toLowerCase().trim();
  if (lower === 'activity') return { type: 'slot', event: 'General Activity Slot' };
  if (lower === 'sports') return { type: 'slot', event: 'Sports Slot' };
  if (lower === 'special activity' || lower === 'special') return { type: 'slot', event: 'Special Activity' };
  if (lower.includes('specialty league')) return { type: 'specialty_league', event: 'Specialty League' };
  if (lower.includes('league')) return { type: 'league', event: 'League Game' };
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
  
  // Header row
  html += `<div class="da-grid-header da-time-header">Time</div>`;
  availableDivisions.forEach((divName) => {
    const color = divisions[divName]?.color || '#444';
    html += `<div class="da-grid-header" style="background:${color};color:#fff;">${divName}</div>`;
  });
  
  // Time column
  html += `<div class="da-time-column" style="height:${totalHeight}px;">`;
  for (let m = earliestMin; m < latestMin; m += INCREMENT_MINS) {
    const top = (m - earliestMin) * PIXELS_PER_MINUTE;
    html += `<div class="da-time-marker" style="top:${top}px;">${minutesToTime(m)}</div>`;
  }
  html += `</div>`;
  
  // Division columns
  availableDivisions.forEach((divName) => {
    const div = divisions[divName];
    const s = parseTimeToMinutes(div?.startTime);
    const e = parseTimeToMinutes(div?.endTime);
    
    html += `<div class="da-grid-cell" data-div="${divName}" data-start-min="${earliestMin}" style="height:${totalHeight}px;">`;
    
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
  const adjustedHeight = Math.max(height - 2, 18); // Minimum 18px height
  
  // Night activity styling
  const isNight = !!ev.isNightActivity;
  if (isNight) {
    style = 'background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);border:2px solid #e94560;color:#fff;';
  }
  
  const selectedClass = selectedTileId === ev.id ? ' selected' : '';
  const nightClass = isNight ? ' da-night-activity' : '';
  
  // Better font sizing for small tiles
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
  
  const eventName = ev.event || 'Event';
  const timeStr = `${ev.startTime}-${ev.endTime}`;
  
  // Compact content for very small tiles
  let content;
  if (adjustedHeight < 24) {
    // Ultra compact - just name abbreviated
    const shortName = eventName.length > 12 ? eventName.substring(0, 10) + '..' : eventName;
    content = `<span style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${shortName}${isNight ? ' 🌙' : ''}</span>`;
  } else if (adjustedHeight < 35) {
    // Compact - name + time on one line
    content = `<span style="font-weight:600;">${eventName}</span>${isNight ? ' 🌙' : ''} <span style="font-size:9px;opacity:0.8;">${timeStr}</span>`;
  } else {
    // Normal layout
    content = `<strong>${eventName}</strong>`;
    if (isNight) content += ' 🌙';
    content += `<div style="font-size:10px;opacity:0.85;">${timeStr}</div>`;
    
    // Location display for larger tiles
    if (adjustedHeight > 50) {
      const locationDisplay = ev.location || (ev.reservedFields?.length > 0 ? ev.reservedFields.join(', ') : null);
      if (locationDisplay && ev.type !== 'elective') {
        content += `<div style="font-size:9px;opacity:0.8;">📍 ${locationDisplay}</div>`;
      }
      
      if (ev.type === 'elective' && ev.electiveActivities?.length > 0) {
        const actList = ev.electiveActivities.slice(0, 3).join(', ');
        const more = ev.electiveActivities.length > 3 ? ` +${ev.electiveActivities.length - 3}` : '';
        content += `<div style="font-size:9px;opacity:0.8;">🎯 ${actList}${more}</div>`;
      }
      
      if (ev.type === 'smart' && ev.smartData) {
        content += `<div style="font-size:9px;opacity:0.8;">F: ${ev.smartData.fallbackActivity}</div>`;
      }
    }
  }
  
  return `<div class="da-event${selectedClass}${nightClass}" data-id="${ev.id}" draggable="true" 
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
function applyConflictHighlighting(gridEl) {
  if (!window.SkeletonSandbox) return;
  
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
// EVENT LISTENERS - RESIZE
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
        
        const div = window.divisions?.[event.division] || {};
        const divStartMin = parseTimeToMinutes(div.startTime) || 540;
        const divEndMin = parseTimeToMinutes(div.endTime) || 960;
        
        if (event.isNightActivity) {
          event.startTime = minutesToTime(Math.max(divStartMin, Math.round(newStartMin / SNAP_MINS) * SNAP_MINS));
          event.endTime = minutesToTime(Math.round(newEndMin / SNAP_MINS) * SNAP_MINS);
        } else {
          event.startTime = minutesToTime(Math.max(divStartMin, Math.round(newStartMin / SNAP_MINS) * SNAP_MINS));
          event.endTime = minutesToTime(Math.min(divEndMin, Math.round(newEndMin / SNAP_MINS) * SNAP_MINS));
        }
        
        saveDailySkeleton();
        renderGrid();
      }
    });
  });
}

// =================================================================
// EVENT LISTENERS - DRAG TO REPOSITION
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
      
      ghost.innerHTML = `<strong>${event.event}</strong><br><span>${event.startTime} - ${event.endTime}</span>`;
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
        event.division = divName;
        event.startTime = minutesToTime(cellStartMin + snapMin);
        event.endTime = minutesToTime(cellStartMin + snapMin + duration);
        
        bumpOverlappingTiles(event, divName);
        saveDailySkeleton();
        renderGrid();
        return;
      }
    });
  });
}

// =================================================================
// EVENT LISTENERS - DROP NEW TILES
// =================================================================
function addDropListeners(gridEl) {
  gridEl.querySelectorAll('.da-grid-cell').forEach(cell => {
    cell.ondragover = (e) => {
      if (e.dataTransfer.types.includes('text/event-move')) return;
      e.preventDefault();
      cell.style.background = 'rgba(59,130,246,0.1)';
    };
    cell.ondragleave = () => { cell.style.background = ''; };
    
   cell.ondrop = async (e) => {
      if (e.dataTransfer.types.includes('text/event-move')) return;
      e.preventDefault();
      cell.style.background = '';
      
      let tileData;
      try { tileData = JSON.parse(e.dataTransfer.getData('application/json')); } catch { return; }
      
      const divName = cell.dataset.div;
      const earliestMin = parseInt(cell.dataset.startMin);
      const div = window.divisions[divName] || {};
      const divStartMin = parseTimeToMinutes(div.startTime);
      const divEndMin = parseTimeToMinutes(div.endTime);
      
      const rect = cell.getBoundingClientRect();
      const offsetY = e.clientY - rect.top;
      let minOffset = Math.round(offsetY / PIXELS_PER_MINUTE / 15) * 15;
      let startMin = earliestMin + minOffset;
      let endMin = startMin + INCREMENT_MINS;
      const startStr = minutesToTime(startMin);
      const endStr = minutesToTime(endMin);
      let newEvent = null;
      let isNightActivity = false;

      // --- Async time validation helper ---
      async function validateTimeAsync(timeStr, isStartTime, allowNightActivity) {
        const timeMin = parseTimeToMinutes(timeStr);
        if (timeMin === null) {
          await daShowAlert("Invalid time format. Please use '9:00am' or '2:30pm'.");
          return { valid: false, minutes: null, isNight: false };
        }
        const GUARD_START = 480, GUARD_END = 1200;
        const outsideDefaultHours = (timeMin < GUARD_START || timeMin > GUARD_END);
        const coveredByDivision = (divStartMin !== null && divEndMin !== null && timeMin >= divStartMin && timeMin <= divEndMin);
        if (outsideDefaultHours && !coveredByDivision) {
          const ok = await daShowConfirm('⚠️ <strong>Unusual Time Warning</strong><br><br>"' + timeStr + '" is outside normal camp hours (8:00 AM – 8:00 PM).<br><br>Is this tile correct?');
          if (!ok) return { valid: false, minutes: null, isNight: false };
        }
        if (divStartMin !== null && timeMin < divStartMin) {
          await daShowAlert(timeStr + " is before this division's start time of " + div.startTime + ".");
          return { valid: false, minutes: null, isNight: false };
        }
        if (divEndMin !== null && (isStartTime ? timeMin >= divEndMin : timeMin > divEndMin)) {
          if (allowNightActivity) return { valid: true, minutes: timeMin, isNight: true };
          const isNight = await daShowConfirm('⏰ "' + timeStr + '" is after this division\'s end time (' + div.endTime + ').<br><br>Is this a <strong>Night Activity / Late Night</strong> event?', { confirmText: 'Yes, Night Activity', cancelText: 'Re-enter' });
          if (isNight) return { valid: true, minutes: timeMin, isNight: true };
          else return { valid: false, minutes: null, isNight: false };
        }
        return { valid: true, minutes: timeMin, isNight: false };
      }

      // --- Validate start+end from a modal result ---
      async function validateStartEnd(st, et, nightOverride) {
        const stResult = await validateTimeAsync(st, true, false);
        if (!stResult.valid) return null;
        let night = stResult.isNight || !!nightOverride;
        const etResult = await validateTimeAsync(et, false, night);
        if (!etResult.valid) return null;
        if (etResult.minutes <= stResult.minutes) { await daShowAlert("End time must be after start time."); return null; }
        if (etResult.isNight) night = true;
        return { startTime: st, endTime: et, startMin: stResult.minutes, endMin: etResult.minutes, isNight: night };
      }

      // ===== SMART TILE =====
      if (tileData.type === 'smart') {
        const result = await daShowModal({
          title: 'Smart Tile for ' + divName,
          description: 'Balances two activities across bunks. One group gets Activity A while another gets Activity B, then they swap. Includes fallback if primary is full.',
          fields: [
            { name: 'startTime', label: 'Start Time', type: 'text', placeholder: 'e.g., 11:00am', default: startStr },
            { name: 'endTime', label: 'End Time', type: 'text', placeholder: 'e.g., 11:45am', default: endStr },
            { name: 'main1', label: 'Main Activity 1 (limited capacity)', type: 'text', placeholder: 'e.g., Swim, Special' },
            { name: 'main2', label: 'Main Activity 2 (everyone else)', type: 'text', placeholder: 'e.g., Sports, Activity' },
            { name: 'fallbackActivity', label: 'Fallback (when Main 1 is full)', type: 'text', default: 'Activity', placeholder: 'e.g., Activity, Sports' }
          ]
        });
        if (!result || !result.startTime || !result.endTime || !result.main1 || !result.main2) return;
        const times = await validateStartEnd(result.startTime, result.endTime);
        if (!times) return;
        isNightActivity = times.isNight;
        newEvent = {
          id: 'evt_' + Math.random().toString(36).slice(2, 9),
          type: "smart", event: result.main1 + " / " + result.main2, division: divName,
          startTime: result.startTime, endTime: result.endTime,
          smartData: { main1: result.main1, main2: result.main2, fallbackFor: result.main1, fallbackActivity: result.fallbackActivity || 'Activity' },
          isNightActivity: isNightActivity
        };
      }
      // ===== SPLIT TILE =====
      else if (tileData.type === 'split') {
        const result = await daShowModal({
          title: 'Split Activity for ' + divName,
          description: 'Splits division into two groups. Group 1 does Main 1 first, Group 2 does Main 2 first. Midway through, they SWAP.',
          fields: [
            { name: 'startTime', label: 'Start Time (full block)', type: 'text', placeholder: 'e.g., 11:00am', default: startStr },
            { name: 'endTime', label: 'End Time (full block)', type: 'text', placeholder: 'e.g., 11:30am', default: endStr },
            { name: 'main1', label: 'Main 1 (Group 1 starts here)', type: 'text', placeholder: 'e.g., Swim, Sports, Art' },
            { name: 'main2', label: 'Main 2 (Group 2 starts here)', type: 'text', placeholder: 'e.g., Sports, Special, Activity' }
          ]
        });
        if (!result || !result.startTime || !result.endTime || !result.main1 || !result.main2) return;
        const times = await validateStartEnd(result.startTime, result.endTime);
        if (!times) return;
        isNightActivity = times.isNight;
        const event1 = mapEventNameForOptimizer(result.main1);
        const event2 = mapEventNameForOptimizer(result.main2);
        newEvent = {
          id: 'evt_' + Math.random().toString(36).slice(2, 9),
          type: 'split', event: result.main1 + " / " + result.main2, division: divName,
          startTime: result.startTime, endTime: result.endTime,
          subEvents: [
            { ...event1, event: event1.event || result.main1 },
            { ...event2, event: event2.event || result.main2 }
          ],
          isNightActivity: isNightActivity
        };
        console.log('[SPLIT TILE] Created split tile for ' + divName + ':', newEvent.subEvents);
      }
      // ===== ELECTIVE =====
      else if (tileData.type === 'elective') {
        const allFields = (masterSettings.app1?.fields || []).map(f => f.name);
        const allSpecials = (masterSettings.app1?.specialActivities || []).map(s => s.name);
        const allLocations = [...new Set([...allFields, ...allSpecials])].sort();
        const result = await daShowModal({
          title: 'Elective for ' + divName,
          description: 'Select activities to RESERVE for this division only. Other divisions cannot use these during this time.',
          wide: true,
          fields: [
            { name: 'startTime', label: 'Start Time', type: 'text', placeholder: 'e.g., 11:00am', default: startStr },
            { name: 'endTime', label: 'End Time', type: 'text', placeholder: 'e.g., 11:30am', default: endStr },
            { name: 'activities', label: 'Reserve Activities', type: 'checkbox-group', options: allLocations }
          ]
        });
        if (!result || !result.startTime || !result.endTime) return;
        const electiveActivities = result.activities || [];
        if (electiveActivities.length === 0) { await daShowAlert("Please select at least one activity."); return; }
        const times = await validateStartEnd(result.startTime, result.endTime);
        if (!times) return;
        isNightActivity = times.isNight;
        newEvent = {
          id: 'evt_' + Math.random().toString(36).slice(2, 9),
          type: 'elective', event: 'Elective', division: divName,
          startTime: result.startTime, endTime: result.endTime,
          electiveActivities, isNightActivity
        };
      }
      // ===== CUSTOM PINNED =====
      else if (tileData.type === 'custom') {
        const result = await daShowModal({
          title: 'Custom Pinned Event for ' + divName,
          description: 'Create a fixed event like Assembly, Special Program, etc.',
          fields: [
            { name: 'eventName', label: 'Event Name', type: 'text', placeholder: 'e.g., Regroup, Assembly', default: 'Regroup' },
            { name: 'startTime', label: 'Start Time', type: 'text', placeholder: 'e.g., 11:00am', default: startStr },
            { name: 'endTime', label: 'End Time', type: 'text', placeholder: 'e.g., 11:30am', default: endStr }
          ]
        });
        if (!result || !result.eventName || !result.startTime || !result.endTime) return;
        const times = await validateStartEnd(result.startTime, result.endTime);
        if (!times) return;
        isNightActivity = times.isNight;
        const reservedFields = await promptForReservedFields(result.eventName);
        newEvent = {
          id: Date.now().toString(), type: 'pinned', event: result.eventName.trim(),
          division: divName, startTime: result.startTime, endTime: result.endTime,
          reservedFields: reservedFields,
          location: reservedFields.length === 1 ? reservedFields[0] : null,
          isNightActivity
        };
      }
      // ===== OTHER PINNED (lunch, snacks, dismissal, swim) =====
      else if (['lunch', 'snacks', 'dismissal', 'swim'].includes(tileData.type)) {
        let name = tileData.name;
        let reservedFields = [];
        let defaultLocation = null;
        if (window.getPinnedTileDefaultLocation) {
          defaultLocation = window.getPinnedTileDefaultLocation(tileData.type);
          if (defaultLocation) reservedFields = [defaultLocation];
        }
        if (tileData.type === 'swim' && reservedFields.length === 0) {
          const swimField = (masterSettings.app1?.fields || []).find(f =>
            f.name.toLowerCase().includes('swim') || f.name.toLowerCase().includes('pool')
          );
          if (swimField) reservedFields = [swimField.name];
        }
        const result = await daShowModal({
          title: name + ' for ' + divName,
          fields: [
            { name: 'startTime', label: 'Start Time', type: 'text', placeholder: 'e.g., 11:00am', default: startStr },
            { name: 'endTime', label: 'End Time', type: 'text', placeholder: 'e.g., 11:45am', default: endStr }
          ]
        });
        if (!result || !result.startTime || !result.endTime) return;
        const times = await validateStartEnd(result.startTime, result.endTime);
        if (!times) return;
        isNightActivity = times.isNight;
        newEvent = {
          id: Date.now().toString(), type: 'pinned', event: name, division: divName,
          startTime: result.startTime, endTime: result.endTime,
          reservedFields,
          location: defaultLocation || (reservedFields.length > 0 ? reservedFields[0] : null),
          isNightActivity
        };
      }
      // ===== LEAGUE =====
      else if (tileData.type === 'league') {
        const result = await daShowModal({
          title: 'League Game for ' + divName,
          fields: [
            { name: 'startTime', label: 'Start Time', type: 'text', placeholder: 'e.g., 11:00am', default: startStr },
            { name: 'endTime', label: 'End Time', type: 'text', placeholder: 'e.g., 11:45am', default: endStr }
          ]
        });
        if (!result || !result.startTime || !result.endTime) return;
        const times = await validateStartEnd(result.startTime, result.endTime);
        if (!times) return;
        isNightActivity = times.isNight;
        newEvent = {
          id: 'evt_' + Math.random().toString(36).slice(2, 9),
          type: 'league', event: 'League Game', division: divName,
          startTime: result.startTime, endTime: result.endTime, isNightActivity
        };
      }
      // ===== SPECIALTY LEAGUE =====
      else if (tileData.type === 'specialty_league') {
        const result = await daShowModal({
          title: 'Specialty League for ' + divName,
          fields: [
            { name: 'startTime', label: 'Start Time', type: 'text', placeholder: 'e.g., 11:00am', default: startStr },
            { name: 'endTime', label: 'End Time', type: 'text', placeholder: 'e.g., 11:45am', default: endStr }
          ]
        });
        if (!result || !result.startTime || !result.endTime) return;
        const times = await validateStartEnd(result.startTime, result.endTime);
        if (!times) return;
        isNightActivity = times.isNight;
        newEvent = {
          id: 'evt_' + Math.random().toString(36).slice(2, 9),
          type: 'specialty_league', event: 'Specialty League', division: divName,
          startTime: result.startTime, endTime: result.endTime, isNightActivity
        };
      }
      // ===== STANDARD SLOTS (Activity, Sports, Special) =====
      else {
        let name = tileData.name;
        let finalType = tileData.type;
        if (tileData.type === 'activity') { name = "General Activity Slot"; finalType = 'slot'; }
        else if (tileData.type === 'sports') { name = "Sports Slot"; finalType = 'slot'; }
        else if (tileData.type === 'special') { name = "Special Activity"; finalType = 'slot'; }
        if (!name) return;
        const result = await daShowModal({
          title: name + ' for ' + divName,
          fields: [
            { name: 'startTime', label: 'Start Time', type: 'text', placeholder: 'e.g., 11:00am', default: startStr },
            { name: 'endTime', label: 'End Time', type: 'text', placeholder: 'e.g., 11:45am', default: endStr }
          ]
        });
        if (!result || !result.startTime || !result.endTime) return;
        const times = await validateStartEnd(result.startTime, result.endTime);
        if (!times) return;
        isNightActivity = times.isNight;
        newEvent = {
          id: Date.now().toString(), type: finalType, event: name, division: divName,
          startTime: result.startTime, endTime: result.endTime, isNightActivity
        };
      }
      
      if (newEvent) {
        const newStartVal = parseTimeToMinutes(newEvent.startTime);
        const newEndVal = parseTimeToMinutes(newEvent.endTime);
        dailyOverrideSkeleton = dailyOverrideSkeleton.filter(existing => {
          if (existing.division !== divName) return true;
          const exStart = parseTimeToMinutes(existing.startTime);
          const exEnd = parseTimeToMinutes(existing.endTime);
          if (exStart === null || exEnd === null) return true;
          const overlaps = (exStart < newEndVal) && (exEnd > newStartVal);
          return !overlaps;
        });
        dailyOverrideSkeleton.push(newEvent);
        saveDailySkeleton();
        renderGrid();
      }
    };
    
    // Mobile touch support
    cell.addEventListener('touchend', (e) => {
      const paletteEl = document.getElementById('da-palette');
      if (!paletteEl) return;

      const touch = e.changedTouches[0];
      const elementAtPoint = document.elementFromPoint(touch.clientX, touch.clientY);

      if (!elementAtPoint || !cell.contains(elementAtPoint)) return;

      const tiles = Array.from(paletteEl.querySelectorAll('.da-tile'));
      const draggedTile = tiles.find(t => t.style.opacity === '0.6');

      if (!draggedTile || !draggedTile.dataset.tileData) return;

      let tileData;
      try {
        tileData = JSON.parse(draggedTile.dataset.tileData);
      } catch (err) {
        return;
      }
      
      draggedTile.style.opacity = '1';

      const fakeEvent = {
        preventDefault: () => {},
        clientY: touch.clientY,
        dataTransfer: {
          types: ['application/json'],
          getData: (format) => {
            if (format === 'application/json') return JSON.stringify(tileData);
            return '';
          }
        }
      };

      if (cell.ondrop) cell.ondrop(fakeEvent);
    });
  });
}

// =================================================================
// EVENT LISTENERS - REMOVE
// =================================================================
function addRemoveListeners(gridEl) {
  gridEl.querySelectorAll('.da-event').forEach(tile => {
    tile.onclick = (e) => {
      if (e.target.classList.contains('da-resize-handle')) return;
      e.stopPropagation();
      selectTile(tile.dataset.id);
    };
    
    tile.ondblclick = async (e) => {
      e.stopPropagation();
      if (e.target.classList.contains('da-resize-handle')) return;
      const id = tile.dataset.id;
      if (!id) return;
      const ok = await daShowConfirm("Delete this block?", { danger: true, confirmText: 'Delete' });
      if (ok) {
        dailyOverrideSkeleton = dailyOverrideSkeleton.filter(x => x.id !== id);
        selectedTileId = null;
        saveDailySkeleton();
        renderGrid();
      }
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

// =================================================================
// LOAD/SAVE
// =================================================================
function loadDailySkeleton() {
  const dateKey = window.currentScheduleDate;
  console.log('[DailyAdj] loadDailySkeleton called for date:', dateKey);
  
  // Priority 1: localStorage
  try {
    const storageKey = `campManualSkeleton_${dateKey}`;
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed && parsed.length > 0) {
        dailyOverrideSkeleton = parsed;
        window.dailyOverrideSkeleton = dailyOverrideSkeleton;
        console.log(`[DailyAdj] ✅ Loaded ${dailyOverrideSkeleton.length} events from localStorage`);
        return;
      }
    }
  } catch (e) {
    console.warn('[DailyAdj] Failed to load from localStorage:', e);
  }
  
  // Priority 2: Cloud
  try {
    const cloudSkeleton = masterSettings?.app1?.dailySkeletons?.[dateKey];
    if (cloudSkeleton && cloudSkeleton.length > 0) {
      dailyOverrideSkeleton = JSON.parse(JSON.stringify(cloudSkeleton));
      window.dailyOverrideSkeleton = dailyOverrideSkeleton;
      const storageKey = `campManualSkeleton_${dateKey}`;
      localStorage.setItem(storageKey, JSON.stringify(dailyOverrideSkeleton));
      console.log(`[DailyAdj] ✅ Loaded ${dailyOverrideSkeleton.length} events from CLOUD`);
      return;
    }
  } catch (e) {
    console.warn('[DailyAdj] Failed to load from cloud:', e);
  }
  
  // Priority 3: Daily data (legacy)
  const dailyData = window.loadCurrentDailyData?.() || {};
  if (dailyData.manualSkeleton && dailyData.manualSkeleton.length > 0) {
    dailyOverrideSkeleton = JSON.parse(JSON.stringify(dailyData.manualSkeleton));
    window.dailyOverrideSkeleton = dailyOverrideSkeleton;
    console.log(`[DailyAdj] ✅ Loaded ${dailyOverrideSkeleton.length} events from dailyData`);
    return;
  }
  
  // Priority 4: Template
  console.log('[DailyAdj] No saved skeleton found, loading from template...');
  const assignments = masterSettings.app1?.skeletonAssignments || {};
  const skeletons = masterSettings.app1?.savedSkeletons || {};
  const [Y, M, D] = dateKey.split('-').map(Number);
  let dow = 0;
  if (Y && M && D) dow = new Date(Y, M - 1, D).getDay();
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  let tmpl = assignments[dayNames[dow]] || assignments["Default"];
  console.log('[DailyAdj] Loading template:', tmpl || '(none)');
  dailyOverrideSkeleton = (tmpl && skeletons[tmpl]) ? JSON.parse(JSON.stringify(skeletons[tmpl])) : [];
  window.dailyOverrideSkeleton = dailyOverrideSkeleton;
}

function saveDailySkeleton() {
  if (!window.AccessControl?.canEdit?.()) {
    console.warn('[DailyAdj] Save blocked - insufficient permissions');
    return;
  }
  
  const dateKey = window.currentScheduleDate;
  console.log(`[DailyAdj] saveDailySkeleton called with ${dailyOverrideSkeleton.length} events for ${dateKey}`);
  
  // Save to localStorage
  try {
    const storageKey = `campManualSkeleton_${dateKey}`;
    localStorage.setItem(storageKey, JSON.stringify(dailyOverrideSkeleton));
  } catch (e) {
    console.error('[DailyAdj] Failed to save to localStorage:', e);
  }
  
  // Save to cloud
  try {
    if (!masterSettings.app1.dailySkeletons) {
      masterSettings.app1.dailySkeletons = {};
    }
    masterSettings.app1.dailySkeletons[dateKey] = dailyOverrideSkeleton;
    if (typeof window.saveGlobalSettings === 'function') {
      window.saveGlobalSettings('app1', masterSettings.app1);
    }
  } catch (e) {
    console.error('[DailyAdj] Failed to save to cloud:', e);
  }
  
  window.dailyOverrideSkeleton = dailyOverrideSkeleton;
  window.forceSyncToCloud?.();
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
  } else {
    return null;
  }
  return hh * 60 + mm;
}

function minutesToTime(min) {
  let h = Math.floor(min / 60), m = min % 60, ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return h + ':' + m.toString().padStart(2, '0') + ap;
}

function uid() {
  return 'id_' + Math.random().toString(36).slice(2, 9);
}

// =================================================================
// TOOLBAR
// =================================================================
function renderToolbar() {
  const toolbar = document.getElementById('da-skeleton-toolbar');
  if (!toolbar) return;
  
  const savedSkeletons = masterSettings.app1?.savedSkeletons || {};
  const names = Object.keys(savedSkeletons).sort();
  const loadOptions = names.map(n => `<option value="${n}">${n}</option>`).join('');
  
  toolbar.innerHTML = `
    <div class="da-toolbar-group">
      <span class="da-toolbar-label">Template:</span>
      <select id="da-load-select" class="da-select">
        <option value="">Load...</option>
        ${loadOptions}
      </select>
    </div>
    
    <div class="da-toolbar-group">
      <button id="da-clear-btn" class="da-btn da-btn-ghost">Clear All</button>
      ${window.SkeletonSandbox ? '<button id="da-conflict-rules-btn" class="da-btn da-btn-ghost">⚙️ Rules</button>' : ''}
    </div>
    
    <div style="flex:1;"></div>
    
    <div class="da-toolbar-group">
      <button id="da-generate-btn" class="da-btn da-btn-success">▶ Generate Schedule</button>
    </div>
  `;
  
  document.getElementById('da-load-select').onchange = async function() {
    const name = this.value;
    if (name && savedSkeletons[name]) {
      const ok = await daShowConfirm('Load template "' + name + '"?');
      if (ok) {
        dailyOverrideSkeleton = JSON.parse(JSON.stringify(savedSkeletons[name]));
        clearDisplacedTiles();
        saveDailySkeleton();
        renderGrid();
      }
    }
    this.value = '';
  };
  
  document.getElementById('da-clear-btn').onclick = async () => {
    const ok = await daShowConfirm('Clear all blocks?', { danger: true, confirmText: 'Clear All' });
    if (ok) {
      dailyOverrideSkeleton = [];
      saveDailySkeleton();
      renderGrid();
    }
  };
  
  if (window.SkeletonSandbox) {
    const rulesBtn = document.getElementById('da-conflict-rules-btn');
    if (rulesBtn) {
      rulesBtn.onclick = () => {
        window.SkeletonSandbox.showRulesModal(() => renderGrid(), dailyOverrideSkeleton);
      };
    }
  }
  
  document.getElementById('da-generate-btn').onclick = runOptimizer;
}

// =================================================================
// RUN OPTIMIZER
// =================================================================
function runOptimizer() {
  if (!window.AccessControl?.checkEditAccess?.('run optimizer')) return;
  if (!window.runSkeletonOptimizer) { alert("Error: 'runSkeletonOptimizer' not found."); return; }
  if (dailyOverrideSkeleton.length === 0) { alert("Skeleton is empty."); return; }
  saveDailySkeleton();
  const success = window.runSkeletonOptimizer(dailyOverrideSkeleton, currentOverrides);
  if (success) { alert("Schedule Generated!"); window.showTab?.('schedule'); }
  else { alert("Error. Check console."); }
}

// =================================================================
// TRIPS FORM
// =================================================================
function renderTripsForm() {
  const container = document.getElementById('da-trips-container');
  if (!container) return;
  
  const divisions = window.availableDivisions || [];
  
  container.innerHTML = `
    <div class="da-section">
      <h3 class="da-section-title">Add Trip</h3>
      <p class="da-section-desc">Add an off-campus trip. Overlapping events will be bumped.</p>
      
      <div class="da-form-grid">
        <div class="da-form-field">
          <label>Division</label>
          <select id="da-trip-division" class="da-select">
            <option value="">-- Select --</option>
            ${divisions.map(d => `<option value="${d}">${d}</option>`).join("")}
          </select>
        </div>
        <div class="da-form-field">
          <label>Trip Name</label>
          <input id="da-trip-name" type="text" placeholder="e.g. Six Flags" class="da-input" />
        </div>
        <div class="da-form-field">
          <label>Start</label>
          <input id="da-trip-start" type="text" placeholder="10:00am" class="da-input" />
        </div>
        <div class="da-form-field">
          <label>End</label>
          <input id="da-trip-end" type="text" placeholder="3:30pm" class="da-input" />
        </div>
      </div>
      
      <button id="da-apply-trip-btn" class="da-btn da-btn-primary" style="margin-top:16px;">Add Trip</button>
    </div>
  `;
  
  document.getElementById("da-apply-trip-btn").onclick = () => {
    const division = document.getElementById("da-trip-division").value;
    const tripName = document.getElementById("da-trip-name").value.trim();
    const startTime = document.getElementById("da-trip-start").value.trim();
    const endTime = document.getElementById("da-trip-end").value.trim();
    
    if (!division || !tripName || !startTime || !endTime) { alert("Complete all fields."); return; }
    const startMin = parseTimeToMinutes(startTime);
    const endMin = parseTimeToMinutes(endTime);
    if (startMin == null || endMin == null) { alert("Invalid time."); return; }
    if (endMin <= startMin) { alert("End must be after start."); return; }
    
    loadDailySkeleton();
    const newEvent = { id: 'trip_' + Date.now(), type: "pinned", event: tripName, division, startTime, endTime, reservedFields: [] };
    eraseOverlappingTiles(newEvent, division);
    dailyOverrideSkeleton.push(newEvent);
    saveDailySkeleton();
    renderGrid();
    
    document.querySelector('.da-subtab[data-tab="skeleton"]').click();
    alert("Trip added!");
    document.getElementById("da-trip-name").value = "";
    document.getElementById("da-trip-start").value = "";
    document.getElementById("da-trip-end").value = "";
  };
}

// =================================================================
// BUNK OVERRIDES UI
// =================================================================
function renderBunkOverridesUI() {
  const container = document.getElementById('da-bunk-overrides-container');
  if (!container) return;
  
  const divisions = masterSettings.app1?.divisions || {};
  const availableDivisions = masterSettings.app1?.availableDivisions || window.availableDivisions || [];
  const allBunksByDiv = {};
  availableDivisions.forEach(divName => {
    allBunksByDiv[divName] = (divisions[divName]?.bunks || []).sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)?.[0] || 0);
      const numB = parseInt(b.match(/\d+/)?.[0] || 0);
      return numA - numB || a.localeCompare(b);
    });
  });
  
  // Get fields (from app1.fields) - these are the FIELD NAMES
  const allFields = (masterSettings.app1?.fields || []).map(f => ({
    name: f.name,
    activities: f.activities || [],
    isIndoor: f.rainyDayAvailable === true
  }));
  
  // Get all sports (activities from fields)
  const allSportsSet = new Set();
  allFields.forEach(f => {
    (f.activities || []).forEach(act => allSportsSet.add(act));
  });
  const allSports = [...allSportsSet].sort();
  
  // Get special activities
  const allSpecials = (masterSettings.app1?.specialActivities || []).map(s => s.name).sort();
  
  // Get facilities from locationZones (Pool, Lunchroom, etc.)
  const locationZones = masterSettings.global?.locationZones || {};
  const facilities = [];
  Object.entries(locationZones).forEach(([zoneName, zone]) => {
    if (zone && zone.locations) {
      Object.keys(zone.locations).forEach(locName => {
        facilities.push({
          name: locName,
          zone: zoneName,
          displayName: `${locName} (${zoneName})`
        });
      });
    }
  });
  
  // Get pinned tile defaults (Swim → Pool, Lunch → Lunchroom, etc.)
  const pinnedDefaults = masterSettings.global?.pinnedTileDefaults || {};
  const pinnedActivities = Object.keys(pinnedDefaults);
  
  // Build grouped options
  let activityOptions = '<option value="">-- Select Activity --</option>';
  
  // Pinned Activities group (Swim, Lunch, Snacks, etc.) - if available
  if (pinnedActivities.length > 0) {
    activityOptions += '<optgroup label="📌 Pinned Activities">';
    pinnedActivities.sort().forEach(act => {
      const facility = pinnedDefaults[act];
      activityOptions += `<option value="${act}" data-type="pinned" data-location="${facility}">${act} → ${facility}</option>`;
    });
    activityOptions += '</optgroup>';
  }
  
  // Facilities group (Pool, Lunchroom, etc.) - from locationZones
  if (facilities.length > 0) {
    activityOptions += '<optgroup label="🏢 Facilities">';
    facilities.sort((a, b) => a.name.localeCompare(b.name)).forEach(fac => {
      activityOptions += `<option value="${fac.name}" data-type="facility" data-location="${fac.name}">${fac.displayName}</option>`;
    });
    activityOptions += '</optgroup>';
  }
  
  // Fields group (Hockey Arena, Baseball Field, etc.)
  if (allFields.length > 0) {
    activityOptions += '<optgroup label="🏟️ Fields">';
    allFields.sort((a, b) => a.name.localeCompare(b.name)).forEach(field => {
      const indoorBadge = field.isIndoor ? ' 🏠' : '';
      activityOptions += `<option value="${field.name}" data-type="field" data-location="${field.name}">${field.name}${indoorBadge}</option>`;
    });
    activityOptions += '</optgroup>';
  }
  
  // Special Activities group (Canteen, Gameroom, etc.)
  if (allSpecials.length > 0) {
    activityOptions += '<optgroup label="🎨 Special Activities">';
    allSpecials.forEach(act => {
      activityOptions += `<option value="${act}" data-type="special">${act}</option>`;
    });
    activityOptions += '</optgroup>';
  }
  
  // Sports group (Basketball, Soccer, etc.)
  if (allSports.length > 0) {
    activityOptions += '<optgroup label="⚽ Sports">';
    allSports.forEach(sport => {
      activityOptions += `<option value="${sport}" data-type="sport">${sport}</option>`;
    });
    activityOptions += '</optgroup>';
  }
  
  container.innerHTML = `
    <div class="da-section">
      <h3 class="da-section-title">Bunk-Specific Overrides</h3>
      <p class="da-section-desc">Assign a specific activity to bunks at a specific time. This pins the activity for those bunks.</p>
      
      <div class="da-form-grid">
        <div class="da-form-field" style="grid-column: span 2;">
          <label>Select Activity:</label>
          <select id="da-bunk-override-activity" class="da-select">${activityOptions}</select>
        </div>
        <div class="da-form-field">
          <label>Start Time:</label>
          <input id="da-bunk-override-start" placeholder="9:00am" class="da-input">
        </div>
        <div class="da-form-field">
          <label>End Time:</label>
          <input id="da-bunk-override-end" placeholder="10:00am" class="da-input">
        </div>
      </div>
      
      <p style="margin-top:16px;font-weight:600;">Select Bunks:</p>
      <div id="da-bunk-chips"></div>
      
      <button id="da-add-override-btn" class="da-btn da-btn-primary" style="margin-top:16px;">Add Pinned Activity</button>
    </div>
    
    <div class="da-section" style="margin-top:20px;">
      <h4>Current Overrides</h4>
      <div id="da-overrides-list"></div>
    </div>
  `;
  
  // Render bunk chips
  const chipsContainer = document.getElementById('da-bunk-chips');
  availableDivisions.forEach(divName => {
    const bunks = allBunksByDiv[divName];
    if (!bunks || bunks.length === 0) return;
    
    const divLabel = document.createElement('div');
    divLabel.textContent = divName;
    divLabel.style.cssText = 'font-weight:600;font-size:12px;color:#64748b;margin-top:8px;';
    chipsContainer.appendChild(divLabel);
    
    const chipBox = document.createElement('div');
    chipBox.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;';
    bunks.forEach(bunkName => {
      const chip = createChip(bunkName, divisions[divName]?.color || '#64748b');
      chipBox.appendChild(chip);
    });
    chipsContainer.appendChild(chipBox);
  });
  
  // Add button handler
  document.getElementById('da-add-override-btn').onclick = () => {
    const activityEl = document.getElementById('da-bunk-override-activity');
    const startEl = document.getElementById('da-bunk-override-start');
    const endEl = document.getElementById('da-bunk-override-end');
    const selectedBunks = Array.from(document.querySelectorAll('#da-bunk-chips .da-chip.selected')).map(el => el.dataset.value);
    
    const activity = activityEl.value;
    const selectedOption = activityEl.options[activityEl.selectedIndex];
    const activityType = selectedOption?.dataset?.type || 'special';
    const location = selectedOption?.dataset?.location || null;
    
    // Determine type based on what was selected
    let type = 'special';
    if (activityType === 'pinned' || activityType === 'facility') {
      type = 'pinned';
    } else if (activityType === 'sport') {
      type = 'sport';
    }
    
    if (!activity) { alert('Please select an activity.'); return; }
    if (!startEl.value || !endEl.value) { alert('Please enter a start and end time.'); return; }
    if (selectedBunks.length === 0) { alert('Please select at least one bunk.'); return; }
    
    const startMin = parseTimeToMinutes(startEl.value);
    const endMin = parseTimeToMinutes(endEl.value);
    
    if (startMin == null || endMin == null || endMin <= startMin) {
      alert('Invalid time range.');
      return;
    }
    
    const dailyData = window.loadCurrentDailyData?.() || {};
    const overrides = dailyData.bunkActivityOverrides || [];
    
    selectedBunks.forEach(bunk => {
      overrides.push({ 
        id: uid(), 
        bunk, 
        activity, 
        location,
        startTime: startEl.value, 
        endTime: endEl.value, 
        type 
      });
    });
    
    window.saveCurrentDailyData("bunkActivityOverrides", overrides);
    currentOverrides.bunkActivityOverrides = overrides;
    
    activityEl.value = "";
    startEl.value = "";
    endEl.value = "";
    document.querySelectorAll('#da-bunk-chips .da-chip.selected').forEach(chip => chip.click());
    renderBunkOverridesUI();
  };
  
  // Render existing overrides list
  const listContainer = document.getElementById('da-overrides-list');
  const overrides = currentOverrides.bunkActivityOverrides;
  if (overrides.length === 0) {
    listContainer.innerHTML = '<p style="color:#94a3b8;font-size:13px;">No overrides added yet.</p>';
  } else {
    listContainer.innerHTML = '';
    overrides.forEach(item => {
      const el = document.createElement('div');
      el.className = 'da-override-item';
      const locationInfo = item.location ? ` <span style="color:#059669;">@ ${item.location}</span>` : '';
      const typeIcon = item.type === 'pinned' ? '📌' : (item.type === 'sport' ? '⚽' : '🎨');
      el.innerHTML = `
        <div>
          <strong>${item.bunk}</strong> → <span style="color:#3b82f6;">${typeIcon} ${item.activity}</span>${locationInfo}
          <div style="font-size:12px;color:#64748b;">${item.startTime} - ${item.endTime}</div>
        </div>
        <button class="da-btn da-btn-danger da-btn-sm" data-id="${item.id}">Remove</button>
      `;
      el.querySelector('button').onclick = () => {
        let currentList = window.loadCurrentDailyData?.().bunkActivityOverrides || [];
        currentList = currentList.filter(o => o.id !== item.id);
        window.saveCurrentDailyData("bunkActivityOverrides", currentList);
        currentOverrides.bunkActivityOverrides = currentList;
        renderBunkOverridesUI();
      };
      listContainer.appendChild(el);
    });
  }
}

function createChip(name, color) {
  const el = document.createElement('span');
  el.className = 'da-chip';
  el.textContent = name;
  el.dataset.value = name;
  el.style.cssText = `border:1px solid ${color};background:white;color:#374151;padding:4px 10px;border-radius:999px;cursor:pointer;font-size:12px;`;
  el.onclick = () => {
    const sel = el.classList.toggle('selected');
    el.style.backgroundColor = sel ? color : 'white';
    el.style.color = sel ? 'white' : '#374151';
  };
  return el;
}

// =================================================================
// RESOURCE OVERRIDES UI
// =================================================================
function renderResourceOverridesUI() {
  const container = document.getElementById('da-resources-container');
  if (!container) return;
  
  const isRainy = isRainyDayActive();
  const rainyBanner = isRainy ? `
    <div class="da-rainy-banner">
      <span>🌧️</span>
      <div>
        <strong>Rainy Day Mode Active</strong>
        <div style="font-size:12px;opacity:0.85;">Outdoor fields are automatically disabled</div>
      </div>
    </div>
  ` : '';
  
  container.innerHTML = `
    ${rainyBanner}
    <div class="da-resource-layout">
      <div class="da-resource-list">
        <h4>Fields</h4>
        <div id="da-override-fields-list"></div>
        <h4 style="margin-top:16px;">Special Activities</h4>
        <div id="da-override-specials-list"></div>
        <h4 style="margin-top:16px;">Leagues</h4>
        <div id="da-override-leagues-list"></div>
        <h4 style="margin-top:16px;">Specialty Leagues</h4>
        <div id="da-override-specialty-leagues-list"></div>
      </div>
      <div class="da-resource-detail">
        <h4>Details & Time Rules</h4>
        <div id="da-override-detail-pane">
          <p style="color:#94a3b8;">Select an item to edit details and set time-based availability.</p>
        </div>
      </div>
    </div>
  `;
  
  const saveOverrides = () => {
    const dailyData = window.loadCurrentDailyData?.() || {};
    const fullOverrides = dailyData.overrides || {};
    fullOverrides.leagues = currentOverrides.leagues;
    fullOverrides.disabledFields = currentOverrides.disabledFields;
    fullOverrides.disabledSpecials = currentOverrides.disabledSpecials;
    window.saveCurrentDailyData("overrides", fullOverrides);
    window.saveCurrentDailyData("dailyDisabledSportsByField", currentOverrides.dailyDisabledSportsByField);
    window.saveCurrentDailyData("dailyFieldAvailability", currentOverrides.dailyFieldAvailability);
  };
  
  const fields = masterSettings.app1?.fields || [];
  const fieldsListEl = document.getElementById("da-override-fields-list");
  
  fields.forEach(item => {
    const isDisabled = currentOverrides.disabledFields.includes(item.name);
    const isOutdoor = item.rainyDayAvailable !== true;
    const isRainyDisabled = isRainy && isOutdoor;
    const hasTimeRules = (currentOverrides.dailyFieldAvailability[item.name] || []).length > 0;
    
    const onToggle = (isEnabled) => {
      if (isEnabled) currentOverrides.disabledFields = currentOverrides.disabledFields.filter(n => n !== item.name);
      else if (!currentOverrides.disabledFields.includes(item.name)) currentOverrides.disabledFields.push(item.name);
      saveOverrides();
      renderResourceOverridesUI();
    };
    
    fieldsListEl.appendChild(createResourceToggleItem('field', item.name, !isDisabled, onToggle, isOutdoor, isRainyDisabled, false, hasTimeRules));
  });
  
  const specials = masterSettings.app1?.specialActivities || [];
  const specialsListEl = document.getElementById("da-override-specials-list");
  specials.forEach(item => {
    const isDisabled = currentOverrides.disabledSpecials.includes(item.name);
    const isRainyOnly = item.rainyDayOnly === true;
    const hasTimeRules = (currentOverrides.dailyFieldAvailability[item.name] || []).length > 0;
    
    const onToggle = (isEnabled) => {
      if (isEnabled) currentOverrides.disabledSpecials = currentOverrides.disabledSpecials.filter(n => n !== item.name);
      else if (!currentOverrides.disabledSpecials.includes(item.name)) currentOverrides.disabledSpecials.push(item.name);
      saveOverrides();
    };
    specialsListEl.appendChild(createResourceToggleItem('special', item.name, !isDisabled, onToggle, false, false, isRainyOnly, hasTimeRules));
  });
  
  const leagues = Object.keys(masterSettings.leaguesByName || {});
  const leaguesListEl = document.getElementById("da-override-leagues-list");
  leagues.forEach(name => {
    const isDisabled = currentOverrides.leagues.includes(name);
    const onToggle = (isEnabled) => {
      if (isEnabled) currentOverrides.leagues = currentOverrides.leagues.filter(l => l !== name);
      else if (!currentOverrides.leagues.includes(name)) currentOverrides.leagues.push(name);
      saveOverrides();
    };
    leaguesListEl.appendChild(createResourceToggleItem('league', name, !isDisabled, onToggle));
  });
  
  const specialtyLeagues = Object.values(masterSettings.specialtyLeagues || {}).map(l => l.name).sort();
  const specialtyLeaguesListEl = document.getElementById("da-override-specialty-leagues-list");
  specialtyLeagues.forEach(name => {
    const isDisabled = currentOverrides.disabledSpecialtyLeagues.includes(name);
    const onToggle = (isEnabled) => {
      if (isEnabled) currentOverrides.disabledSpecialtyLeagues = currentOverrides.disabledSpecialtyLeagues.filter(l => l !== name);
      else if (!currentOverrides.disabledSpecialtyLeagues.includes(name)) currentOverrides.disabledSpecialtyLeagues.push(name);
      window.saveCurrentDailyData("disabledSpecialtyLeagues", currentOverrides.disabledSpecialtyLeagues);
    };
    specialtyLeaguesListEl.appendChild(createResourceToggleItem('specialty_league', name, !isDisabled, onToggle));
  });
  
  renderOverrideDetailPane();
}

function createResourceToggleItem(type, name, isEnabled, onToggle, isOutdoor = false, isRainyDisabled = false, isRainyOnly = false, hasTimeRules = false) {
  const el = document.createElement('div');
  el.className = 'da-resource-item' + (selectedOverrideId === type + '-' + name ? ' selected' : '');
  if (isRainyDisabled) el.style.opacity = '0.6';
  
  let badges = '';
  if (isOutdoor) badges += '<span class="da-badge da-badge-outdoor">🌳 Outdoor</span>';
  else if (type === 'field') badges += '<span class="da-badge da-badge-indoor">🏠 Indoor</span>';
  if (isRainyOnly) badges += '<span class="da-badge da-badge-rainy">🌧️ Rainy</span>';
  if (hasTimeRules) badges += '<span class="da-badge da-badge-time">⏰ Time Rules</span>';
  
  el.innerHTML = `
    <span class="da-resource-name">${name}${badges}</span>
    <label class="da-switch">
      <input type="checkbox" ${isEnabled ? 'checked' : ''} ${isRainyDisabled ? 'disabled' : ''}>
      <span class="da-switch-slider"></span>
    </label>
  `;
  
  el.querySelector('.da-resource-name').onclick = () => {
    selectedOverrideId = type + '-' + name;
    renderResourceOverridesUI();
  };
  
  el.querySelector('input').onchange = (e) => {
    e.stopPropagation();
    onToggle(e.target.checked);
  };
  
  return el;
}

function renderOverrideDetailPane() {
  const paneEl = document.getElementById("da-override-detail-pane");
  if (!paneEl) return;
  
  if (!selectedOverrideId) {
    paneEl.innerHTML = '<p style="color:#94a3b8;">Select an item to edit details and set time-based availability.</p>';
    return;
  }
  
  const [type, ...nameParts] = selectedOverrideId.split('-');
  const name = nameParts.join('-');
  
  if (type === 'field' || type === 'special') {
    const item = type === 'field' 
      ? (masterSettings.app1?.fields || []).find(f => f.name === name)
      : (masterSettings.app1?.specialActivities || []).find(s => s.name === name);
    
    if (!item) { paneEl.innerHTML = '<p style="color:#ef4444;">Item not found.</p>'; return; }
    
    // Get global rules from setup and daily rules
    const globalRules = item.timeRules || [];
    if (!currentOverrides.dailyFieldAvailability[name]) {
      currentOverrides.dailyFieldAvailability[name] = [];
    }
    const dailyRules = currentOverrides.dailyFieldAvailability[name];
    
    paneEl.innerHTML = `
      <h4 style="margin:0 0 12px;display:flex;align-items:center;gap:8px;">
        ${name}
        ${type === 'field' ? (item.rainyDayAvailable ? '<span class="da-badge da-badge-indoor">🏠 Indoor</span>' : '<span class="da-badge da-badge-outdoor">🌳 Outdoor</span>') : ''}
      </h4>
      
      <div class="da-detail-section">
        <h5>📋 Global Rules (from Setup)</h5>
        <div id="da-global-rules-list"></div>
      </div>
      
      <div class="da-detail-section">
        <h5>📅 Today's Time Rules</h5>
        <p class="da-section-desc">Add custom availability windows for today only. These override global rules.</p>
        <div id="da-daily-rules-list"></div>
        
        <div class="da-time-rule-form">
          <select id="da-rule-type" class="da-select da-select-sm">
            <option value="Available">✅ Available</option>
            <option value="Unavailable">❌ Unavailable</option>
          </select>
          <span style="color:#64748b;">from</span>
          <input id="da-rule-start" placeholder="9:00am" class="da-input da-input-sm" style="width:80px;">
          <span style="color:#64748b;">to</span>
          <input id="da-rule-end" placeholder="10:00am" class="da-input da-input-sm" style="width:80px;">
          <button id="da-add-rule-btn" class="da-btn da-btn-primary da-btn-sm">Add</button>
        </div>
      </div>
      
      ${type === 'field' ? `
      <div class="da-detail-section">
        <h5>🏃 Sports Availability</h5>
        <p class="da-section-desc">Disable specific sports on this field for today.</p>
        <div id="da-sports-checkboxes"></div>
      </div>
      ` : ''}
    `;
    
    // Render global rules
    const globalRulesEl = document.getElementById('da-global-rules-list');
    if (globalRules.length === 0) {
      globalRulesEl.innerHTML = '<p style="color:#94a3b8;font-size:12px;margin:4px 0;">Available all day (no restrictions)</p>';
    } else {
      globalRulesEl.innerHTML = globalRules.map(rule => `
        <div class="da-rule-item da-rule-${rule.type.toLowerCase()}">
          <span class="da-rule-type">${rule.type === 'Available' ? '✅' : '❌'} ${rule.type}</span>
          <span class="da-rule-time">${rule.start} - ${rule.end}</span>
        </div>
      `).join('');
    }
    
    // Render daily rules
    const dailyRulesEl = document.getElementById('da-daily-rules-list');
    if (dailyRules.length === 0) {
      dailyRulesEl.innerHTML = '<p style="color:#94a3b8;font-size:12px;margin:4px 0;">No daily overrides - using global rules</p>';
    } else {
      dailyRulesEl.innerHTML = dailyRules.map((rule, idx) => `
        <div class="da-rule-item da-rule-${rule.type.toLowerCase()} da-rule-daily">
          <span class="da-rule-type">${rule.type === 'Available' ? '✅' : '❌'} ${rule.type}</span>
          <span class="da-rule-time">${rule.start} - ${rule.end}</span>
          <button class="da-rule-remove" data-idx="${idx}">✕</button>
        </div>
      `).join('');
      
      // Add remove handlers
      dailyRulesEl.querySelectorAll('.da-rule-remove').forEach(btn => {
        btn.onclick = () => {
          const idx = parseInt(btn.dataset.idx);
          dailyRules.splice(idx, 1);
          currentOverrides.dailyFieldAvailability[name] = dailyRules;
          window.saveCurrentDailyData("dailyFieldAvailability", currentOverrides.dailyFieldAvailability);
          renderOverrideDetailPane();
        };
      });
    }
    
    // Add rule handler
    document.getElementById('da-add-rule-btn').onclick = () => {
      const ruleType = document.getElementById('da-rule-type').value;
      const start = document.getElementById('da-rule-start').value.trim();
      const end = document.getElementById('da-rule-end').value.trim();
      
      if (!start || !end) { alert('Please enter start and end times.'); return; }
      const startMin = parseTimeToMinutes(start);
      const endMin = parseTimeToMinutes(end);
      if (startMin === null || endMin === null) { alert('Invalid time format. Use format like 9:00am or 2:30pm'); return; }
      if (startMin >= endMin) { alert('End time must be after start time.'); return; }
      
      dailyRules.push({ type: ruleType, start, end });
      currentOverrides.dailyFieldAvailability[name] = dailyRules;
      window.saveCurrentDailyData("dailyFieldAvailability", currentOverrides.dailyFieldAvailability);
      renderOverrideDetailPane();
      renderResourceOverridesUI();
    };
    
    // Render sports checkboxes for fields
    if (type === 'field') {
      const sports = item.activities || [];
      const checkboxesEl = document.getElementById('da-sports-checkboxes');
      if (sports.length === 0) {
        checkboxesEl.innerHTML = '<p style="color:#94a3b8;font-size:12px;">No sports assigned to this field.</p>';
      } else {
        const disabledToday = currentOverrides.dailyDisabledSportsByField[name] || [];
        checkboxesEl.innerHTML = '';
        sports.forEach(sport => {
          const isEnabled = !disabledToday.includes(sport);
          const label = document.createElement('label');
          label.className = 'da-sport-checkbox';
          label.innerHTML = `<input type="checkbox" ${isEnabled ? 'checked' : ''}> ${sport}`;
          label.querySelector('input').onchange = (e) => {
            let list = currentOverrides.dailyDisabledSportsByField[name] || [];
            if (e.target.checked) list = list.filter(s => s !== sport);
            else if (!list.includes(sport)) list.push(sport);
            currentOverrides.dailyDisabledSportsByField[name] = list;
            window.saveCurrentDailyData("dailyDisabledSportsByField", currentOverrides.dailyDisabledSportsByField);
          };
          checkboxesEl.appendChild(label);
        });
      }
    }
  } else {
    paneEl.innerHTML = `
      <h4 style="margin:0 0 12px;">${name}</h4>
      <p style="color:#94a3b8;">Use the toggle in the list to enable/disable this ${type === 'league' ? 'league' : 'specialty league'} for today.</p>
    `;
  }
}

// =================================================================
// CSS STYLES
// =================================================================
function getStyles() {
  return `<style>
    /* === DAILY ADJUSTMENTS v5.1 - MERGED STYLES === */
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
    }
    
    .da-container { display:flex; gap:0; height:calc(100vh - 160px); min-height:500px; background:var(--da-bg); border:1px solid var(--da-border); border-radius:12px; overflow:hidden; }
    
    /* Sidebar */
    .da-sidebar { width:180px; min-width:180px; background:var(--da-surface); border-right:1px solid var(--da-border); display:flex; flex-direction:column; }
    .da-sidebar-header { padding:14px; border-bottom:1px solid var(--da-border); background:var(--da-bg); }
    .da-sidebar-header h3 { margin:0; font-size:12px; font-weight:600; color:var(--da-text2); text-transform:uppercase; letter-spacing:0.5px; }
    
    /* Palette */
    .da-palette { flex:1; overflow-y:auto; padding:10px; display:flex; flex-direction:column; gap:4px; }
    .da-tile { padding:8px 10px; border-radius:6px; cursor:grab; font-size:11px; font-weight:600; transition:transform 0.15s, box-shadow 0.15s; }
    .da-tile:hover { transform:translateX(2px); box-shadow:0 2px 8px rgba(0,0,0,0.15); }
    .da-tile:active { cursor:grabbing; }
    .da-tile-divider { height:1px; background:var(--da-border); margin:4px 0; }
    .da-tile-label { font-size:9px; color:var(--da-text3); font-weight:600; text-transform:uppercase; letter-spacing:0.5px; padding:4px 0; }
    
    /* Main */
    .da-main { flex:1; display:flex; flex-direction:column; overflow:hidden; }
    
    /* Subtabs */
    .da-subtabs { display:flex; gap:0; border-bottom:1px solid var(--da-border); background:var(--da-surface); }
    .da-subtab { padding:12px 20px; border:none; background:none; cursor:pointer; font-size:13px; font-weight:500; color:var(--da-text2); border-bottom:2px solid transparent; transition:all 0.2s; }
    .da-subtab:hover { color:var(--da-text); background:rgba(0,0,0,0.02); }
    .da-subtab.active { color:var(--da-accent); border-bottom-color:var(--da-accent); background:var(--da-bg); }
    
    /* Panes */
    .da-pane { display:none; flex:1; overflow:auto; padding:16px; }
    .da-pane.active { display:block; }
    
    /* Toolbar */
    .da-toolbar { display:flex; align-items:center; gap:12px; padding:12px 16px; background:var(--da-surface); border-bottom:1px solid var(--da-border); flex-wrap:wrap; }
    .da-toolbar-group { display:flex; align-items:center; gap:8px; }
    .da-toolbar-label { font-size:12px; color:var(--da-text2); font-weight:500; }
    
    /* Grid */
    .da-grid-wrapper { flex:1; overflow:auto; border:1px solid var(--da-border); border-radius:8px; margin:16px; background:#fff; }
    .da-grid { display:grid; min-width:700px; }
    .da-grid-header { position:sticky; top:0; z-index:10; padding:10px 8px; font-weight:600; font-size:12px; text-align:center; border-bottom:1px solid var(--da-border); background:var(--da-bg); }
    .da-time-header { background:var(--da-surface); }
    .da-time-column { position:relative; background:var(--da-surface); border-right:1px solid var(--da-border); }
    .da-time-marker { position:absolute; left:0; width:100%; font-size:9px; padding:2px 4px; color:var(--da-text3); border-top:1px dashed #e2e8f0; }
    .da-grid-cell { position:relative; border-right:1px solid var(--da-border); background:#fff; }
    .da-grid-disabled { position:absolute; width:100%; background:repeating-linear-gradient(-45deg,#f1f5f9,#f1f5f9 5px,#e2e8f0 5px,#e2e8f0 10px); z-index:1; pointer-events:none; }
    .da-grid-night-zone { background:rgba(30,41,59,0.1) !important; }
    
    /* Events */
    .da-event { position:absolute; width:96%; left:2%; padding:4px 6px; border-radius:4px; cursor:pointer; box-sizing:border-box; display:flex; flex-direction:column; justify-content:center; overflow:hidden; z-index:2; transition:box-shadow 0.15s; min-height:18px; }
    .da-event:hover { box-shadow:0 2px 8px rgba(0,0,0,0.2); z-index:5; }
    .da-event.selected { box-shadow:0 0 0 2px var(--da-accent), 0 4px 12px rgba(59,130,246,0.3); z-index:10; }
    .da-event.da-resizing { box-shadow:0 0 0 2px var(--da-accent), 0 4px 12px rgba(59,130,246,0.25) !important; z-index:100 !important; }
    .da-night-activity { animation:nightGlow 2s ease-in-out infinite alternate; }
    @keyframes nightGlow { from { box-shadow:0 0 8px rgba(233,69,96,0.4); } to { box-shadow:0 0 16px rgba(233,69,96,0.7); } }
    
    /* CONFLICT WARNINGS - More Visible */
    .da-conflict-warn { 
      border:3px solid #dc2626 !important; 
      box-shadow:0 0 0 3px rgba(220,38,38,0.3), 0 0 12px rgba(220,38,38,0.4), inset 0 0 8px rgba(220,38,38,0.1) !important; 
      animation: conflictPulse 1s ease-in-out infinite;
    }
    .da-conflict-notice { 
      border:3px solid #f59e0b !important; 
      box-shadow:0 0 0 3px rgba(245,158,11,0.3), 0 0 12px rgba(245,158,11,0.4), inset 0 0 8px rgba(245,158,11,0.1) !important; 
      animation: conflictPulseWarn 1.5s ease-in-out infinite;
    }
    @keyframes conflictPulse {
      0%, 100% { box-shadow:0 0 0 3px rgba(220,38,38,0.3), 0 0 12px rgba(220,38,38,0.4); }
      50% { box-shadow:0 0 0 5px rgba(220,38,38,0.5), 0 0 20px rgba(220,38,38,0.6); }
    }
    @keyframes conflictPulseWarn {
      0%, 100% { box-shadow:0 0 0 3px rgba(245,158,11,0.3), 0 0 12px rgba(245,158,11,0.4); }
      50% { box-shadow:0 0 0 5px rgba(245,158,11,0.5), 0 0 20px rgba(245,158,11,0.6); }
    }
    
    /* Resize Handles */
    .da-resize-handle { position:absolute; left:0; right:0; height:8px; cursor:ns-resize; z-index:5; opacity:0; transition:opacity 0.15s; }
    .da-resize-top { top:-2px; }
    .da-resize-bottom { bottom:-2px; }
    .da-event:hover .da-resize-handle { opacity:1; background:rgba(59,130,246,0.3); }
    
    /* Drop Preview */
    .da-drop-preview { display:none; position:absolute; left:2%; width:96%; background:rgba(59,130,246,0.15); border:2px dashed var(--da-accent); border-radius:4px; pointer-events:none; z-index:5; }
    .da-preview-time { text-align:center; padding:8px; color:var(--da-accent); font-weight:600; font-size:12px; background:rgba(255,255,255,0.9); border-radius:3px; margin:4px; }
    
    /* Tooltips & Ghosts */
    #da-resize-tooltip { position:fixed; padding:8px 12px; background:#111827; color:#fff; border-radius:6px; font-size:12px; font-weight:600; pointer-events:none; z-index:10002; display:none; box-shadow:0 4px 12px rgba(0,0,0,0.3); text-align:center; }
    #da-resize-tooltip span { font-size:11px; opacity:0.7; }
    #da-drag-ghost { position:fixed; padding:8px 12px; background:#fff; border:2px solid var(--da-accent); border-radius:6px; box-shadow:0 4px 12px rgba(59,130,246,0.25); pointer-events:none; z-index:10001; display:none; font-size:12px; }
    #da-drag-ghost span { color:var(--da-text2); }
    
    /* Buttons */
    .da-btn { padding:8px 14px; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer; border:none; transition:all 0.15s; display:inline-flex; align-items:center; gap:6px; }
    .da-btn-primary { background:var(--da-accent); color:#fff; }
    .da-btn-primary:hover { background:#2563eb; }
    .da-btn-success { background:var(--da-success); color:#fff; }
    .da-btn-success:hover { background:#059669; }
    .da-btn-warning { background:var(--da-warning); color:#fff; }
    .da-btn-warning:hover { background:#d97706; }
    .da-btn-danger { background:var(--da-danger); color:#fff; }
    .da-btn-danger:hover { background:#dc2626; }
    
    /* Modal Styles */
    .da-modal-overlay { position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:99999; backdrop-filter:blur(2px); }
    .da-modal { background:#fff; border-radius:12px; box-shadow:0 20px 50px rgba(0,0,0,0.3); max-width:500px; width:90%; max-height:90vh; overflow:hidden; display:flex; flex-direction:column; }
    .da-modal-header { padding:16px 20px; border-bottom:1px solid #e2e8f0; display:flex; align-items:center; justify-content:space-between; }
    .da-modal-header h3 { margin:0; font-size:16px; font-weight:600; color:#1e293b; }
    .da-modal-close { background:none; border:none; font-size:24px; color:#94a3b8; cursor:pointer; padding:0; line-height:1; }
    .da-modal-close:hover { color:#64748b; }
    .da-modal-body { padding:20px; overflow-y:auto; flex:1; }
    .da-modal-footer { padding:16px 20px; border-top:1px solid #e2e8f0; display:flex; justify-content:flex-end; gap:10px; background:#f8fafc; }
    .da-btn-ghost { background:transparent; color:var(--da-text2); border:1px solid var(--da-border); }
    .da-btn-ghost:hover { background:var(--da-surface); }
    .da-btn-sm { padding:4px 8px; font-size:11px; }
    
    /* Inputs */
    .da-input { padding:8px 12px; border:1px solid var(--da-border); border-radius:6px; font-size:13px; width:100%; box-sizing:border-box; }
    .da-input:focus { outline:none; border-color:var(--da-accent); box-shadow:0 0 0 3px rgba(59,130,246,0.1); }
    .da-select { padding:8px 12px; border:1px solid var(--da-border); border-radius:6px; font-size:13px; background:#fff; cursor:pointer; }
    .da-select:focus { outline:none; border-color:var(--da-accent); }
    
    /* Sections */
    .da-section { background:var(--da-bg); border:1px solid var(--da-border); border-radius:8px; padding:16px; margin-bottom:16px; }
    .da-section-title { margin:0 0 4px; font-size:14px; font-weight:600; color:var(--da-text); }
    .da-section-desc { margin:0 0 16px; font-size:12px; color:var(--da-text3); }
    
    /* Form Grid */
    .da-form-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:12px; }
    .da-form-field { display:flex; flex-direction:column; gap:4px; }
    .da-form-field label { font-size:11px; font-weight:600; color:var(--da-text2); }
    
    /* Chips */
    .da-chip { display:inline-block; padding:4px 10px; border-radius:999px; font-size:12px; cursor:pointer; transition:all 0.15s; }
    .da-chip.selected { color:#fff !important; }
    
    /* Override Items */
    .da-override-item { display:flex; align-items:center; justify-content:space-between; padding:10px 12px; background:var(--da-surface); border:1px solid var(--da-border); border-radius:6px; margin-bottom:6px; }
    
    /* Resource Layout */
    .da-resource-layout { display:flex; gap:20px; flex-wrap:wrap; }
    .da-resource-list { flex:1; min-width:280px; }
    .da-resource-detail { flex:2; min-width:300px; background:var(--da-surface); border:1px solid var(--da-border); border-radius:8px; padding:16px; }
    .da-resource-item { display:flex; align-items:center; justify-content:space-between; padding:8px 10px; background:var(--da-bg); border:1px solid var(--da-border); border-radius:6px; margin-bottom:4px; cursor:pointer; transition:background 0.15s; }
    .da-resource-item:hover { background:var(--da-surface); }
    .da-resource-item.selected { background:#eff6ff; border-color:var(--da-accent); }
    .da-resource-name { font-size:13px; font-weight:500; display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
    
    /* Badges */
    .da-badge { font-size:9px; padding:2px 6px; border-radius:4px; font-weight:500; }
    .da-badge-outdoor { background:#fef3c7; color:#92400e; }
    .da-badge-indoor { background:#d1fae5; color:#065f46; }
    .da-badge-rainy { background:#dbeafe; color:#1e40af; }
    
    /* Switch */
    .da-switch { position:relative; width:36px; height:18px; display:inline-block; }
    .da-switch input { opacity:0; width:0; height:0; }
    .da-switch-slider { position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background:#cbd5e1; border-radius:18px; transition:0.3s; }
    .da-switch-slider:before { position:absolute; content:""; height:12px; width:12px; left:3px; bottom:3px; background:white; border-radius:50%; transition:0.3s; }
    .da-switch input:checked + .da-switch-slider { background:var(--da-success); }
    .da-switch input:checked + .da-switch-slider:before { transform:translateX(18px); }
    .da-switch input:disabled + .da-switch-slider { opacity:0.5; cursor:not-allowed; }
    
    /* Rainy Day Dropdown */
    .da-rainy-dropdown { margin-bottom:16px; border:1px solid var(--da-border); border-radius:10px; overflow:hidden; background:var(--da-surface); transition:all 0.3s; }
    .da-rainy-dropdown.active { border-color:#0ea5e9; box-shadow:0 0 20px rgba(14,165,233,0.15); }
    .da-rainy-dropdown-header { display:flex; align-items:center; justify-content:space-between; padding:12px 16px; cursor:pointer; user-select:none; transition:background 0.15s; }
    .da-rainy-dropdown-header:hover { background:rgba(0,0,0,0.02); }
    .da-rainy-dropdown.active .da-rainy-dropdown-header { background:linear-gradient(135deg,#1e3a5f,#0c4a6e); }
    .da-rainy-dropdown-title { display:flex; align-items:center; gap:10px; font-weight:600; font-size:14px; color:var(--da-text); }
    .da-rainy-dropdown.active .da-rainy-dropdown-title { color:#f0f9ff; }
    .da-rainy-dropdown-icon { font-size:18px; }
    .da-rainy-dropdown-arrow { color:var(--da-text3); font-size:10px; transition:transform 0.2s; }
    .da-rainy-dropdown.active .da-rainy-dropdown-arrow { color:#7dd3fc; }
    .da-rainy-active-badge { background:rgba(14,165,233,0.2); color:#0ea5e9; padding:2px 8px; border-radius:999px; font-size:10px; font-weight:600; animation:pulse 2s infinite; }
    .da-rainy-dropdown.active .da-rainy-active-badge { background:rgba(255,255,255,0.15); color:#7dd3fc; }
    @keyframes pulse { 0%, 100% { opacity:1; } 50% { opacity:0.6; } }
    .da-rainy-dropdown-content { border-top:1px solid var(--da-border); }
    .da-rainy-dropdown.active .da-rainy-dropdown-content { border-top-color:rgba(255,255,255,0.1); }
    
    /* Rainy Day Panel */
    .da-rainy-card { border-radius:0; overflow:hidden; transition:all 0.4s; position:relative; min-height:120px; }
    .da-rainy-card.inactive { background:linear-gradient(135deg,#fefce8 0%,#fef9c3 50%,#fef08a 100%); }
    .da-rainy-card.active { background:linear-gradient(135deg,#0c4a6e 0%,#164e63 50%,#1e3a5f 100%); }
    .da-rainy-header { padding:16px 18px; display:flex; justify-content:space-between; align-items:center; position:relative; z-index:1; }
    .da-rainy-title-section { display:flex; align-items:center; gap:12px; }
    .da-rainy-icon { width:48px; height:48px; border-radius:12px; display:flex; align-items:center; justify-content:center; font-size:24px; transition:all 0.3s; }
    .da-rainy-card.inactive .da-rainy-icon { background:rgba(251,191,36,0.2); }
    .da-rainy-card.active .da-rainy-icon { background:rgba(14,165,233,0.3); animation:iconPulse 2s infinite; }
    @keyframes iconPulse { 0%, 100% { transform:scale(1); } 50% { transform:scale(1.05); } }
    .da-rainy-title { font-size:16px; font-weight:700; margin:0; }
    .da-rainy-card.inactive .da-rainy-title { color:#92400e; }
    .da-rainy-card.active .da-rainy-title { color:#f0f9ff; }
    .da-rainy-subtitle { font-size:12px; margin:3px 0 0; }
    .da-rainy-card.inactive .da-rainy-subtitle { color:#a16207; }
    .da-rainy-card.active .da-rainy-subtitle { color:#7dd3fc; }
    .da-rainy-toggle-container { display:flex; align-items:center; gap:10px; }
    
    /* Big Toggle Switch */
    .da-rainy-toggle { position:relative; width:70px; height:34px; cursor:pointer; display:block; }
    .da-rainy-toggle input { opacity:0; width:0; height:0; position:absolute; }
    .da-rainy-toggle-track { position:absolute; top:0; left:0; right:0; bottom:0; background:linear-gradient(135deg,#fbbf24,#f59e0b); border-radius:34px; transition:all 0.4s; overflow:hidden; box-shadow:inset 0 2px 4px rgba(0,0,0,0.1); }
    .da-rainy-toggle input:checked + .da-rainy-toggle-track { background:linear-gradient(135deg,#0ea5e9,#06b6d4); }
    .da-rainy-toggle-label-off, .da-rainy-toggle-label-on { position:absolute; top:50%; transform:translateY(-50%); font-size:9px; font-weight:700; text-transform:uppercase; transition:opacity 0.3s; }
    .da-rainy-toggle-label-off { right:8px; color:rgba(255,255,255,0.9); }
    .da-rainy-toggle-label-on { left:8px; color:rgba(255,255,255,0.9); opacity:0; }
    .da-rainy-toggle input:checked + .da-rainy-toggle-track .da-rainy-toggle-label-off { opacity:0; }
    .da-rainy-toggle input:checked + .da-rainy-toggle-track .da-rainy-toggle-label-on { opacity:1; }
    .da-rainy-toggle-thumb { position:absolute; top:3px; left:3px; width:28px; height:28px; background:white; border-radius:50%; transition:all 0.4s cubic-bezier(0.68, -0.55, 0.265, 1.55); display:flex; align-items:center; justify-content:center; font-size:14px; z-index:2; box-shadow:0 2px 5px rgba(0,0,0,0.2); }
    .da-rainy-toggle input:checked ~ .da-rainy-toggle-thumb { left:39px; }
    .da-rainy-toggle-thumb::before { content:'☀️'; }
    .da-rainy-toggle input:checked ~ .da-rainy-toggle-thumb::before { content:'🌧️'; }
    
    /* Stats Section */
    .da-rainy-stats { padding:12px 18px 16px; display:flex; gap:12px; flex-wrap:wrap; position:relative; z-index:1; }
    .da-rainy-stat { display:flex; align-items:center; gap:6px; font-size:12px; padding:6px 12px; border-radius:8px; background:rgba(255,255,255,0.1); }
    .da-rainy-card.inactive .da-rainy-stat { color:#78350f; background:rgba(255,255,255,0.5); }
    .da-rainy-card.inactive .da-rainy-stat strong { color:#451a03; font-size:16px; }
    .da-rainy-card.active .da-rainy-stat { color:#bae6fd; background:rgba(255,255,255,0.1); }
    .da-rainy-card.active .da-rainy-stat strong { color:#f0f9ff; font-size:16px; }
    .da-rainy-stat.available { background:rgba(34,197,94,0.2); border:1px solid rgba(34,197,94,0.3); }
    .da-rainy-card.active .da-rainy-stat.available { color:#86efac; }
    .da-rainy-stat.highlight { background:rgba(14,165,233,0.3); border:1px solid rgba(14,165,233,0.4); }
    .da-rainy-card.active .da-rainy-stat.highlight { color:#7dd3fc; }
    .da-rainy-stat.disabled { background:rgba(239,68,68,0.2); border:1px solid rgba(239,68,68,0.3); }
    .da-rainy-card.active .da-rainy-stat.disabled { color:#fca5a5; }
    .da-rainy-stat.disabled strong { color:#fca5a5 !important; }
    
    /* Settings Section */
    .da-rainy-settings-toggle { padding:0 18px 12px; position:relative; z-index:1; }
    .da-rainy-settings-btn { padding:6px 12px; background:rgba(0,0,0,0.1); border:1px solid rgba(0,0,0,0.1); border-radius:6px; color:#64748b; cursor:pointer; font-size:12px; transition:all 0.2s; }
    .da-rainy-card.inactive .da-rainy-settings-btn { background:rgba(255,255,255,0.5); color:#78350f; }
    .da-rainy-card.inactive .da-rainy-settings-btn:hover { background:rgba(255,255,255,0.8); }
    .da-rainy-card.active .da-rainy-settings-btn { color:#e0f2fe; background:rgba(255,255,255,0.1); border-color:rgba(255,255,255,0.2); }
    .da-rainy-card.active .da-rainy-settings-btn:hover { background:rgba(255,255,255,0.2); }
    
    .da-rainy-midday-info { display:flex; gap:8px; padding:0 18px 12px; position:relative; z-index:1; flex-wrap:wrap; }
    .da-rainy-midday-badge { padding:4px 10px; background:rgba(245,158,11,0.2); border:1px solid rgba(245,158,11,0.3); border-radius:999px; font-size:11px; font-weight:600; color:#fbbf24; }
    .da-rainy-preserved-badge { padding:4px 10px; background:rgba(34,197,94,0.2); border:1px solid rgba(34,197,94,0.3); border-radius:999px; font-size:11px; font-weight:600; color:#4ade80; }
    .da-rainy-cutshort-badge { padding:4px 10px; background:rgba(251,191,36,0.2); border:1px solid rgba(251,191,36,0.3); border-radius:999px; font-size:11px; font-weight:600; color:#fbbf24; }
    .da-rainy-cleared-badge { padding:4px 10px; background:rgba(239,68,68,0.2); border:1px solid rgba(239,68,68,0.3); border-radius:999px; font-size:11px; font-weight:600; color:#f87171; }
    .da-rainy-settings-panel { padding:14px 18px; border-top:1px solid rgba(255,255,255,0.1); position:relative; z-index:1; }
    .da-rainy-card.inactive .da-rainy-settings-panel { border-top-color:#e2e8f0; background:rgba(255,255,255,0.5); }
    .da-rainy-card.active .da-rainy-settings-panel { background:rgba(0,0,0,0.2); }
    .da-rainy-settings-row { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; gap:10px; }
    .da-rainy-settings-row:last-child { margin-bottom:0; }
    .da-rainy-settings-label { font-size:13px; font-weight:500; }
    .da-rainy-card.inactive .da-rainy-settings-label { color:#78350f; }
    .da-rainy-card.active .da-rainy-settings-label { color:#e0f2fe; }
    .da-rainy-settings-sublabel { font-size:11px; opacity:0.7; }
    .da-mini-toggle { position:relative; width:36px; height:18px; cursor:pointer; display:inline-block; }
    .da-mini-toggle input { opacity:0; width:0; height:0; }
    .da-mini-track { position:absolute; top:0; left:0; right:0; bottom:0; background:#d1d5db; border-radius:18px; transition:0.3s; }
    .da-mini-toggle input:checked + .da-mini-track { background:#10b981; }
    .da-mini-thumb { position:absolute; top:2px; left:2px; width:14px; height:14px; background:white; border-radius:50%; transition:0.3s; }
    .da-mini-toggle input:checked ~ .da-mini-thumb { left:20px; }
    .da-rain-container { position:absolute; top:0; left:0; right:0; bottom:0; overflow:hidden; pointer-events:none; opacity:0; transition:opacity 0.5s; }
    .da-rainy-card.active .da-rain-container { opacity:1; }
    .da-rain-drop { position:absolute; top:-30px; width:2px; background:linear-gradient(to bottom,transparent 0%,rgba(186,230,253,0.6) 50%,rgba(125,211,252,0.8) 100%); animation:daRainFall linear infinite; border-radius:0 0 2px 2px; }
    @keyframes daRainFall { 
      0% { transform:translateY(-30px); opacity:0; } 
      5% { opacity:1; } 
      95% { opacity:0.8; } 
      100% { transform:translateY(200px); opacity:0; } 
    }
    
    /* Notifications */
    .da-notif { position:fixed; top:80px; right:20px; padding:14px 18px; border-radius:12px; z-index:10000; display:flex; align-items:center; gap:10px; font-weight:500; font-size:13px; transform:translateX(120%); opacity:0; transition:all 0.35s cubic-bezier(0.4,0,0.2,1); box-shadow:0 8px 24px rgba(0,0,0,0.2); }
    .da-notif.show { transform:translateX(0); opacity:1; }
    .da-notif-rainy { background:linear-gradient(135deg,#0c4a6e,#164e63); color:#f0f9ff; border:1px solid rgba(14,165,233,0.4); }
    .da-notif-sunny { background:linear-gradient(135deg,#fef3c7,#fef9c3); color:#92400e; border:1px solid #fbbf24; }
    .da-notif-icon { font-size:20px; }
    .da-notif-title { font-weight:600; font-size:13px; }
    .da-notif-subtitle { font-size:11px; opacity:0.85; margin-top:2px; }
    
    /* Displaced Panel */
    .da-displaced-panel { background:#fffbeb; border:1px solid #fbbf24; border-radius:8px; padding:12px; margin-bottom:16px; }
    .da-displaced-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
    .da-displaced-header strong { color:#b45309; }
    .da-displaced-list { max-height:100px; overflow-y:auto; }
    .da-displaced-item { background:#fff; padding:6px 10px; margin-bottom:4px; border-radius:4px; font-size:12px; border-left:3px solid #fbbf24; }
    
    /* Rainy Banner */
    .da-rainy-banner { background:linear-gradient(135deg,#0c4a6e,#164e63); color:#f0f9ff; padding:12px 16px; border-radius:10px; margin-bottom:16px; display:flex; align-items:center; gap:10px; }
    .da-rainy-banner span { font-size:18px; }
    .da-rainy-banner strong { font-size:13px; }
    
    /* Empty State */
    .da-empty-state { padding:40px; text-align:center; color:var(--da-text3); }
    
    /* Time Rules Styling */
    .da-detail-section { margin-bottom:20px; }
    .da-detail-section h5 { margin:0 0 8px; font-size:13px; font-weight:600; color:var(--da-text); }
    .da-rule-item { display:flex; align-items:center; gap:10px; padding:8px 12px; background:var(--da-bg); border:1px solid var(--da-border); border-radius:6px; margin-bottom:4px; font-size:12px; }
    .da-rule-available { border-left:3px solid #10b981; }
    .da-rule-unavailable { border-left:3px solid #ef4444; }
    .da-rule-daily { background:#fffbeb; border-color:#fcd34d; }
    .da-rule-type { font-weight:600; min-width:100px; }
    .da-rule-time { color:var(--da-text2); }
    .da-rule-remove { background:none; border:none; color:#ef4444; cursor:pointer; font-size:14px; margin-left:auto; padding:2px 6px; border-radius:4px; }
    .da-rule-remove:hover { background:rgba(239,68,68,0.1); }
    .da-time-rule-form { display:flex; align-items:center; gap:8px; margin-top:12px; padding:12px; background:var(--da-surface); border-radius:8px; flex-wrap:wrap; }
    .da-input-sm { padding:6px 10px; font-size:12px; }
    .da-select-sm { padding:6px 10px; font-size:12px; }
    .da-sport-checkbox { display:flex; align-items:center; gap:8px; margin:6px 0; cursor:pointer; font-size:13px; }
    .da-sport-checkbox input { width:16px; height:16px; cursor:pointer; }
    
    /* Badge for time rules */
    .da-badge-time { background:#dbeafe; color:#1d4ed8; }
  </style>`;
}

// =================================================================
// MAIN HTML
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
// SUBTAB NAVIGATION
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
// KEYBOARD HANDLER
// =================================================================
function setupKeyboardHandler() {
  if (_keyHandler) document.removeEventListener('keydown', _keyHandler);
  
  _keyHandler = (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedTileId) {
      e.preventDefault();
      (async () => {
        const ok = await daShowConfirm("Delete this block?", { danger: true, confirmText: 'Delete' });
        if (ok) {
          dailyOverrideSkeleton = dailyOverrideSkeleton.filter(x => x.id !== selectedTileId);
          selectedTileId = null;
          saveDailySkeleton();
          renderGrid();
        }
      })();
    }
    if (e.key === 'Escape') {
      deselectAllTiles();
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

function refreshFromCloud() {
  masterSettings.global = window.loadGlobalSettings?.() || {};
  masterSettings.app1 = masterSettings.global.app1 || {};
  masterSettings.leaguesByName = masterSettings.global.leaguesByName || {};
  masterSettings.specialtyLeagues = masterSettings.global.specialtyLeagues || {};
  loadDailySkeleton();
  loadCurrentOverrides();
  renderGrid();
  renderResourceOverridesUI();
}

function loadCurrentOverrides() {
  const dailyData = window.loadCurrentDailyData?.() || {};
  const dailyOverrides = dailyData.overrides || {};
  currentOverrides.dailyFieldAvailability = dailyData.dailyFieldAvailability || {};
  currentOverrides.leagues = dailyOverrides.leagues || [];
  currentOverrides.disabledSpecialtyLeagues = dailyData.disabledSpecialtyLeagues || [];
  currentOverrides.dailyDisabledSportsByField = dailyData.dailyDisabledSportsByField || {};
  currentOverrides.disabledFields = dailyOverrides.disabledFields || [];
  currentOverrides.disabledSpecials = dailyOverrides.disabledSpecials || [];
  currentOverrides.bunkActivityOverrides = dailyData.bunkActivityOverrides || [];
}

// =================================================================
// MAIN INIT
// =================================================================
function init() {
  container = document.getElementById("daily-adjustments-content");
  if (!container) { console.error("Daily Adjustments: container not found"); return; }
  
  masterSettings.global = window.loadGlobalSettings?.() || {};
  masterSettings.app1 = masterSettings.global.app1 || {};
  masterSettings.leaguesByName = masterSettings.global.leaguesByName || {};
  masterSettings.specialtyLeagues = masterSettings.global.specialtyLeagues || {};
  smartTileHistory = loadSmartTileHistory();
  
  loadCurrentOverrides();
  
  // Initialize window.isRainyDay from loaded daily data
  const dailyData = window.loadCurrentDailyData?.() || {};
  if (window.isRainyDay === undefined) {
    // Only set if not already defined (e.g., from another module)
    window.isRainyDay = dailyData.isRainyDay === true || dailyData.rainyDayMode === true;
  }
  console.log("[DailyAdj] Initialized window.isRainyDay =", window.isRainyDay);
  
  container.innerHTML = getStyles() + getMainHTML();
  
  setupSubTabs();
  setupKeyboardHandler();
  setupVisibilityHandler();
  
  loadDailySkeleton();
  
  renderPalette();
  renderRainyDayPanel();
  renderDisplacedTilesPanel();
  renderToolbar();
  renderGrid();
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

})();
