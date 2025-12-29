// =================================================================
// daily_adjustments.js  (v3.5 - Updated: Mobile Touch Support)
// - Grid/tiles EXACTLY match master_schedule_builder.js
// - Professional Rainy Day Mode toggle with animations
// - ★ NEW: Mid-day rainy mode (preserve morning schedule)
// - ★ NEW: Auto-skeleton switch (swap to rainy day template)
// - Drag-to-reposition with live preview
// - Resize handles on tiles (drag edges)
// - Conflict highlighting using styles.css palette
// - Displaced tiles panel
// - Full Bunk-Specific Overrides UI
// - Full Resource Availability with Detail Pane
// - Smart Tiles passed to Core Optimizer for capacity awareness
// - Integration with getPinnedTileDefaultLocation for Pinned Events
// - ★ UPDATED: Mobile Touch Support for Drag & Drop
// =================================================================
(function() {
'use strict';

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
const SMART_TILE_HISTORY_KEY = "smartTileHistory_v1";

function loadSmartTileHistory() {
  try {
    // ⭐ Try cloud-synced version first
    const g = window.loadGlobalSettings?.() || {};
    if (g.smartTileHistory && g.smartTileHistory.byBunk) {
      return g.smartTileHistory;
    }
    
    // Fallback to localStorage
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
    // Save to localStorage for immediate access
    if (window.localStorage) {
      localStorage.setItem(SMART_TILE_HISTORY_KEY, JSON.stringify(history || { byBunk: {} }));
    }
    
    // ⭐ Also save to global settings for cloud sync
    window.saveGlobalSettings?.("smartTileHistory", history || { byBunk: {} });
  } catch (e) {
    console.error("Failed to save smart tile history:", e);
  }
}

let skeletonContainer = null;
let tripsFormContainer = null;
let bunkOverridesContainer = null;
let resourceOverridesContainer = null;
let activeSubTab = 'skeleton';

// =================================================================
// SKELETON EDITOR - EXACT COPY FROM master_schedule_builder.js
// =================================================================
let dailyOverrideSkeleton = [];
const PIXELS_PER_MINUTE = 2;
const INCREMENT_MINS = 30;
const SNAP_MINS = 5;

// TILES - EXACT copy from master_schedule_builder.js
const TILES = [
  { type: 'activity', name: 'Activity', style: 'background:#e0f7fa;border:1px solid #007bff;', description: 'Flexible slot (Sport or Special).' },
  { type: 'sports', name: 'Sports', style: 'background:#dcedc8;border:1px solid #689f38;', description: 'Sports slot only.' },
  { type: 'special', name: 'Special Activity', style: 'background:#e8f5e9;border:1px solid #43a047;', description: 'Special Activity slot only.' },
  { type: 'smart', name: 'Smart Tile', style: 'background:#e3f2fd;border:2px dashed #0288d1;color:#01579b;', description: 'Balances 2 activities with a fallback.' },
  { type: 'split', name: 'Split Activity', style: 'background:#fff3e0;border:1px solid #f57c00;', description: 'Two activities share the block (Switch halfway).' },
  { type: 'elective', name: 'Elective', style: 'background:#e1bee7;border:2px solid #8e24aa;color:#4a148c;', description: 'Reserve multiple activities for this division only.' },
  { type: 'league', name: 'League Game', style: 'background:#d1c4e9;border:1px solid #5e35b1;', description: 'Regular League slot (Full Buyout).' },
  { type: 'specialty_league', name: 'Specialty League', style: 'background:#fff8e1;border:1px solid #f9a825;', description: 'Specialty League slot (Full Buyout).' },
  { type: 'swim', name: 'Swim', style: 'background:#bbdefb;border:1px solid #1976d2;', description: 'Pinned.' },
  { type: 'lunch', name: 'Lunch', style: 'background:#fbe9e7;border:1px solid #d84315;', description: 'Pinned.' },
  { type: 'snacks', name: 'Snacks', style: 'background:#fff9c4;border:1px solid #fbc02d;', description: 'Pinned.' },
  { type: 'dismissal', name: 'Dismissal', style: 'background:#f44336;color:white;border:1px solid #b71c1c;', description: 'Pinned.' },
  { type: 'custom', name: 'Custom Pinned Event', style: 'background:#eee;border:1px solid #616161;', description: 'Pinned custom (e.g., Regroup).' }
];

// =================================================================
// RAINY DAY MODE - UI Components (Enhanced with Mid-Day & Auto-Skeleton)
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

function renderRainyDayToggle() {
  const isActive = isRainyDayActive();
  const isMidDay = isMidDayModeActive();
  const midDayStartTime = getMidDayStartTime();
  const preservedSlots = getPreservedSlotCount();
  const stats = getRainyDayStats();
  const autoSwitch = isAutoSkeletonSwitchEnabled();
  const rainySkeletonName = getRainyDaySkeletonName();
  const availableSkeletons = getAvailableSkeletons();
    
  // Generate rain drops for animation
  let rainDrops = '';
  for (let i = 0; i < 18; i++) {
    const left = Math.random() * 100;
    const delay = Math.random() * 2;
    const duration = 0.7 + Math.random() * 0.4;
    const height = 12 + Math.random() * 18;
    rainDrops += `<div class="rain-drop" style="left: ${left}%; animation-delay: ${delay}s; animation-duration: ${duration}s; height: ${height}px;"></div>`;
  }
    
  // Skeleton options
  const skeletonOptions = availableSkeletons.map(name => 
    `<option value="${name}" ${name === rainySkeletonName ? 'selected' : ''}>${name}</option>`
  ).join('');
    
  // Mid-day info
  const midDayInfo = isMidDay ? `
    <div class="rainy-midday-info" style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding: 0 20px 12px;">
      <span class="rainy-midday-badge">
        ⏰ Started at ${minutesToTime(midDayStartTime)}
      </span>
      <span class="rainy-preserved-badge">
        📋 ${preservedSlots} slot${preservedSlots !== 1 ? 's' : ''} preserved
      </span>
    </div>
  ` : '';
    
  return `
    <div class="rainy-day-card ${isActive ? 'active' : 'inactive'}" id="rainy-day-card">
      <div class="rain-animation-container">${rainDrops}</div>
        
      <div class="rainy-day-header" style="position: relative; z-index: 1;">
        <div class="rainy-day-title-section">
          <div class="rainy-day-icon">
            ${isActive ? '🌧️' : '☀️'}
          </div>
          <div>
            <h3 class="rainy-day-title">Rainy Day Mode</h3>
            <p class="rainy-day-subtitle">
              ${isActive 
                ? (isMidDay ? 'Mid-day mode — morning schedule preserved' : 'Indoor schedule active — outdoor fields disabled')
                : 'Normal schedule — all fields available'}
            </p>
          </div>
        </div>
        
        <div class="rainy-toggle-container">
          <button id="rainy-settings-btn" class="rainy-settings-btn" style="display:flex;align-items:center;gap:6px;padding:6px 12px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);border-radius:8px;color:#64748b;cursor:pointer;font-size:0.85rem;margin-right:8px;">
            ⚙️ Settings
          </button>
            
          <span class="rainy-status-badge ${isActive ? 'active' : 'inactive'}">
            <span class="status-dot ${isActive ? 'active' : 'inactive'}"></span>
            ${isActive ? (isMidDay ? 'MID-DAY' : 'ACTIVE') : 'INACTIVE'}
          </span>
            
          <label class="rainy-toggle">
            <input type="checkbox" id="rainy-day-toggle-input" ${isActive ? 'checked' : ''}>
            <span class="rainy-toggle-track"></span>
            <span class="rainy-toggle-thumb">
              ${isActive ? '💧' : '☀️'}
            </span>
          </label>
        </div>
      </div>
        
      ${midDayInfo}
        
      <div class="rainy-stats-row" style="position: relative; z-index: 1;">
        <div class="rainy-stat-item">
          <span>🏠</span>
          <strong>${stats.indoorFields}</strong>
          <span>Indoor</span>
        </div>
        <div class="rainy-stat-item">
          <span>🌳</span>
          <strong>${stats.outdoorFields}</strong>
          <span>Outdoor ${isActive ? '(Disabled)' : ''}</span>
        </div>
        <div class="rainy-stat-item">
          <span>🎨</span>
          <strong>${stats.rainySpecials}</strong>
          <span>Rainy Day Activities</span>
        </div>
        ${!isActive ? `
        <div class="rainy-stat-item" style="margin-left:auto;">
          <button id="rainy-midday-btn" class="rainy-midday-btn primary" style="padding:8px 14px;border-radius:8px;font-size:0.85rem;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:8px;border:none;background:linear-gradient(135deg, #f59e0b, #d97706);color:white;">
            ⏰ Start Mid-Day Mode
          </button>
        </div>
        ` : ''}
      </div>
        
      <!-- Settings Panel (Hidden by default) -->
      <div id="rainy-settings-panel" class="rainy-settings-panel" style="position: relative; z-index: 1; display:none;">
        <div class="rainy-settings-row">
          <div>
            <span class="rainy-settings-label">Auto-Switch Skeleton</span>
            <div class="rainy-settings-sublabel">Automatically load rainy day template when activating</div>
          </div>
          <label class="rainy-mini-toggle">
            <input type="checkbox" id="rainy-auto-skeleton-toggle" ${autoSwitch ? 'checked' : ''}>
            <span class="rainy-mini-track"></span>
            <span class="rainy-mini-thumb"></span>
          </label>
        </div>
        
        <div class="rainy-settings-row">
          <div>
            <span class="rainy-settings-label">Rainy Day Skeleton</span>
            <div class="rainy-settings-sublabel">Template to use when rainy mode activates</div>
          </div>
          <select id="rainy-skeleton-select" class="rainy-settings-select" ${!autoSwitch ? 'disabled' : ''}>
            <option value="">-- Select Template --</option>
            ${skeletonOptions}
          </select>
        </div>
      </div>
    </div>
  `;
}

function bindRainyDayToggle() {
  const toggle = document.getElementById('rainy-day-toggle-input');
  const autoSkeletonToggle = document.getElementById('rainy-auto-skeleton-toggle');
  const skeletonSelect = document.getElementById('rainy-skeleton-select');
  const midDayBtn = document.getElementById('rainy-midday-btn');
  const settingsBtn = document.getElementById('rainy-settings-btn');
  const settingsPanel = document.getElementById('rainy-settings-panel');
    
  // Settings button toggle
  if (settingsBtn && settingsPanel) {
    settingsBtn.addEventListener('click', function() {
      const isOpen = settingsPanel.style.display !== 'none';
      settingsPanel.style.display = isOpen ? 'none' : 'block';
      settingsBtn.innerHTML = isOpen ? '⚙️ Settings' : '⚙️ Close Settings';
    });
  }
    
  // Main toggle
  if (toggle) {
    toggle.addEventListener('change', function() {
      const newState = this.checked;
        
      if (newState) {
        activateFullDayRainyMode();
      } else {
        deactivateRainyDayMode();
      }
        
      rerenderRainyDayUI();
      renderResourceOverridesUI();
        
      // IMPORTANT: Re-render the skeleton grid
      const gridEl = document.getElementById("daily-skeleton-grid");
      if (gridEl) renderGrid(gridEl);
    });
  }
    
  // Auto-skeleton toggle
  if (autoSkeletonToggle) {
    autoSkeletonToggle.addEventListener('change', function() {
      setAutoSkeletonSwitch(this.checked);
      rerenderRainyDayUI();
    });
  }
    
  // Skeleton select
  if (skeletonSelect) {
    skeletonSelect.addEventListener('change', function() {
      setRainyDaySkeletonName(this.value || null);
    });
  }
    
  // Mid-day button
  if (midDayBtn && !midDayBtn.disabled) {
    midDayBtn.addEventListener('click', function() {
      if (confirm('Start Mid-Day Mode?\n\nThis will:\n• Preserve current morning schedule\n• Switch to rainy day mode from now onwards\n• Disable outdoor fields')) {
        activateMidDayRainyMode();
        rerenderRainyDayUI();
        renderResourceOverridesUI();
        
        // Re-render the skeleton grid
        const gridEl = document.getElementById("daily-skeleton-grid");
        if (gridEl) renderGrid(gridEl);
      }
    });
  }
}

function rerenderRainyDayUI() {
  const rainyContainer = document.getElementById('rainy-day-container');
  if (rainyContainer) {
    rainyContainer.innerHTML = renderRainyDayToggle();
    bindRainyDayToggle();
  }
}

function activateFullDayRainyMode() {
  const dailyData = window.loadCurrentDailyData?.() || {};
  const overrides = dailyData.overrides || {};
  const stats = getRainyDayStats();
  
  // Store original disabled fields
  if (!dailyData.preRainyDayDisabledFields) {
    window.saveCurrentDailyData?.("preRainyDayDisabledFields", overrides.disabledFields || []);
  }
  
  // Disable outdoor fields
  const existingDisabled = overrides.disabledFields || [];
  const newDisabled = [...new Set([...existingDisabled, ...stats.outdoorFieldNames])];
  
  overrides.disabledFields = newDisabled;
  currentOverrides.disabledFields = newDisabled;
  window.saveCurrentDailyData?.("overrides", overrides);
  window.saveCurrentDailyData?.("rainyDayMode", true);
  window.saveCurrentDailyData?.("rainyDayStartTime", null); // Full day mode
  
  // Auto-switch skeleton if enabled
  let skeletonSwitched = false;
  if (isAutoSkeletonSwitchEnabled()) {
    skeletonSwitched = switchToRainySkeleton();
  }
  
  showRainyDayNotification(true, stats.outdoorFieldNames.length, false, skeletonSwitched);
}

function activateMidDayRainyMode() {
  const dailyData = window.loadCurrentDailyData?.() || {};
  const overrides = dailyData.overrides || {};
  const stats = getRainyDayStats();
  
  // Get current time in minutes
  const now = new Date();
  const currentTimeMin = now.getHours() * 60 + now.getMinutes();
  
  // Store original disabled fields
  if (!dailyData.preRainyDayDisabledFields) {
    window.saveCurrentDailyData?.("preRainyDayDisabledFields", overrides.disabledFields || []);
  }
  
  // Backup preserved schedule
  backupPreservedSchedule(currentTimeMin);
  
  // Disable outdoor fields
  const existingDisabled = overrides.disabledFields || [];
  const newDisabled = [...new Set([...existingDisabled, ...stats.outdoorFieldNames])];
  
  overrides.disabledFields = newDisabled;
  currentOverrides.disabledFields = newDisabled;
  window.saveCurrentDailyData?.("overrides", overrides);
  window.saveCurrentDailyData?.("rainyDayMode", true);
  window.saveCurrentDailyData?.("rainyDayStartTime", currentTimeMin);
  
  // Auto-switch skeleton if enabled
  let skeletonSwitched = false;
  if (isAutoSkeletonSwitchEnabled()) {
    skeletonSwitched = switchToRainySkeleton();
  }
  
  const preservedCount = getPreservedSlotCount();
  showRainyDayNotification(true, stats.outdoorFieldNames.length, true, skeletonSwitched, preservedCount);
}

function backupPreservedSchedule(startTimeMin) {
  const times = window.unifiedTimes || [];
  const schedules = window.scheduleAssignments || {};
  const preserved = [];
  
  // Find slots before the start time
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
  
  // Backup current skeleton
  const dailyData = window.loadCurrentDailyData?.() || {};
  const currentSkeleton = dailyData.manualSkeleton || [];
  if (currentSkeleton.length > 0) {
    window.saveCurrentDailyData?.("preRainyDayManualSkeleton", JSON.parse(JSON.stringify(currentSkeleton)));
  }
  
  // Load rainy skeleton
  window.saveCurrentDailyData?.("manualSkeleton", JSON.parse(JSON.stringify(skeleton)));
  dailyOverrideSkeleton = JSON.parse(JSON.stringify(skeleton));
  window.dailyOverrideSkeleton = dailyOverrideSkeleton;
  
  // Re-render grid
  const gridEl = document.getElementById("daily-skeleton-grid");
  if (gridEl) renderGrid(gridEl);
  
  console.log(`[RainyDay] Loaded rainy day skeleton "${skeletonName}"`);
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
  
  // Restore original skeleton if auto-switch was enabled
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
      
    // Re-render grid
    const gridEl = document.getElementById("daily-skeleton-grid");
    if (gridEl) renderGrid(gridEl);
      
    console.log(`[RainyDay] Restored pre-rainy skeleton`);
    return true;
  }
  return false;
}

function showRainyDayNotification(activated, disabledCount = 0, isMidDay = false, skeletonSwitched = false, preservedCount = 0) {
  const notif = document.createElement('div');
  notif.id = 'rainy-notification';
  notif.style.cssText = `
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
    animation: slideInNotif 0.35s cubic-bezier(0.4, 0, 0.2, 1);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
  `;
  
  if (activated) {
    notif.style.background = 'linear-gradient(135deg, #0c4a6e, #164e63)';
    notif.style.color = '#f0f9ff';
    notif.style.border = '1px solid rgba(14, 165, 233, 0.4)';
    
    let subtitle = `${disabledCount} outdoor field${disabledCount !== 1 ? 's' : ''} disabled`;
    if (isMidDay) {
      subtitle = `${preservedCount} slot${preservedCount !== 1 ? 's' : ''} preserved • ${disabledCount} field${disabledCount !== 1 ? 's' : ''} disabled`;
    }
    if (skeletonSwitched) {
      subtitle += ' • Skeleton switched';
    }
    
    notif.innerHTML = `
      <span style="font-size: 24px;">${isMidDay ? '⏰' : '🌧️'}</span>
      <div>
        <div style="font-weight: 600; font-size: 0.95rem;">${isMidDay ? 'Mid-Day Rainy Mode Activated' : 'Rainy Day Mode Activated'}</div>
        <div style="font-size: 0.8rem; opacity: 0.85; margin-top: 2px;">${subtitle}</div>
      </div>
    `;
  } else {
    notif.style.background = 'linear-gradient(135deg, #fef3c7, #fef9c3)';
    notif.style.color = '#92400e';
    notif.style.border = '1px solid #fbbf24';
    notif.innerHTML = `
      <span style="font-size: 24px;">☀️</span>
      <div>
        <div style="font-weight: 600; font-size: 0.95rem;">Normal Mode Restored</div>
        <div style="font-size: 0.8rem; opacity: 0.85; margin-top: 2px;">All fields back to normal availability</div>
      </div>
    `;
  }
  
  document.body.appendChild(notif);
  
  setTimeout(() => {
    notif.style.transition = 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1);';
    notif.style.transform = 'translateX(120%)';
    notif.style.opacity = '0';
    setTimeout(() => notif.remove(), 300);
  }, 3500);
}

// =================================================================
// FIELD RESERVATION HELPERS
// =================================================================
function promptForReservedFields(eventName) {
  const allFields = (masterSettings.app1.fields || []).map(f => f.name);
  const specialActivities = (masterSettings.app1.specialActivities || []).map(s => s.name);
  const allLocations = [...new Set([...allFields, ...specialActivities])].sort();
  if (allLocations.length === 0) return [];
  
  const fieldInput = prompt(
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
  if (invalid.length > 0) alert("Warning: These fields were not found and will be ignored:\n" + invalid.join(', '));
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

function renderDisplacedTilesPanel() {
  const panel = document.getElementById('displaced-tiles-panel');
  if (!panel) return;
  if (displacedTiles.length === 0) { panel.style.display = 'none'; return; }
  
  panel.style.display = 'block';
  panel.innerHTML = `
    <div style="background:#fff8e1;border:1px solid #ffb300;border-radius:8px;padding:12px;margin-bottom:15px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <strong style="color:#e65100;">📋 Displaced Tiles (${displacedTiles.length})</strong>
        <button id="clear-displaced-btn" style="background:#fff;border:1px solid #ffb300;color:#e65100;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:0.85em;">Clear</button>
      </div>
      <div style="max-height:120px;overflow-y:auto;">
        ${displacedTiles.map(d => `
          <div style="background:#fff;padding:8px 12px;margin-bottom:4px;border-radius:4px;font-size:0.85em;border-left:3px solid ${d.type === 'pinned' ? '#ff5722' : '#ffb300'};">
            <strong>${d.event}</strong> (${d.division}) - ${d.originalStart} - ${d.originalEnd}
          </div>
        `).join('')}
      </div>
    </div>
  `;
  document.getElementById('clear-displaced-btn').onclick = clearDisplacedTiles;
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
  alert(tile.name.toUpperCase() + "\n\n" + desc);
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

function renderPalette(paletteEl) {
  if (!paletteEl) {
    console.error("Palette element not found!");
    return;
  }
  paletteEl.innerHTML = '';
  TILES.forEach(tile => {
    const el = document.createElement('div');
    el.className = 'grid-tile-draggable';
    el.textContent = tile.name;
    el.style.cssText = tile.style;
    el.style.padding = '8px 12px';
    el.style.borderRadius = '5px';
    el.style.cursor = 'grab';
    el.style.userSelect = 'none';
    el.draggable = true;
    el.title = tile.description || 'Click for info';
    
    // Click handler for tile info
    el.onclick = (e) => {
      if (e.detail === 1) { // Single click
        setTimeout(() => {
          if (!el.dragging) {
            showTileInfo(tile);
          }
        }, 200);
      }
    };
    
    el.ondragstart = (e) => { 
      el.dragging = true;
      e.dataTransfer.setData('application/json', JSON.stringify(tile)); 
      e.dataTransfer.effectAllowed = 'copy';
    };
    el.ondragend = () => { el.dragging = false; };

    // MOBILE TOUCH SUPPORT
    let touchStartY = 0;
    el.addEventListener('touchstart', (e) => {
      touchStartY = e.touches[0].clientY;
      el.dataset.tileData = JSON.stringify(tile);
      el.style.opacity = '0.6';
    });
    
    el.addEventListener('touchend', (e) => {
      el.style.opacity = '1';
      const touchEndY = e.changedTouches[0].clientY;
      
      // If minimal movement, treat as click
      if (Math.abs(touchEndY - touchStartY) < 10) {
        showTileInfo(tile);
      }
    });
    
    paletteEl.appendChild(el);
  });
}

// =================================================================
// RENDER GRID
// =================================================================
function renderGrid(gridEl) {
  const divisions = window.divisions || {};
  const availableDivisions = window.availableDivisions || [];
  if (availableDivisions.length === 0) {
    gridEl.innerHTML = `<div style="padding:20px;text-align:center;color:#666;">No divisions found. Please go to Setup to create divisions.</div>`;
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
  const latestPinned = Math.max(-Infinity, ...dailyOverrideSkeleton.map(e => parseTimeToMinutes(e.endTime) || -Infinity));
  if (latestPinned > -Infinity) latestMin = Math.max(latestMin, latestPinned);
  if (latestMin <= earliestMin) latestMin = earliestMin + 60;
  const totalHeight = (latestMin - earliestMin) * PIXELS_PER_MINUTE;
  gridEl.dataset.earliestMin = earliestMin;
  let html = `<div style="display:grid; grid-template-columns:60px repeat(${availableDivisions.length}, 1fr); position:relative; min-width:800px;">`;
  
  html += `<div style="grid-row:1; position:sticky; top:0; background:#fff; z-index:10; border-bottom:1px solid #999; padding:8px; font-weight:bold;">Time</div>`;
  availableDivisions.forEach((divName, i) => {
    const color = divisions[divName]?.color || '#444';
    html += `<div style="grid-row:1; grid-column:${i + 2}; position:sticky; top:0; background:${color}; color:#fff; z-index:10; border-bottom:1px solid #999; padding:8px; text-align:center; font-weight:bold;">${divName}</div>`;
  });
  html += `<div style="grid-row:2; grid-column:1; height:${totalHeight}px; position:relative; background:#f9f9f9; border-right:1px solid #ccc;">`;
  for (let m = earliestMin; m < latestMin; m += INCREMENT_MINS) {
    const top = (m - earliestMin) * PIXELS_PER_MINUTE;
    html += `<div style="position:absolute; top:${top}px; left:0; width:100%; border-top:1px dashed #ddd; font-size:10px; padding:2px; color:#666;">${minutesToTime(m)}</div>`;
  }
  html += `</div>`;
  availableDivisions.forEach((divName, i) => {
    const div = divisions[divName];
    const s = parseTimeToMinutes(div?.startTime);
    const e = parseTimeToMinutes(div?.endTime);
    
    html += `<div class="grid-cell" data-div="${divName}" data-start-min="${earliestMin}" style="grid-row:2; grid-column:${i + 2}; height:${totalHeight}px;">`;
    
    if (s !== null && s > earliestMin) {
      html += `<div class="grid-disabled" style="top:0; height:${(s - earliestMin) * PIXELS_PER_MINUTE}px;"></div>`;
    }
    if (e !== null && e < latestMin) {
      html += `<div class="grid-disabled" style="top:${(e - earliestMin) * PIXELS_PER_MINUTE}px; height:${(latestMin - e) * PIXELS_PER_MINUTE}px;"></div>`;
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
    html += `<div class="drop-preview"></div>`;
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
  const style = tile ? tile.style : 'background:#eee;border:1px solid #666;';
  const adjustedHeight = Math.max(height - 2, 10);
  
  let fontSize, timeSize, layout;
  if (adjustedHeight < 30) {
    fontSize = '0.65rem'; timeSize = '0.55rem'; layout = 'compact';
  } else if (adjustedHeight < 50) {
    fontSize = '0.75rem'; timeSize = '0.65rem'; layout = 'small';
  } else {
    fontSize = '0.85rem'; timeSize = '0.75rem'; layout = 'normal';
  }
  
  let content;
  const eventName = ev.event || 'Event';
  const timeStr = `${ev.startTime}-${ev.endTime}`;
  
  if (layout === 'compact') {
    content = `<span style="font-weight:600;">${eventName}</span> <span style="opacity:0.8;font-size:${timeSize};">${timeStr}</span>`;
  } else if (layout === 'small') {
    content = `<div style="font-weight:600;line-height:1.2;">${eventName}</div><div style="font-size:${timeSize};opacity:0.85;line-height:1.2;">${timeStr}</div>`;
  } else {
    content = `<div style="font-weight:600;line-height:1.3;">${eventName}</div><div style="font-size:${timeSize};opacity:0.85;">${timeStr}</div>`;
    
    // UPDATED: Location rendering with location badge
    const locationDisplay = ev.location || (ev.reservedFields && ev.reservedFields.length > 0 ? ev.reservedFields.join(', ') : null);
    
    if (locationDisplay && adjustedHeight > 60 && ev.type !== 'elective') {
      content += `
        <div class="tile-location-badge" style="font-size:0.7rem;color:#c62828;margin-top:2px;display:flex;align-items:center;gap:3px;">
          <span>📍</span>
          <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${locationDisplay}</span>
        </div>
      `;
    }
    
    if (ev.type === 'elective' && ev.electiveActivities && adjustedHeight > 50) {
      const actList = ev.electiveActivities.slice(0, 4).join(', ');
      const more = ev.electiveActivities.length > 4 ? ` +${ev.electiveActivities.length - 4}` : '';
      content += `<div style="font-size:0.65rem;color:#6a1b9a;margin-top:2px;">🎯 ${actList}${more}</div>`;
    }
    
    if (ev.type === 'smart' && ev.smartData && adjustedHeight > 70) {
      content += `<div style="font-size:0.7rem;opacity:0.8;margin-top:2px;">F: ${ev.smartData.fallbackActivity}</div>`;
    }
  }
  return `<div class="grid-event" data-id="${ev.id}" draggable="true" title="${eventName} (${timeStr}) - Double-click to remove" 
          style="${style} position:absolute; top:${top}px; height:${adjustedHeight}px; width:96%; left:2%; 
          padding:4px 6px; font-size:${fontSize}; overflow:hidden; border-radius:3px; cursor:pointer; 
          box-sizing:border-box; display:flex; flex-direction:column; justify-content:center; 
          text-overflow:ellipsis; line-height:1.2;">
          <div class="resize-handle resize-handle-top"></div>
          ${content}
          <div class="resize-handle resize-handle-bottom"></div>
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
    gridEl.querySelectorAll('.grid-event').forEach(tile => {
      tile.classList.remove('conflict-warn', 'conflict-notice', 'conflict-critical', 'conflict-warning');
    });
    return;
  }
  
  const conflictMap = {};
  conflicts.forEach(c => {
    const severity = c.type;
    if (c.event1?.id) {
      if (!conflictMap[c.event1.id] || severity === 'warn') {
        conflictMap[c.event1.id] = severity;
      }
    }
    if (c.event2?.id) {
      if (!conflictMap[c.event2.id] || severity === 'warn') {
        conflictMap[c.event2.id] = severity;
      }
    }
  });
  
  gridEl.querySelectorAll('.grid-event').forEach(tile => {
    tile.classList.remove('conflict-warn', 'conflict-notice', 'conflict-critical', 'conflict-warning');
    const id = tile.dataset.id;
    const severity = conflictMap[id];
    if (severity) {
      tile.classList.add('conflict-' + severity);
    }
  });
}

window.refreshSkeletonConflicts = function() {
  const grid = document.getElementById('daily-skeleton-grid');
  if (grid) renderGrid(grid);
};

// =================================================================
// EVENT LISTENERS - RESIZE
// =================================================================
function addResizeListeners(gridEl) {
  const earliestMin = parseInt(gridEl.dataset.earliestMin, 10) || 540;
  
  let tooltip = document.getElementById('resize-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'resize-tooltip';
    document.body.appendChild(tooltip);
  }
  
  gridEl.querySelectorAll('.grid-event').forEach(tile => {
    const topHandle = tile.querySelector('.resize-handle-top');
    const bottomHandle = tile.querySelector('.resize-handle-bottom');
    
    [topHandle, bottomHandle].forEach(handle => {
      if (!handle) return;
      const direction = handle.classList.contains('resize-handle-top') ? 'top' : 'bottom';
      let isResizing = false, startY = 0, startTop = 0, startHeight = 0, eventId = null;
      
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        isResizing = true;
        startY = e.clientY;
        startTop = parseInt(tile.style.top, 10);
        startHeight = tile.offsetHeight;
        eventId = tile.dataset.id;
        tile.classList.add('resizing');
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });
      
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
        tile.classList.remove('resizing');
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
        
        event.startTime = minutesToTime(Math.max(divStartMin, Math.round(newStartMin / SNAP_MINS) * SNAP_MINS));
        event.endTime = minutesToTime(Math.min(divEndMin, Math.round(newEndMin / SNAP_MINS) * SNAP_MINS));
        
        saveDailySkeleton();
        renderGrid(gridEl);
      }
      
      handle.addEventListener('dragstart', (e) => { e.preventDefault(); e.stopPropagation(); });
    });
  });
}

// =================================================================
// EVENT LISTENERS - DRAG TO REPOSITION
// =================================================================
function addDragToRepositionListeners(gridEl) {
  const earliestMin = parseInt(gridEl.dataset.earliestMin, 10) || 540;
  
  let ghost = document.getElementById('drag-ghost');
  if (!ghost) {
    ghost = document.createElement('div');
    ghost.id = 'drag-ghost';
    document.body.appendChild(ghost);
  }
  
  let dragData = null;
  
  gridEl.querySelectorAll('.grid-event').forEach(tile => {
    tile.addEventListener('dragstart', (e) => {
      if (e.target.classList.contains('resize-handle')) { e.preventDefault(); return; }
      
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
      gridEl.querySelectorAll('.drop-preview').forEach(p => { p.style.display = 'none'; p.innerHTML = ''; });
      gridEl.querySelectorAll('.grid-cell').forEach(c => c.style.background = '');
    });
  });
  
  gridEl.querySelectorAll('.grid-cell').forEach(cell => {
    const preview = cell.querySelector('.drop-preview');
    
    cell.addEventListener('dragover', (e) => {
      const isEventMove = e.dataTransfer.types.includes('text/event-move');
      const isNewTile = e.dataTransfer.types.includes('application/json');
      if (!isEventMove && !isNewTile) return;
      
      e.preventDefault();
      e.dataTransfer.dropEffect = isEventMove ? 'move' : 'copy';
      cell.style.background = '#e6fffa';
      
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
        preview.innerHTML = `<div class="preview-time-label">${previewStartTime} - ${previewEndTime}</div>`;
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
        renderGrid(gridEl);
        return;
      }
    });
  });
}

// =================================================================
// EVENT LISTENERS - DROP NEW TILES
// =================================================================
function addDropListeners(gridEl) {
  gridEl.querySelectorAll('.grid-cell').forEach(cell => {
    cell.ondragover = (e) => {
      if (e.dataTransfer.types.includes('text/event-move')) return;
      e.preventDefault();
      cell.style.background = '#e6fffa';
    };
    cell.ondragleave = () => { cell.style.background = ''; };
    
    cell.ondrop = (e) => {
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

      const validateTime = (timeStr, isStartTime) => {
        const timeMin = parseTimeToMinutes(timeStr);
        if (timeMin === null) {
          alert("Invalid time format. Please use '9:00am' or '2:30pm'.");
          return null;
        }
        if (divStartMin !== null && timeMin < divStartMin) {
          alert("Error: " + timeStr + " is before this division's start time of " + div.startTime + ".");
          return null;
        }
        if (divEndMin !== null && (isStartTime ? timeMin >= divEndMin : timeMin > divEndMin)) {
          alert("Error: " + timeStr + " is after this division's end time of " + div.endTime + ".");
          return null;
        }
        return timeMin;
      };

      // Handle SMART TILE
      if (tileData.type === 'smart') {
        let startTime, endTime, startMinVal, endMinVal;
        while (true) {
          startTime = prompt("Smart Tile for " + divName + ".\n\nEnter Start Time:", startStr);
          if (!startTime) return;
          startMinVal = validateTime(startTime, true);
          if (startMinVal !== null) break;
        }
        while (true) {
          endTime = prompt("Enter End Time:");
          if (!endTime) return;
          endMinVal = validateTime(endTime, false);
          if (endMinVal !== null) {
            if (endMinVal <= startMinVal) alert("End time must be after start time.");
            else break;
          }
        }
        const rawMains = prompt("Enter the TWO MAIN activities (e.g., Swim / Special):");
        if (!rawMains) return;
        const mains = rawMains.split(/,|\//).map(s => s.trim()).filter(Boolean);
        if (mains.length < 2) { alert("Please enter TWO distinct activities."); return; }
        const [main1, main2] = mains;
        const pick = prompt("Which activity requires a fallback?\n\n1: " + main1 + "\n2: " + main2);
        if (!pick) return;
        let fallbackFor;
        if (pick.trim() === "1" || pick.trim().toLowerCase() === main1.toLowerCase()) fallbackFor = main1;
        else if (pick.trim() === "2" || pick.trim().toLowerCase() === main2.toLowerCase()) fallbackFor = main2;
        else { alert("Invalid choice."); return; }
        const fallbackActivity = prompt("If \"" + fallbackFor + "\" is unavailable, what should be played?\nExample: Sports");
        if (!fallbackActivity) return;
        newEvent = {
          id: 'evt_' + Math.random().toString(36).slice(2, 9),
          type: "smart", event: main1 + " / " + main2, division: divName,
          startTime, endTime, smartData: { main1, main2, fallbackFor, fallbackActivity }
        };
      }
      // Handle SPLIT TILE
      else if (tileData.type === 'split') {
        let startTime, endTime, startMinVal, endMinVal;
        while (true) {
          startTime = prompt("Enter Start Time for the *full* block:", startStr);
          if (!startTime) return;
          startMinVal = validateTime(startTime, true);
          if (startMinVal !== null) break;
        }
        while (true) {
          endTime = prompt("Enter End Time for the *full* block:");
          if (!endTime) return;
          endMinVal = validateTime(endTime, false);
          if (endMinVal !== null) {
            if (endMinVal <= startMinVal) alert("End time must be after start time.");
            else break;
          }
        }
        const eventName1 = prompt("Enter name for FIRST activity (e.g., Swim, Sports):");
        if (!eventName1) return;
        const eventName2 = prompt("Enter name for SECOND activity (e.g., Activity, Sports):");
        if (!eventName2) return;
        const event1 = mapEventNameForOptimizer(eventName1);
        const event2 = mapEventNameForOptimizer(eventName2);
        newEvent = {
          id: 'evt_' + Math.random().toString(36).slice(2, 9),
          type: 'split', event: eventName1 + " / " + eventName2, division: divName,
          startTime, endTime, subEvents: [event1, event2]
        };
      }
      // Handle PINNED tiles (lunch, snacks, custom, dismissal, swim)
      else if (['lunch', 'snacks', 'custom', 'dismissal', 'swim'].includes(tileData.type)) {
        let name = tileData.name;
        let reservedFields = [];
        let defaultLocation = null;

        // NEW: Check global default location logic first
        if (window.getPinnedTileDefaultLocation) {
            defaultLocation = window.getPinnedTileDefaultLocation(tileData.type);
            if (defaultLocation) {
                reservedFields = [defaultLocation];
            }
        }

        if (tileData.type === 'custom') {
          name = prompt("Event Name:", "Regroup"); if (!name) return;
          // Custom prompt overrides default if user enters something, but we respect the default if they leave it blank?
          // Actually, promptForReservedFields is explicit.
          const manualFields = promptForReservedFields(name);
          if (manualFields && manualFields.length > 0) {
            reservedFields = manualFields;
            location = manualFields.length === 1 ? manualFields[0] : null;
          }
        } else if (tileData.type === 'swim') {
          // Fallback if no default location set via new API
          if (reservedFields.length === 0) {
             const swimField = (masterSettings.app1.fields || []).find(f => f.name.toLowerCase().includes('swim') || f.name.toLowerCase().includes('pool'));
             if (swimField) reservedFields = [swimField.name];
          }
        }
        
        let st = prompt(name + " Start:", startStr); if (!st) return;
        let et = prompt(name + " End:", endStr); if (!et) return;
        
        newEvent = { 
            id: Date.now().toString(), 
            type: 'pinned', 
            event: name, 
            division: divName, 
            startTime: st, 
            endTime: et, 
            reservedFields,
            location: defaultLocation || (reservedFields.length > 0 ? reservedFields[0] : null) // Add location property
        };
      }
      // Handle LEAGUE tiles
      else if (tileData.type === 'league') {
        let startTime = prompt("League Game start time:", startStr); if (!startTime) return;
        let endTime = prompt("League Game end time:"); if (!endTime) return;
        newEvent = { id: 'evt_' + Math.random().toString(36).slice(2, 9), type: 'league', event: 'League Game', division: divName, startTime, endTime };
      }
      else if (tileData.type === 'specialty_league') {
        let startTime = prompt("Specialty League start time:", startStr); if (!startTime) return;
        let endTime = prompt("Specialty League end time:"); if (!endTime) return;
        newEvent = { id: 'evt_' + Math.random().toString(36).slice(2, 9), type: 'specialty_league', event: 'Specialty League', division: divName, startTime, endTime };
      }
      // Handle standard slots (Activity, Sports, Special)
      else {
        let name = tileData.name;
        let finalType = tileData.type;
        if (tileData.type === 'activity') { name = "General Activity Slot"; finalType = 'slot'; }
        else if (tileData.type === 'sports') { name = "Sports Slot"; finalType = 'slot'; }
        else if (tileData.type === 'special') { name = "Special Activity"; finalType = 'slot'; }
        if (!name) return;
        let st = prompt(name + " Start:", startStr); if (!st) return;
        let et = prompt(name + " End:", endStr); if (!et) return;
        newEvent = { id: Date.now().toString(), type: finalType, event: name, division: divName, startTime: st, endTime: et };
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
        renderGrid(gridEl);
      }
    };

    // MOBILE TOUCH DROP SUPPORT
    cell.addEventListener('touchend', (e) => {
      // In daily_adjustments.js, the palette ID is 'daily-skeleton-palette'
      const paletteEl = document.getElementById('daily-skeleton-palette');
      if (!paletteEl) return;
  
      const touch = e.changedTouches[0];
      const elementAtPoint = document.elementFromPoint(touch.clientX, touch.clientY);
  
      // Verify we touched this cell or inside it
      if (!elementAtPoint || !cell.contains(elementAtPoint)) return;
  
      // Find if we touched a palette tile
      const tiles = Array.from(paletteEl.querySelectorAll('.grid-tile-draggable'));
      const draggedTile = tiles.find(t => t.style.opacity === '0.6');
  
      if (!draggedTile || !draggedTile.dataset.tileData) return;
  
      const tileData = JSON.parse(draggedTile.dataset.tileData);
      draggedTile.style.opacity = '1';
  
      // Trigger the same drop logic by creating a mock event
      const fakeEvent = {
        preventDefault: () => {},
        clientY: touch.clientY,
        dataTransfer: {
          types: ['application/json'], // Required for check in ondrop
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
  gridEl.querySelectorAll('.grid-event').forEach(tile => {
    tile.ondblclick = (e) => {
      e.stopPropagation();
      if (e.target.classList.contains('resize-handle')) return;
      const id = tile.dataset.id;
      if (!id) return;
      if (confirm("Delete this block?")) {
        dailyOverrideSkeleton = dailyOverrideSkeleton.filter(x => x.id !== id);
        saveDailySkeleton();
        renderGrid(gridEl);
      }
    };
  });
}

// =================================================================
// LOAD/SAVE
// =================================================================
function loadDailySkeleton() {
  const dailyData = window.loadCurrentDailyData?.() || {};
  if (dailyData.manualSkeleton && dailyData.manualSkeleton.length > 0) {
    dailyOverrideSkeleton = JSON.parse(JSON.stringify(dailyData.manualSkeleton));
    window.dailyOverrideSkeleton = dailyOverrideSkeleton;
    return;
  }
  const assignments = masterSettings.app1.skeletonAssignments || {};
  const skeletons = masterSettings.app1.savedSkeletons || {};
  const dateStr = window.currentScheduleDate || "";
  const [Y, M, D] = dateStr.split('-').map(Number);
  let dow = 0;
  if (Y && M && D) dow = new Date(Y, M - 1, D).getDay();
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  let tmpl = assignments[dayNames[dow]] || assignments["Default"];
  dailyOverrideSkeleton = (tmpl && skeletons[tmpl]) ? JSON.parse(JSON.stringify(skeletons[tmpl])) : [];
  window.dailyOverrideSkeleton = dailyOverrideSkeleton;
}

function saveDailySkeleton() {
  window.saveCurrentDailyData?.("manualSkeleton", dailyOverrideSkeleton);
  window.dailyOverrideSkeleton = dailyOverrideSkeleton;
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
// RUN OPTIMIZER
// =================================================================
function runOptimizer() {
  if (!window.runSkeletonOptimizer) { alert("Error: 'runSkeletonOptimizer' not found."); return; }
  if (dailyOverrideSkeleton.length === 0) { alert("Skeleton is empty."); return; }
  saveDailySkeleton();
  const success = window.runSkeletonOptimizer(dailyOverrideSkeleton, currentOverrides);
  if (success) { alert("Schedule Generated!"); window.showTab?.('schedule'); }
  else { alert("Error. Check console."); }
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
  
  const dailyData = window.loadCurrentDailyData?.() || {};
  const dailyOverrides = dailyData.overrides || {};
  currentOverrides.dailyFieldAvailability = dailyData.dailyFieldAvailability || {};
  currentOverrides.leagues = dailyOverrides.leagues || [];
  currentOverrides.disabledSpecialtyLeagues = dailyData.disabledSpecialtyLeagues || [];
  currentOverrides.dailyDisabledSportsByField = dailyData.dailyDisabledSportsByField || {};
  currentOverrides.disabledFields = dailyOverrides.disabledFields || [];
  currentOverrides.disabledSpecials = dailyOverrides.disabledSpecials || [];
  currentOverrides.bunkActivityOverrides = dailyData.bunkActivityOverrides || [];

  container.innerHTML = `
    <style>
      /* GRID STYLES - EXACT MATCH master_schedule_builder.js */
      .grid-disabled { position:absolute; width:100%; background-color:#80808040; background-image:linear-gradient(-45deg,#0000001a 25%,transparent 25%,transparent 50%,#0000001a 50%,#0000001a 75%,transparent 75%,transparent); background-size:20px 20px; z-index:1; pointer-events:none; }
      .grid-event { z-index:2; position:relative; box-sizing:border-box; }
      .grid-cell { position:relative; border-right:1px solid #ccc; background:#fff; }
      
      .resize-handle { position:absolute; left:0; right:0; height:10px; cursor:ns-resize; z-index:5; opacity:0; transition:opacity 0.15s; }
      .resize-handle-top { top:-2px; }
      .resize-handle-bottom { bottom:-2px; }
      .grid-event:hover .resize-handle { opacity:1; background:rgba(37,99,235,0.3); }
      .grid-event.resizing { box-shadow:0 0 0 2px #2563eb, 0 4px 12px rgba(37,99,235,0.25) !important; z-index:100 !important; }
      
      #resize-tooltip { position:fixed; padding:10px 14px; background:#111827; color:#fff; border-radius:8px; font-size:0.9em; font-weight:600; pointer-events:none; z-index:10002; display:none; box-shadow:0 8px 24px rgba(15,23,42,0.35); text-align:center; line-height:1.4; }
      #resize-tooltip span { font-size:0.85em; opacity:0.7; }
      
      #drag-ghost { position:fixed; padding:10px 14px; background:#ffffff; border:2px solid #2563eb; border-radius:8px; box-shadow:0 8px 24px rgba(37,99,235,0.25); pointer-events:none; z-index:10001; display:none; font-size:0.9em; color:#111827; }
      #drag-ghost span { color:#6b7280; }
      
      .drop-preview { display:none; position:absolute; left:2%; width:96%; background:rgba(37,99,235,0.15); border:2px dashed #2563eb; border-radius:4px; pointer-events:none; z-index:5; }
      .preview-time-label { text-align:center; padding:8px 4px; color:#1d4ed8; font-weight:700; font-size:0.9em; background:rgba(255,255,255,0.95); border-radius:3px; margin:4px; box-shadow:0 2px 6px rgba(0,0,0,0.1); }
      
      .conflict-warn, .conflict-critical { border:2px solid #dc2626 !important; background:#fef2f2 !important; box-shadow:0 0 0 2px rgba(220,38,38,0.2), 0 2px 8px rgba(220,38,38,0.15) !important; }
      .conflict-notice, .conflict-warning { border:2px solid #f59e0b !important; background:#fffbeb !important; box-shadow:0 0 0 2px rgba(245,158,11,0.2), 0 2px 8px rgba(245,158,11,0.15) !important; }
      
      /* RAINY DAY MODE STYLES */
      .rainy-day-card { border-radius: 16px; overflow: hidden; margin-bottom: 20px; transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1); position: relative; }
      .rainy-day-card.inactive { background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%); border: 1px solid #e2e8f0; }
      .rainy-day-card.active { background: linear-gradient(135deg, #1e3a5f 0%, #0c4a6e 50%, #164e63 100%); border: 1px solid #0ea5e9; box-shadow: 0 0 40px rgba(14, 165, 233, 0.15), 0 20px 40px rgba(15, 23, 42, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.1); }
      .rainy-day-header { padding: 16px 20px; display: flex; justify-content: space-between; align-items: center; }
      .rainy-day-title-section { display: flex; align-items: center; gap: 12px; }
      .rainy-day-icon { width: 44px; height: 44px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 22px; transition: all 0.4s ease; }
      .rainy-day-card.inactive .rainy-day-icon { background: #e2e8f0; }
      .rainy-day-card.active .rainy-day-icon { background: rgba(14, 165, 233, 0.2); box-shadow: 0 0 20px rgba(14, 165, 233, 0.3); animation: iconPulse 2s ease-in-out infinite; }
      @keyframes iconPulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }
      .rainy-day-title { font-size: 1rem; font-weight: 600; margin: 0; transition: color 0.3s ease; }
      .rainy-day-card.inactive .rainy-day-title { color: #334155; }
      .rainy-day-card.active .rainy-day-title { color: #f0f9ff; }
      .rainy-day-subtitle { font-size: 0.8rem; margin: 2px 0 0; transition: color 0.3s ease; }
      .rainy-day-card.inactive .rainy-day-subtitle { color: #64748b; }
      .rainy-day-card.active .rainy-day-subtitle { color: #7dd3fc; }
      .rainy-toggle-container { display: flex; align-items: center; gap: 10px; }
      .rainy-status-badge { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 999px; font-size: 0.75rem; font-weight: 600; transition: all 0.3s ease; }
      .rainy-status-badge.active { background: rgba(14, 165, 233, 0.2); color: #7dd3fc; border: 1px solid rgba(14, 165, 233, 0.3); }
      .rainy-status-badge.inactive { background: #f1f5f9; color: #64748b; border: 1px solid #e2e8f0; }
      .status-dot { width: 7px; height: 7px; border-radius: 50%; }
      .status-dot.active { background: #22d3ee; box-shadow: 0 0 8px #22d3ee; animation: statusPulse 1.5s ease-in-out infinite; }
      .status-dot.inactive { background: #94a3b8; }
      @keyframes statusPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
      .rainy-toggle { position: relative; width: 52px; height: 26px; cursor: pointer; }
      .rainy-toggle input { opacity: 0; width: 0; height: 0; }
      .rainy-toggle-track { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: #cbd5e1; border-radius: 26px; transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1); }
      .rainy-toggle input:checked + .rainy-toggle-track { background: linear-gradient(135deg, #0ea5e9, #06b6d4); box-shadow: 0 0 16px rgba(14, 165, 233, 0.5); }
      .rainy-toggle-thumb { position: absolute; top: 2px; left: 2px; width: 22px; height: 22px; background: white; border-radius: 50%; transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1); box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15); display: flex; align-items: center; justify-content: center; font-size: 11px; }
      .rainy-toggle input:checked ~ .rainy-toggle-thumb { left: 28px; background: #f0f9ff; }
      .rainy-stats-row { padding: 0 20px 16px; display: flex; gap: 16px; flex-wrap: wrap; }
      .rainy-stat-item { display: flex; align-items: center; gap: 6px; font-size: 0.8rem; transition: color 0.3s ease; }
      .rainy-day-card.inactive .rainy-stat-item { color: #64748b; }
      .rainy-day-card.active .rainy-stat-item { color: #bae6fd; }
      .rainy-stat-item strong { font-weight: 600; }
      .rainy-day-card.inactive .rainy-stat-item strong { color: #334155; }
      .rainy-day-card.active .rainy-stat-item strong { color: #f0f9ff; }
      .rain-animation-container { position: absolute; top: 0; left: 0; right: 0; bottom: 0; overflow: hidden; pointer-events: none; opacity: 0; transition: opacity 0.5s ease; border-radius: 16px; }
      .rainy-day-card.active .rain-animation-container { opacity: 1; }
      .rain-drop { position: absolute; width: 2px; background: linear-gradient(to bottom, transparent, rgba(186, 230, 253, 0.3)); animation: rainFall linear infinite; }
      @keyframes rainFall { 0% { transform: translateY(-100%); opacity: 0; } 10% { opacity: 1; } 90% { opacity: 1; } 100% { transform: translateY(200px); opacity: 0; } }
      @keyframes slideInNotif { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
      
      /* RAINY DAY SETTINGS PANEL */
      .rainy-settings-panel { padding: 16px 20px; border-top: 1px solid rgba(255,255,255,0.1); }
      .rainy-day-card.inactive .rainy-settings-panel { border-top-color: #e2e8f0; background: #fafafa; }
      .rainy-day-card.active .rainy-settings-panel { background: rgba(0,0,0,0.15); }
      .rainy-settings-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; gap: 12px; }
      .rainy-settings-row:last-child { margin-bottom: 0; }
      .rainy-settings-label { font-size: 0.85rem; font-weight: 500; }
      .rainy-day-card.inactive .rainy-settings-label { color: #475569; }
      .rainy-day-card.active .rainy-settings-label { color: #e0f2fe; }
      .rainy-settings-sublabel { font-size: 0.75rem; opacity: 0.7; }
      .rainy-settings-select { padding: 8px 12px; border-radius: 8px; font-size: 0.85rem; min-width: 180px; }
      .rainy-day-card.inactive .rainy-settings-select { background: white; border: 1px solid #d1d5db; color: #374151; }
      .rainy-day-card.active .rainy-settings-select { background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: #f0f9ff; }
      .rainy-day-card.active .rainy-settings-select option { background: #0c4a6e; color: #f0f9ff; }
      
      /* Mini toggle for settings */
      .rainy-mini-toggle { position: relative; width: 40px; height: 20px; cursor: pointer; display: inline-block; }
      .rainy-mini-toggle input { opacity: 0; width: 0; height: 0; }
      .rainy-mini-track { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: #d1d5db; border-radius: 20px; transition: 0.3s; }
      .rainy-mini-toggle input:checked + .rainy-mini-track { background: #10b981; }
      .rainy-mini-thumb { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; background: white; border-radius: 50%; transition: 0.3s; box-shadow: 0 1px 3px rgba(0,0,0,0.2); }
      .rainy-mini-toggle input:checked ~ .rainy-mini-thumb { left: 22px; }
      
      /* Mid-day button */
      .rainy-midday-btn { padding: 10px 16px; border-radius: 10px; font-size: 0.85rem; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 8px; transition: all 0.2s ease; border: none; }
      .rainy-midday-btn.primary { background: linear-gradient(135deg, #f59e0b, #d97706); color: white; }
      .rainy-midday-btn.primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(245, 158, 11, 0.3); }
      
      /* Mid-day badges */
      .rainy-midday-badge { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; background: rgba(245, 158, 11, 0.2); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 999px; font-size: 0.75rem; font-weight: 600; color: #fbbf24; }
      .rainy-preserved-badge { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; background: rgba(34, 197, 94, 0.2); border: 1px solid rgba(34, 197, 94, 0.3); border-radius: 999px; font-size: 0.75rem; font-weight: 600; color: #4ade80; }
      
      /* Resource toggles */
      .resource-toggle-row { display:flex; align-items:center; justify-content:space-between; padding:8px 12px; background:#fff; border:1px solid #e5e7eb; border-radius:8px; margin-bottom:6px; transition:background 0.15s, border-color 0.15s; }
      .resource-toggle-row:hover { background:#f9fafb; border-color:#d1d5db; }
      .resource-toggle-row.disabled-row { background:#fef2f2; border-color:#fecaca; }
      .resource-toggle-name { font-weight:500; flex:1; color:#111827; }
      .resource-toggle-switch { position:relative; width:40px; height:20px; }
      .resource-toggle-switch input { opacity:0; width:0; height:0; }
      .resource-toggle-slider { position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background:#ccc; transition:0.4s; border-radius:20px; }
      .resource-toggle-slider:before { position:absolute; content:""; height:14px; width:14px; left:3px; bottom:3px; background:white; transition:0.4s; border-radius:50%; }
      .resource-toggle-switch input:checked + .resource-toggle-slider { background:#4caf50; }
      .resource-toggle-switch input:checked + .resource-toggle-slider:before { transform:translateX(20px); }
      
      /* Published styles for detail pane */
      .master-list .list-item { padding:10px 8px; border:1px solid #ddd; border-radius:5px; margin-bottom:3px; cursor:pointer; background:#fff; font-size:.95em; display:flex; justify-content:space-between; align-items:center; }
      .master-list .list-item:hover { background:#f9f9f9; }
      .master-list .list-item.selected { background:#e7f3ff; border-color:#007bff; }
      .master-list .list-item-name { font-weight:600; flex-grow:1; }
      .detail-pane { border:1px solid #ccc; border-radius:8px; padding:20px; background:#fdfdfd; min-height:300px; }
      .sport-override-list { margin-top:15px; padding-top:15px; border-top:1px solid #eee; }
      .sport-override-list label { display:block; margin:5px 0 5px 10px; font-size:1.0em; }
      .sport-override-list label input { margin-right:8px; vertical-align:middle; }

      /* NEW CSS ADDITIONS */
      .rainy-settings-btn:hover {
        background: rgba(255,255,255,0.15) !important;
        border-color: rgba(255,255,255,0.3) !important;
      }

      .rainy-day-card.active .rainy-settings-btn {
        color: #e0f2fe;
      }

      .rainy-midday-btn:hover:not(:disabled) {
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(245, 158, 11, 0.3);
      }
    </style>
    
    <div style="padding:15px;background:#f9f9f9;border:1px solid #ddd;border-radius:8px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
      <div>
        <h2 style="margin:0 0 5px 0;font-size:1.2em;">Daily Adjustments</h2>
        <p style="margin:0;font-size:0.85em;color:#666;">${window.currentScheduleDate || 'Select a date'} • Drag edges to resize • Double-click to remove</p>
      </div>
      <button id="run-optimizer-btn" style="background:#28a745;color:white;padding:10px 20px;font-size:1em;border:none;border-radius:5px;cursor:pointer;font-weight:bold;">▶ Run Optimizer</button>
    </div>
    
    <!-- RAINY DAY MODE TOGGLE -->
    <div id="rainy-day-container">${renderRainyDayToggle()}</div>
    
    <div class="da-tabs-nav league-nav">
      <button class="tab-button active" data-tab="skeleton">Skeleton</button>
      <button class="tab-button" data-tab="trips">Trips</button>
      <button class="tab-button" data-tab="bunk-specific">Bunk Specific</button>
      <button class="tab-button" data-tab="resources">Resources</button>
    </div>
    <div id="da-pane-skeleton" class="da-tab-pane league-content-pane active"></div>
    <div id="da-pane-trips" class="da-tab-pane league-content-pane"></div>
    <div id="da-pane-bunk-specific" class="da-tab-pane league-content-pane"></div>
    <div id="da-pane-resources" class="da-tab-pane league-content-pane"></div>
  `;

  document.getElementById("run-optimizer-btn").onclick = runOptimizer;
  bindRainyDayToggle();
  
  container.querySelectorAll('.da-tabs-nav .tab-button').forEach(btn => {
    btn.onclick = () => {
      activeSubTab = btn.dataset.tab;
      container.querySelectorAll('.da-tabs-nav .tab-button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      container.querySelectorAll('.da-tab-pane').forEach(p => p.classList.remove('active'));
      const pane = container.querySelector('#da-pane-' + activeSubTab);
      if (pane) { pane.classList.add('active'); }
    };
  });
  
  document.getElementById('da-pane-skeleton').innerHTML = `<div id="override-scheduler-content"></div>`;
  document.getElementById('da-pane-trips').innerHTML = `
    <div style="border:1px solid #ddd;border-radius:8px;padding:15px;background:#fff;">
      <h3 style="margin-top:0;">Add Trip</h3>
      <div id="trips-form-container"></div>
    </div>
  `;
  document.getElementById('da-pane-bunk-specific').innerHTML = `
    <div style="border:1px solid #ddd;border-radius:8px;padding:15px;background:#fff;">
      <h3 style="margin-top:0;">Bunk-Specific Overrides</h3>
      <p style="font-size:0.85em;color:#666;">Assign a specific activity to bunks at a specific time.</p>
      <div id="bunk-overrides-container"></div>
    </div>
  `;
  document.getElementById('da-pane-resources').innerHTML = `
    <div style="border:1px solid #ddd;border-radius:8px;padding:15px;background:#fff;">
      <h3 style="margin-top:0;">Daily Resource Availability</h3>
      <p style="font-size:0.85em;color:#666;">Disable fields, leagues, or activities for this day only.</p>
      <div id="resource-overrides-container"></div>
    </div>
  `;
  
  skeletonContainer = document.getElementById("override-scheduler-content");
  tripsFormContainer = document.getElementById("trips-form-container");
  bunkOverridesContainer = document.getElementById("bunk-overrides-container");
  resourceOverridesContainer = document.getElementById("resource-overrides-container");
  
  initDailySkeletonUI();
  renderTripsForm();
  renderBunkOverridesUI();
  renderResourceOverridesUI();
}

function initDailySkeletonUI() {
  if (!skeletonContainer) return;
  loadDailySkeleton();
  const savedSkeletons = masterSettings.app1.savedSkeletons || {};
  let optionsHtml = '<option value="">-- Select --</option>';
  Object.keys(savedSkeletons).sort().forEach(name => { optionsHtml += '<option value="' + name + '">' + name + '</option>'; });
  
  skeletonContainer.innerHTML = `
    <div id="displaced-tiles-panel" style="display:none;"></div>
    <div style="margin-bottom:10px;padding:10px;background:#f4f4f4;border-radius:5px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <label>Load Template</label>
      <select id="daily-skeleton-select" style="padding:6px;">${optionsHtml}</select>
      <div style="flex:1;"></div>
      ${window.SkeletonSandbox ? '<button id="conflict-rules-btn" style="padding:6px 12px;background:#fff;border:1px solid #ddd;border-radius:4px;cursor:pointer;">⚙️ Conflict Rules</button>' : ''}
    </div>
    <div id="daily-skeleton-palette" style="padding:10px;background:#f4f4f4;border-radius:8px;margin-bottom:15px;display:flex;flex-wrap:wrap;gap:10px;"></div>
    <div id="scheduler-grid-wrapper" style="overflow-x:auto; border:1px solid #999; background:#fff;">
      <div id="daily-skeleton-grid"></div>
    </div>
  `;
  
  document.getElementById("daily-skeleton-select").onchange = function() {
    const name = this.value;
    if (name && savedSkeletons[name] && confirm('Load "' + name + '"?')) {
      dailyOverrideSkeleton = JSON.parse(JSON.stringify(savedSkeletons[name]));
      clearDisplacedTiles();
      saveDailySkeleton();
      renderGrid(document.getElementById("daily-skeleton-grid"));
    }
  };
  
  if (window.SkeletonSandbox) {
    const rulesBtn = document.getElementById("conflict-rules-btn");
    if (rulesBtn) {
      rulesBtn.onclick = () => {
        window.SkeletonSandbox.showRulesModal(
          () => { renderGrid(document.getElementById("daily-skeleton-grid")); },
          dailyOverrideSkeleton
        );
      };
    }
  }
  
  const paletteEl = document.getElementById("daily-skeleton-palette");
  renderPalette(paletteEl);
  renderGrid(document.getElementById("daily-skeleton-grid"));
  renderDisplacedTilesPanel();
}

function renderTripsForm() {
  if (!tripsFormContainer) return;
  const divisions = window.availableDivisions || [];
  tripsFormContainer.innerHTML = `
    <div style="max-width:400px;">
      <p style="color:#666;font-size:0.85em;margin-bottom:15px;">Add an off-campus trip. Overlapping events will be bumped.</p>
      <div style="margin-bottom:10px;"><label>Division</label><br>
        <select id="trip-division-select" style="width:100%;padding:8px;margin-top:4px;">
          <option value="">-- Select --</option>
          ${divisions.map(d => '<option value="' + d + '">' + d + '</option>').join("")}
        </select>
      </div>
      <div style="margin-bottom:10px;"><label>Trip Name</label><br>
        <input id="trip-name-input" type="text" placeholder="e.g. Six Flags" style="width:100%;padding:8px;margin-top:4px;box-sizing:border-box;" />
      </div>
      <div style="display:flex;gap:10px;margin-bottom:15px;">
        <div style="flex:1;"><label>Start</label><br><input id="trip-start-input" type="text" placeholder="10:00am" style="width:100%;padding:8px;margin-top:4px;box-sizing:border-box;" /></div>
        <div style="flex:1;"><label>End</label><br><input id="trip-end-input" type="text" placeholder="3:30pm" style="width:100%;padding:8px;margin-top:4px;box-sizing:border-box;" /></div>
      </div>
      <button id="apply-trip-btn" style="width:100%;background:#007bff;color:white;padding:10px;font-weight:bold;border:none;border-radius:4px;cursor:pointer;">Add Trip</button>
    </div>
  `;
  
  document.getElementById("apply-trip-btn").onclick = () => {
    const division = document.getElementById("trip-division-select").value;
    const tripName = document.getElementById("trip-name-input").value.trim();
    const startTime = document.getElementById("trip-start-input").value.trim();
    const endTime = document.getElementById("trip-end-input").value.trim();
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
    renderGrid(document.getElementById("daily-skeleton-grid"));
    container.querySelector('.tab-button[data-tab="skeleton"]').click();
    alert("Trip added!");
    document.getElementById("trip-name-input").value = "";
    document.getElementById("trip-start-input").value = "";
    document.getElementById("trip-end-input").value = "";
  };
}

// =================================================================
// BUNK OVERRIDES UI - FULL IMPLEMENTATION FROM PUBLISHED
// =================================================================
function renderBunkOverridesUI() {
  if (!bunkOverridesContainer) return;
  bunkOverridesContainer.innerHTML = "";
  
  const divisions = masterSettings.app1.divisions || {};
  const availableDivisions = masterSettings.app1.availableDivisions || window.availableDivisions || [];
  const allBunksByDiv = {};
  availableDivisions.forEach(divName => {
    allBunksByDiv[divName] = (divisions[divName]?.bunks || []).sort();
  });
  
  const allSports = (masterSettings.app1.fields || []).flatMap(f => f.activities || []);
  const allSpecials = (masterSettings.app1.specialActivities || []).map(s => s.name);
  const allActivities = [...new Set([...allSports, ...allSpecials])].sort();
  
  const form = document.createElement('div');
  form.style.border = '1px solid #ccc';
  form.style.padding = '15px';
  form.style.borderRadius = '8px';
  form.style.marginBottom = '20px';
  
  let activityOptions = '<option value="">-- Select an Activity --</option>';
  allActivities.forEach(act => { activityOptions += '<option value="' + act + '">' + act + '</option>'; });
  
  form.innerHTML = `
    <label for="bunk-override-activity" style="display:block;margin-bottom:5px;font-weight:600;">Activity:</label>
    <select id="bunk-override-activity" style="width:250px;padding:5px;font-size:1em;">${activityOptions}</select>
    <label for="bunk-override-start" style="display:block;margin-top:10px;font-weight:600;">Start Time:</label>
    <input id="bunk-override-start" placeholder="e.g., 9:00am" style="margin-right:8px;">
    <label for="bunk-override-end" style="display:block;margin-top:10px;font-weight:600;">End Time:</label>
    <input id="bunk-override-end" placeholder="e.g., 10:00am" style="margin-right:8px;">
    <p style="margin-top:15px;font-weight:600;">Select Bunks:</p>
  `;
  
  availableDivisions.forEach(divName => {
    const bunks = allBunksByDiv[divName];
    if (!bunks || bunks.length === 0) return;
    const divLabel = document.createElement('div');
    divLabel.textContent = divName;
    divLabel.style.fontWeight = 'bold';
    divLabel.style.marginTop = '8px';
    form.appendChild(divLabel);
    const bunkChipBox = document.createElement('div');
    bunkChipBox.className = 'chips';
    bunkChipBox.style.marginBottom = '5px';
    bunks.forEach(bunkName => {
      const chip = createChip(bunkName, divisions[divName]?.color || '#ccc');
      bunkChipBox.appendChild(chip);
    });
    form.appendChild(bunkChipBox);
  });
  
  const addBtn = document.createElement('button');
  addBtn.textContent = 'Add Pinned Activity';
  addBtn.className = 'bunk-button';
  addBtn.style.background = '#007BFF';
  addBtn.style.color = 'white';
  addBtn.style.marginTop = '15px';
  addBtn.onclick = () => {
    const activityEl = form.querySelector('#bunk-override-activity');
    const startEl = form.querySelector('#bunk-override-start');
    const endEl = form.querySelector('#bunk-override-end');
    const selectedBunks = Array.from(form.querySelectorAll('.bunk-button.selected')).map(el => el.dataset.value);
    const activity = activityEl.value;
    const start = startEl.value.trim();
    const end = endEl.value.trim();
    if (!activity) { alert('Please select an activity.'); return; }
    if (!start || !end) { alert('Please enter a start and end time.'); return; }
    if (selectedBunks.length === 0) { alert('Please select at least one bunk.'); return; }
    const startMin = parseTimeToMinutes(start);
    const endMin = parseTimeToMinutes(end);
    if (startMin == null || endMin == null || endMin <= startMin) {
      alert('Invalid time range.');
      return;
    }
    const overrides = window.loadCurrentDailyData?.().bunkActivityOverrides || [];
    selectedBunks.forEach(bunk => {
      overrides.push({ id: uid(), bunk, activity, startTime: start, endTime: end });
    });
    window.saveCurrentDailyData("bunkActivityOverrides", overrides);
    currentOverrides.bunkActivityOverrides = overrides;
    activityEl.value = "";
    startEl.value = "";
    endEl.value = "";
    form.querySelectorAll('.bunk-button.selected').forEach(chip => chip.click());
    renderBunkOverridesUI();
  };
  form.appendChild(addBtn);
  bunkOverridesContainer.appendChild(form);
  
  const listContainer = document.createElement('div');
  listContainer.id = "bunk-overrides-list-container";
  const overrides = currentOverrides.bunkActivityOverrides;
  if (overrides.length === 0) {
    listContainer.innerHTML = '<p class="muted">No bunk-specific activities added yet.</p>';
  } else {
    overrides.forEach(item => {
      const el = document.createElement('div');
      el.className = 'item';
      el.innerHTML = `
        <div style="flex-grow:1;">
          <div><strong>${item.bunk}</strong> » ${item.activity}</div>
          <div class="muted" style="font-size:0.9em;">${item.startTime} - ${item.endTime}</div>
        </div>
        <button data-id="${item.id}" style="padding:6px 10px;border-radius:4px;cursor:pointer;background:#c0392b;color:white;border:none;">Remove</button>
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
  bunkOverridesContainer.appendChild(listContainer);
}

function createChip(name, color) {
  const el = document.createElement('span');
  el.className = 'bunk-button';
  el.textContent = name;
  el.dataset.value = name;
  el.style.cssText = 'border:1px solid ' + color + ';background:white;color:black;padding:4px 10px;border-radius:999px;cursor:pointer;margin:2px;display:inline-block;';
  el.addEventListener('click', () => {
    const sel = el.classList.toggle('selected');
    el.style.backgroundColor = sel ? color : 'white';
    el.style.color = sel ? 'white' : 'black';
  });
  return el;
}

// =================================================================
// RESOURCE OVERRIDES UI - WITH RAINY DAY INTEGRATION
// =================================================================
let selectedOverrideId = null;

function renderResourceOverridesUI() {
  if (!resourceOverridesContainer) return;
  
  const isRainy = isRainyDayActive();
  const rainyBanner = isRainy ? `
    <div style="background:linear-gradient(135deg, #0c4a6e, #164e63); color:#f0f9ff; padding:12px 16px; border-radius:10px; margin-bottom:16px; display:flex; align-items:center; gap:10px;">
      <span style="font-size:20px;">🌧️</span>
      <div>
        <strong>Rainy Day Mode Active</strong>
        <div style="font-size:0.85rem; opacity:0.85;">Outdoor fields are automatically disabled</div>
      </div>
    </div>
  ` : '';
  
  resourceOverridesContainer.innerHTML = `
    ${rainyBanner}
    <div style="display:flex;flex-wrap:wrap;gap:20px;">
      <div style="flex:1;min-width:300px;">
        <h4>Fields</h4><div id="override-fields-list" class="master-list"></div>
        <h4 style="margin-top:15px;">Special Activities</h4><div id="override-specials-list" class="master-list"></div>
        <h4 style="margin-top:15px;">Leagues</h4><div id="override-leagues-list" class="master-list"></div>
        <h4 style="margin-top:15px;">Specialty Leagues</h4><div id="override-specialty-leagues-list" class="master-list"></div>
      </div>
      <div style="flex:2;min-width:400px;position:sticky;top:20px;">
        <h4>Details</h4>
        <div id="override-detail-pane" class="detail-pane">
          <p class="muted">Select an item from the left to edit its details.</p>
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
  };
  
  const fields = masterSettings.app1.fields || [];
  const overrideFieldsListEl = document.getElementById("override-fields-list");
  
  fields.forEach(item => {
    const isDisabled = currentOverrides.disabledFields.includes(item.name);
    const isOutdoor = item.rainyDayAvailable !== true;
    const isRainyDisabled = isRainy && isOutdoor;
    
    const onToggle = (isEnabled) => {
      if (isEnabled) currentOverrides.disabledFields = currentOverrides.disabledFields.filter(n => n !== item.name);
      else if (!currentOverrides.disabledFields.includes(item.name)) currentOverrides.disabledFields.push(item.name);
      saveOverrides();
      renderResourceOverridesUI();
    };
    
    overrideFieldsListEl.appendChild(createOverrideMasterListItem('field', item.name, !isDisabled, onToggle, isOutdoor, isRainyDisabled));
  });
  
  const specials = masterSettings.app1.specialActivities || [];
  const overrideSpecialsListEl = document.getElementById("override-specials-list");
  specials.forEach(item => {
    const isDisabled = currentOverrides.disabledSpecials.includes(item.name);
    const isRainyOnly = item.rainyDayOnly === true;
    const onToggle = (isEnabled) => {
      if (isEnabled) currentOverrides.disabledSpecials = currentOverrides.disabledSpecials.filter(n => n !== item.name);
      else if (!currentOverrides.disabledSpecials.includes(item.name)) currentOverrides.disabledSpecials.push(item.name);
      saveOverrides();
    };
    overrideSpecialsListEl.appendChild(createOverrideMasterListItem('special', item.name, !isDisabled, onToggle, false, false, isRainyOnly));
  });
  
  const leagues = Object.keys(masterSettings.leaguesByName || {});
  const overrideLeaguesListEl = document.getElementById("override-leagues-list");
  leagues.forEach(name => {
    const isDisabled = currentOverrides.leagues.includes(name);
    const onToggle = (isEnabled) => {
      if (isEnabled) currentOverrides.leagues = currentOverrides.leagues.filter(l => l !== name);
      else if (!currentOverrides.leagues.includes(name)) currentOverrides.leagues.push(name);
      saveOverrides();
    };
    overrideLeaguesListEl.appendChild(createOverrideMasterListItem('league', name, !isDisabled, onToggle));
  });
  
  const specialtyLeagues = Object.values(masterSettings.specialtyLeagues || {}).map(l => l.name).sort();
  const overrideSpecialtyLeaguesListEl = document.getElementById("override-specialty-leagues-list");
  specialtyLeagues.forEach(name => {
    const isDisabled = currentOverrides.disabledSpecialtyLeagues.includes(name);
    const onToggle = (isEnabled) => {
      if (isEnabled) currentOverrides.disabledSpecialtyLeagues = currentOverrides.disabledSpecialtyLeagues.filter(l => l !== name);
      else if (!currentOverrides.disabledSpecialtyLeagues.includes(name)) currentOverrides.disabledSpecialtyLeagues.push(name);
      window.saveCurrentDailyData("disabledSpecialtyLeagues", currentOverrides.disabledSpecialtyLeagues);
    };
    overrideSpecialtyLeaguesListEl.appendChild(createOverrideMasterListItem('specialty_league', name, !isDisabled, onToggle));
  });
  
  renderOverrideDetailPane();
}

function createOverrideMasterListItem(type, name, isEnabled, onToggle, isOutdoor = false, isRainyDisabled = false, isRainyOnly = false) {
  const el = document.createElement('div');
  el.className = 'list-item' + (selectedOverrideId === type + '-' + name ? ' selected' : '');
  if (isRainyDisabled) el.style.opacity = '0.6';
  
  const nameEl = document.createElement('span');
  nameEl.className = 'list-item-name';
  nameEl.style.display = 'flex';
  nameEl.style.alignItems = 'center';
  nameEl.style.gap = '8px';
  nameEl.innerHTML = name;
  
  if (isOutdoor) {
    nameEl.innerHTML += ' <span style="font-size:0.7rem;padding:2px 6px;background:#fef3c7;color:#92400e;border-radius:4px;">🌳 Outdoor</span>';
  } else if (type === 'field') {
    nameEl.innerHTML += ' <span style="font-size:0.7rem;padding:2px 6px;background:#d1fae5;color:#065f46;border-radius:4px;">🏠 Indoor</span>';
  }
  if (isRainyOnly) {
    nameEl.innerHTML += ' <span style="font-size:0.7rem;padding:2px 6px;background:#dbeafe;color:#1e40af;border-radius:4px;">🌧️ Rainy</span>';
  }
  
  el.appendChild(nameEl);
  nameEl.onclick = () => {
    selectedOverrideId = type + '-' + name;
    renderResourceOverridesUI();
  };
  
  const tog = document.createElement("label");
  tog.className = "switch";
  tog.style.cssText = 'position:relative;display:inline-block;width:40px;height:20px;';
  tog.title = isRainyDisabled ? "Disabled by Rainy Day Mode" : (isEnabled ? "Click to disable for today" : "Click to enable for today");
  tog.onclick = (e) => e.stopPropagation();
  
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = isEnabled;
  cb.disabled = isRainyDisabled;
  cb.onchange = (e) => { e.stopPropagation(); onToggle(cb.checked); };
  
  const sl = document.createElement("span");
  sl.className = "slider";
  sl.style.cssText = 'position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:#ccc;transition:0.4s;border-radius:20px;';
  
  tog.appendChild(cb);
  tog.appendChild(sl);
  el.appendChild(tog);
  
  return el;
}

function renderOverrideDetailPane() {
  const overrideDetailPaneEl = document.getElementById("override-detail-pane");
  if (!overrideDetailPaneEl) return;
  
  if (!selectedOverrideId) {
    overrideDetailPaneEl.innerHTML = '<p class="muted">Select an item from the left to edit its details.</p>';
    return;
  }
  
  overrideDetailPaneEl.innerHTML = "";
  const [type, ...nameParts] = selectedOverrideId.split('-');
  const name = nameParts.join('-');
  
  if (type === 'field' || type === 'special') {
    const item = (type === 'field')
      ? (masterSettings.app1.fields || []).find(f => f.name === name)
      : (masterSettings.app1.specialActivities || []).find(s => s.name === name);
    
    if (!item) {
      overrideDetailPaneEl.innerHTML = '<p style="color:red;">Error: Could not find item.</p>';
      return;
    }
    
    const globalRules = item.timeRules || [];
    if (!currentOverrides.dailyFieldAvailability[name]) {
      currentOverrides.dailyFieldAvailability[name] = [];
    }
    const dailyRules = currentOverrides.dailyFieldAvailability[name];
    
    const onSave = () => {
      currentOverrides.dailyFieldAvailability[name] = dailyRules;
      window.saveCurrentDailyData("dailyFieldAvailability", currentOverrides.dailyFieldAvailability);
      renderOverrideDetailPane();
    };
    
    overrideDetailPaneEl.appendChild(renderTimeRulesUI(name, globalRules, dailyRules, onSave));
    
    if (type === 'field') {
      const sportListContainer = document.createElement('div');
      sportListContainer.className = 'sport-override-list';
      sportListContainer.innerHTML = '<strong>Daily Sport Availability for ' + name + '</strong>';
      const sports = item.activities || [];
      if (sports.length === 0) {
        sportListContainer.innerHTML += '<p class="muted" style="margin:5px 0 0 10px;font-size:0.9em;">No sports assigned to this field.</p>';
      }
      const disabledToday = currentOverrides.dailyDisabledSportsByField[name] || [];
      sports.forEach(sport => {
        const isEnabled = !disabledToday.includes(sport);
        const el = createCheckbox(sport, isEnabled);
        el.checkbox.onchange = () => {
          let list = currentOverrides.dailyDisabledSportsByField[name] || [];
          if (el.checkbox.checked) list = list.filter(s => s !== sport);
          else if (!list.includes(sport)) list.push(sport);
          currentOverrides.dailyDisabledSportsByField[name] = list;
          window.saveCurrentDailyData("dailyDisabledSportsByField", currentOverrides.dailyDisabledSportsByField);
        };
        sportListContainer.appendChild(el.wrapper);
      });
      overrideDetailPaneEl.appendChild(sportListContainer);
    }
  } else if (type === 'league' || type === 'specialty_league') {
    overrideDetailPaneEl.innerHTML = '<p class="muted">Enable or disable this league for today using the toggle in the list on the left.</p>';
  }
}

function renderTimeRulesUI(itemName, globalRules, dailyRules, onSave) {
  const container = document.createElement("div");
  
  const globalContainer = document.createElement("div");
  globalContainer.innerHTML = '<strong style="font-size:0.9em;">Global Rules (from Setup):</strong>';
  if (globalRules.length === 0) {
    globalContainer.innerHTML += '<p class="muted" style="margin:0;font-size:0.9em;">Available all day</p>';
  }
  globalRules.forEach(rule => {
    const ruleEl = document.createElement("div");
    ruleEl.style.cssText = "margin:2px 0;font-size:0.9em;";
    ruleEl.innerHTML = '• <span style="color:' + (rule.type === 'Available' ? 'green' : 'red') + ';text-transform:capitalize;">' + rule.type + '</span> from ' + rule.start + ' to ' + rule.end;
    globalContainer.appendChild(ruleEl);
  });
  container.appendChild(globalContainer);
  
  const dailyContainer = document.createElement("div");
  dailyContainer.style.marginTop = "10px";
  dailyContainer.innerHTML = '<strong style="font-size:0.9em;">Daily Override Rules:</strong>';
  const ruleList = document.createElement("div");
  if (dailyRules.length === 0) {
    ruleList.innerHTML = '<p class="muted" style="margin:0;font-size:0.9em;">No daily rules. Using global rules.</p>';
  }
  dailyRules.forEach((rule, index) => {
    const ruleEl = document.createElement("div");
    ruleEl.style.cssText = "margin:2px 0;padding:4px;background:#fff8e1;border-radius:4px;";
    ruleEl.innerHTML = '<strong style="color:' + (rule.type === 'Available' ? 'green' : 'red') + ';">' + rule.type + '</strong> from ' + rule.start + ' to ' + rule.end + ' <button style="margin-left:8px;border:none;background:transparent;cursor:pointer;">✖</button>';
    ruleEl.querySelector('button').onclick = () => { dailyRules.splice(index, 1); onSave(); };
    ruleList.appendChild(ruleEl);
  });
  dailyContainer.appendChild(ruleList);
  container.appendChild(dailyContainer);
  
  const addContainer = document.createElement("div");
  addContainer.style.marginTop = "10px";
  addContainer.innerHTML = `
    <select id="rule-type-select"><option value="Available">Available</option><option value="Unavailable">Unavailable</option></select>
    <input id="rule-start" placeholder="e.g., 9:00am" style="width:100px;margin-left:5px;">
    <span style="margin:0 5px;"> to </span>
    <input id="rule-end" placeholder="e.g., 10:30am" style="width:100px;">
    <button id="add-rule-btn" style="margin-left:8px;">Add Rule</button>
  `;
  container.appendChild(addContainer);
  
  setTimeout(() => {
    const btn = container.querySelector('#add-rule-btn');
    if (btn) {
      btn.onclick = () => {
        const type = container.querySelector('#rule-type-select').value;
        const start = container.querySelector('#rule-start').value;
        const end = container.querySelector('#rule-end').value;
        if (!start || !end) { alert("Please enter start and end times."); return; }
        if (parseTimeToMinutes(start) == null || parseTimeToMinutes(end) == null) { alert("Invalid time format."); return; }
        if (parseTimeToMinutes(start) >= parseTimeToMinutes(end)) { alert("End must be after start."); return; }
        dailyRules.push({ type, start, end });
        onSave();
      };
    }
  }, 0);
  
  return container;
}

function createCheckbox(name, isChecked) {
  const w = document.createElement('label');
  w.style.display = 'block';
  w.style.margin = '5px 0 5px 10px';
  const c = document.createElement('input');
  c.type = 'checkbox';
  c.checked = isChecked;
  c.style.marginRight = '8px';
  const t = document.createElement('span');
  t.textContent = name;
  w.appendChild(c);
  w.appendChild(t);
  return { wrapper: w, checkbox: c };
}

// Expose globals
window.initDailyAdjustments = init;
window.parseTimeToMinutes = parseTimeToMinutes;
window.minutesToTime = minutesToTime;

// Expose rainy day functions for external use
window.isRainyDayActive = isRainyDayActive;
window.isMidDayModeActive = isMidDayModeActive;
window.getMidDayStartTime = getMidDayStartTime;

})();
