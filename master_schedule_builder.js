// =================================================================
// master_schedule_builder.js (UPDATED - REDESIGNED UI)
// Beta v2.5
// Updates:
// 1. Tile palette on LEFT SIDEBAR with solid colors
// 2. Toolbar: Status+Update | Load | New+Save | Clear | Delete
// 3. Delete key support for removing selected tiles
// 4. In-page modal inputs instead of browser prompts
// 5. Checkbox selection for locations/facilities
// 6. Removed draft restore prompt
// 7. ★ v2.5: Grouped-checkbox modal type for locations (matches DA bunk overrides)
// 8. ★ v2.5: Custom tile pulls grouped locations from locationZones
// 9. ★ v2.5: Split tile uses Main 1/Main 2 + mapEventNameForOptimizer (matches DA)
// =================================================================

(function(){
'use strict';

let container=null, palette=null, grid=null;
let dailySkeleton=[];
let currentLoadedTemplate = null;
let selectedTileId = null;
let hasUnsavedChanges = false;
let currentBuilderMode = 'manual'; // 'manual' or 'auto'

// --- Constants ---
const SKELETON_DRAFT_KEY = 'master-schedule-draft';
const SKELETON_DRAFT_NAME_KEY = 'master-schedule-draft-name';
const PIXELS_PER_MINUTE=2;
const INCREMENT_MINS=30;
const SNAP_MINS = 5;

// --- Persistence ---
function saveDraftToLocalStorage() {
  try {
    if (dailySkeleton && dailySkeleton.length > 0) {
      localStorage.setItem(SKELETON_DRAFT_KEY, JSON.stringify(dailySkeleton));
      if(currentLoadedTemplate) {
          localStorage.setItem(SKELETON_DRAFT_NAME_KEY, currentLoadedTemplate);
      }
    } else {
      localStorage.removeItem(SKELETON_DRAFT_KEY);
      localStorage.removeItem(SKELETON_DRAFT_NAME_KEY);
    }
  } catch (e) { console.error(e); }
}

function clearDraftFromLocalStorage() {
  localStorage.removeItem(SKELETON_DRAFT_KEY);
  localStorage.removeItem(SKELETON_DRAFT_NAME_KEY);
}

function markUnsavedChanges() {
  hasUnsavedChanges = true;
  updateToolbarStatus();
}

// --- Tiles (Soft Pastel Color Palette) ---
const TILES=[
  // Scheduling Slots - Soft blues and greens
  {type:'activity', name:'Activity', style:'background:#93c5fd;color:#1e3a5f;', description:'Flexible slot (Sport or Special).'},
  {type:'sports', name:'Sports', style:'background:#86efac;color:#14532d;', description:'Sports slot only.'},
  {type:'special', name:'Special Activity', style:'background:#c4b5fd;color:#3b1f6b;', description:'Special Activity slot only.'},
  
  // Advanced Tiles
  {type:'smart', name:'Smart Tile', style:'background:#7dd3fc;color:#0c4a6e;border:2px dashed #0284c7;', description:'Fills Main 1 by capacity, rest get Main 2, then swap next period.'},
  {type:'split', name:'Split Activity', style:'background:#fdba74;color:#7c2d12;', description:'Splits division between two tile types, swap midway.'},
  {type:'elective', name:'Elective', style:'background:#f0abfc;color:#701a75;', description:'Reserve multiple activities for this division only.'},
  
  // Leagues
  {type:'league', name:'League Game', style:'background:#a5b4fc;color:#312e81;', description:'Regular League slot (Full Buyout).'},
  {type:'specialty_league', name:'Specialty League', style:'background:#d8b4fe;color:#581c87;', description:'Specialty League slot (Full Buyout).'},
  
  // Pinned Events
  {type:'swim', name:'Swim', style:'background:#67e8f9;color:#155e75;', description:'Pinned.'},
  {type:'lunch', name:'Lunch', style:'background:#fca5a5;color:#7f1d1d;', description:'Pinned.'},
  {type:'snacks', name:'Snacks', style:'background:#fde047;color:#713f12;', description:'Pinned.'},
  {type:'dismissal', name:'Dismissal', style:'background:#f87171;color:#fff;', description:'Pinned.'},
  {type:'custom', name:'Custom Pinned', style:'background:#d1d5db;color:#374151;', description:'Pinned custom (e.g., Regroup).'}
];

function mapEventNameForOptimizer(name){
  if(!name) name='Free';
  const lower=name.toLowerCase().trim();
  if(lower==='activity') return {type:'slot',event:'General Activity Slot'};
  if(lower==='sports') return {type:'slot',event:'Sports Slot'};
  if(lower==='special activity'||lower==='special') return {type:'slot',event:'Special Activity'};
  if(['swim','lunch','snacks','dismissal'].includes(lower)) return {type:'pinned',event:name};
  return {type:'pinned',event:name};
}

// =================================================================
// MODAL SYSTEM - Replace browser prompts with in-page modals
// =================================================================
function showModal(config) {
  return new Promise((resolve) => {
    // Remove existing modal
    const existing = document.getElementById('ms-modal-overlay');
    if (existing) existing.remove();
    
    const overlay = document.createElement('div');
    overlay.id = 'ms-modal-overlay';
    overlay.innerHTML = `
      <div class="ms-modal">
        <div class="ms-modal-header">
          <h3>${config.title || 'Input Required'}</h3>
          <button class="ms-modal-close">&times;</button>
        </div>
        <div class="ms-modal-body">
          ${config.description ? `<p class="ms-modal-desc">${config.description}</p>` : ''}
          <div class="ms-modal-fields"></div>
        </div>
        <div class="ms-modal-footer">
          <button class="ms-btn ms-btn-ghost ms-modal-cancel">Cancel</button>
          <button class="ms-btn ms-btn-primary ms-modal-confirm">${config.confirmText || 'Confirm'}</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(overlay);
    
    const fieldsContainer = overlay.querySelector('.ms-modal-fields');
    const inputs = {};
    
    // Build fields
    (config.fields || []).forEach(field => {
      const fieldEl = document.createElement('div');
      fieldEl.className = 'ms-modal-field';
      
      if (field.type === 'text' || field.type === 'time') {
        fieldEl.innerHTML = `
          <label>${field.label}</label>
          <input type="${field.type === 'time' ? 'text' : 'text'}" 
                 class="ms-modal-input" 
                 data-field="${field.name}"
                 value="${field.default || ''}"
                 placeholder="${field.placeholder || ''}">
        `;
        inputs[field.name] = () => fieldEl.querySelector('input').value;
      }
      else if (field.type === 'select') {
        const options = (field.options || []).map(o => 
          `<option value="${o.value || o}" ${o === field.default ? 'selected' : ''}>${o.label || o}</option>`
        ).join('');
        fieldEl.innerHTML = `
          <label>${field.label}</label>
          <select class="ms-modal-input" data-field="${field.name}">
            ${options}
          </select>
        `;
        inputs[field.name] = () => fieldEl.querySelector('select').value;
      }
      else if (field.type === 'checkbox-group') {
        const checkboxes = (field.options || []).map(o => `
          <label class="ms-checkbox-item">
            <input type="checkbox" value="${o}" data-group="${field.name}">
            <span>${o}</span>
          </label>
        `).join('');
        fieldEl.innerHTML = `
          <label>${field.label}</label>
          <div class="ms-checkbox-group">${checkboxes}</div>
        `;
        inputs[field.name] = () => {
          const checked = fieldEl.querySelectorAll(`input[data-group="${field.name}"]:checked`);
          return Array.from(checked).map(c => c.value);
        };
      }
      // ★ v2.5: Grouped checkbox - renders checkboxes with category headers (like DA bunk overrides)
      else if (field.type === 'grouped-checkbox') {
        let groupsHTML = '';
        (field.groups || []).forEach(group => {
          if (!group.options || group.options.length === 0) return;
          groupsHTML += `<div class="ms-checkbox-group-header">${group.label}</div>`;
          groupsHTML += `<div class="ms-checkbox-group-items">`;
          group.options.forEach(o => {
            const val = typeof o === 'object' ? o.value : o;
            const display = typeof o === 'object' ? o.label : o;
            groupsHTML += `
              <label class="ms-checkbox-item">
                <input type="checkbox" value="${val}" data-group="${field.name}">
                <span>${display}</span>
              </label>`;
          });
          groupsHTML += `</div>`;
        });
        if (!groupsHTML) {
          groupsHTML = `<div class="ms-checkbox-group-empty">No locations configured. Add them in Setup → Location Zones.</div>`;
        }
        fieldEl.innerHTML = `
          <label>${field.label}</label>
          <div class="ms-checkbox-grouped">${groupsHTML}</div>
        `;
        inputs[field.name] = () => {
          const checked = fieldEl.querySelectorAll(`input[data-group="${field.name}"]:checked`);
          return Array.from(checked).map(c => c.value);
        };
      }
      
      fieldsContainer.appendChild(fieldEl);
    });
    
    // Focus first input
    setTimeout(() => {
      const firstInput = overlay.querySelector('.ms-modal-input');
      if (firstInput) firstInput.focus();
    }, 50);
    
    // Event handlers
    const close = (result) => {
      overlay.remove();
      resolve(result);
    };
    
    overlay.querySelector('.ms-modal-close').onclick = () => close(null);
    overlay.querySelector('.ms-modal-cancel').onclick = () => close(null);
    overlay.onclick = (e) => { if (e.target === overlay) close(null); };
    
    overlay.querySelector('.ms-modal-confirm').onclick = () => {
      const result = {};
      Object.keys(inputs).forEach(key => {
        result[key] = inputs[key]();
      });
      close(result);
    };
    
    // Enter key to confirm
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
        overlay.querySelector('.ms-modal-confirm').click();
      }
      if (e.key === 'Escape') close(null);
    });
  });
}

function showConfirm(message) {
  return new Promise((resolve) => {
    const existing = document.getElementById('ms-modal-overlay');
    if (existing) existing.remove();
    
    const overlay = document.createElement('div');
    overlay.id = 'ms-modal-overlay';
    overlay.innerHTML = `
      <div class="ms-modal ms-modal-confirm">
        <div class="ms-modal-body" style="padding:24px;">
          <p style="margin:0;font-size:14px;color:#334155;">${message}</p>
        </div>
        <div class="ms-modal-footer">
          <button class="ms-btn ms-btn-ghost ms-modal-cancel">Cancel</button>
          <button class="ms-btn ms-btn-primary ms-modal-confirm-btn">Confirm</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(overlay);
    
    overlay.querySelector('.ms-modal-cancel').onclick = () => { overlay.remove(); resolve(false); };
    overlay.querySelector('.ms-modal-confirm-btn').onclick = () => { overlay.remove(); resolve(true); };
    overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } };
  });
}

function showAlert(message) {
  return new Promise((resolve) => {
    const existing = document.getElementById('ms-modal-overlay');
    if (existing) existing.remove();
    
    const overlay = document.createElement('div');
    overlay.id = 'ms-modal-overlay';
    overlay.innerHTML = `
      <div class="ms-modal ms-modal-alert">
        <div class="ms-modal-body" style="padding:24px;">
          <p style="margin:0;font-size:14px;color:#334155;">${message}</p>
        </div>
        <div class="ms-modal-footer">
          <button class="ms-btn ms-btn-primary ms-modal-ok">OK</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(overlay);
    overlay.querySelector('.ms-modal-ok').onclick = () => { overlay.remove(); resolve(); };
    overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); resolve(); } };
  });
}

// =================================================================
// Get all available locations (fields + facilities + locations + special activities)
// =================================================================
function getAllLocations() {
  const globalSettings = window.loadGlobalSettings?.() || {};
  const app1 = globalSettings.app1 || {};
  
  // Helper to extract names from array (handles strings and objects)
  const extractNames = (arr) => {
    if (!Array.isArray(arr)) return [];
    return arr.map(item => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') return item.name || item.label || item.title || item.location || null;
      return null;
    }).filter(Boolean);
  };
  
  // Get from all possible sources in app1
  const fields = extractNames(app1.fields);
  const specialActivities = extractNames(app1.specialActivities);
  const facilities = extractNames(app1.facilities);
  const locations = extractNames(app1.locations);
  
  // Also check for top-level in globalSettings
  const topLevelLocations = extractNames(globalSettings.locations);
  const topLevelFacilities = extractNames(globalSettings.facilities);
  
  // Check window.locations if it exists
  const windowLocations = extractNames(window.locations);
  
  // Check if there's a getLocations function
  const funcLocations = extractNames(window.getLocations?.());
  
  // Check window.globalSettings directly
  const directSettings = window.globalSettings || {};
  const directLocations = extractNames(directSettings.locations);
  const directFacilities = extractNames(directSettings.facilities);
  const directApp1Locations = extractNames(directSettings.app1?.locations);
  const directApp1Facilities = extractNames(directSettings.app1?.facilities);
  
  // Combine all and remove duplicates
  const all = [...new Set([
    ...fields, 
    ...facilities, 
    ...locations, 
    ...topLevelLocations,
    ...topLevelFacilities,
    ...windowLocations,
    ...funcLocations,
    ...directLocations,
    ...directFacilities,
    ...directApp1Locations,
    ...directApp1Facilities,
    ...specialActivities
  ])].filter(Boolean).sort();
  
  console.log('[getAllLocations] Searched sources:', { 
    'app1.fields': fields,
    'app1.facilities': facilities, 
    'app1.locations': locations, 
    'globalSettings.locations': topLevelLocations,
    'window.locations': windowLocations,
    'getLocations()': funcLocations,
    'app1.specialActivities': specialActivities, 
    'COMBINED': all 
  });
  
  return all;
}

// =================================================================
// ★ v2.5: Build grouped location options (matches DA bunk overrides pattern)
// =================================================================
function getGroupedLocationOptions() {
  const globalSettings = window.loadGlobalSettings?.() || {};
  const app1 = globalSettings.app1 || {};
  
  // Get facilities from locationZones (Pool, Lunchroom, Gym, etc.)
  const locationZones = globalSettings.locationZones || {};
  const facilities = [];
  Object.entries(locationZones).forEach(([zoneName, zone]) => {
    if (zone && zone.locations) {
      Object.keys(zone.locations).forEach(locName => {
        facilities.push({ value: locName, label: `${locName} (${zoneName})` });
      });
    }
  });
  
  // Get pinned tile defaults (Swim → Pool, Lunch → Lunchroom, etc.)
  const pinnedDefaults = globalSettings.pinnedTileDefaults || {};
  const pinnedOptions = Object.entries(pinnedDefaults).map(([act, loc]) => ({
    value: loc, label: `${act} → ${loc}`
  }));
  
  // Get fields
  const allFields = (app1.fields || []).map(f => ({
    value: f.name,
    label: f.name + (f.rainyDayAvailable ? ' 🏠' : '')
  }));
  
  // Get special activities
  const allSpecials = (app1.specialActivities || []).map(s => ({
    value: s.name, label: s.name
  }));
  
  // Build groups array (only include non-empty groups)
  const groups = [];
  if (pinnedOptions.length > 0) groups.push({ label: 'Pinned Defaults', options: pinnedOptions });
  if (facilities.length > 0) groups.push({ label: 'Facilities', options: facilities });
  if (allFields.length > 0) groups.push({ label: 'Fields', options: allFields });
  if (allSpecials.length > 0) groups.push({ label: 'Special Activities', options: allSpecials });
  
  const hasAny = groups.some(g => g.options.length > 0);
  return { groups, hasAny };
}

// =================================================================
// Swim/Pool Alias Handling
// =================================================================
const SWIM_POOL_PATTERNS = ['swim', 'pool', 'swimming', 'aquatics'];

function isSwimPoolAlias(name) {
  const lower = (name || '').toLowerCase().trim();
  // ★ v2.6 FIX: Use word-boundary regex instead of substring to avoid
  // false positives like "Carpool", "Aquamarine", "Poolside BBQ"
  return SWIM_POOL_PATTERNS.some(p => new RegExp(`\\b${p}\\b`).test(lower));
}

function findPoolField(allLocations) {
  for (const loc of allLocations) {
    if (isSwimPoolAlias(loc)) return loc;
  }
  return null;
}

// --- Init ---
function init(){
  container=document.getElementById("master-scheduler-content");
  if(!container) return;
    
  loadDailySkeleton();
  
  // Reset unsaved changes since we just loaded fresh
  hasUnsavedChanges = false;

  // Silently restore draft without prompting
  const savedDraft = localStorage.getItem(SKELETON_DRAFT_KEY);
  const savedDraftName = localStorage.getItem(SKELETON_DRAFT_NAME_KEY);
  if (savedDraft) {
    try {
      dailySkeleton = JSON.parse(savedDraft);
      if(savedDraftName) currentLoadedTemplate = savedDraftName;
      // Draft means there might be unsaved changes
      hasUnsavedChanges = true;
    } catch(e) {
      clearDraftFromLocalStorage();
    }
  }

  // Inject HTML + CSS with new layout
  container.innerHTML = `
    <style>
      /* === MASTER SCHEDULER STYLES === */
      .ms-container { display:flex; gap:0; height:calc(100vh - 120px); min-height:300px; background:#fff; border:1px solid #e2e8f0; border-radius:12px; overflow:hidden; }
      
      /* Left Sidebar - Scrollable */
      .ms-sidebar { width:180px; min-width:0; background:#f8fafc; border-right:1px solid #e2e8f0; display:flex; flex-direction:column; height:100%; max-height:100%; }
      .ms-sidebar-header { padding:14px 12px; border-bottom:1px solid #e2e8f0; background:#fff; flex-shrink:0; }
      .ms-sidebar-header h3 { margin:0; font-size:13px; font-weight:600; color:#475569; }
      .ms-palette { flex:1; overflow-y:auto; overflow-x:hidden; padding:10px; display:flex; flex-direction:column; gap:6px; scrollbar-width:thin; scrollbar-color:#cbd5e1 #f1f5f9; }
      .ms-palette::-webkit-scrollbar { width:6px; }
      .ms-palette::-webkit-scrollbar-track { background:#f1f5f9; border-radius:3px; }
      .ms-palette::-webkit-scrollbar-thumb { background:#cbd5e1; border-radius:3px; }
      .ms-palette::-webkit-scrollbar-thumb:hover { background:#94a3b8; }
      .ms-tile { padding:10px 12px; border-radius:6px; cursor:grab; font-size:12px; font-weight:600; transition:transform 0.15s, box-shadow 0.15s; text-shadow:0 1px 2px rgba(0,0,0,0.2); }
      .ms-tile:hover { transform:translateX(3px); box-shadow:0 4px 12px rgba(0,0,0,0.15); }
      .ms-tile:active { cursor:grabbing; }
      .ms-tile-divider { height:1px; background:#e2e8f0; margin:6px 0; }
      .ms-tile-label { font-size:10px; color:#64748b; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; padding:4px 0; }
      
      /* Main Content */
      .ms-main { flex:1; display:flex; flex-direction:column; overflow:hidden; }
      
      /* Toolbar */
      .ms-toolbar { background:#fff; border-bottom:1px solid #e2e8f0; padding:12px 16px; display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
      .ms-toolbar-group { display:flex; align-items:center; gap:8px; padding:0 12px; border-right:1px solid #e2e8f0; }
      .ms-toolbar-group:last-child { border-right:none; }
      .ms-toolbar-group.status { background:#f1f5f9; padding:8px 14px; border-radius:6px; border-right:none; margin-right:4px; }
      .ms-toolbar-group.status.has-changes { background:#fef3c7; }
      .ms-status-label { font-size:12px; color:#64748b; }
      .ms-status-name { font-size:13px; font-weight:600; color:#0f172a; margin-left:4px; }
      .ms-status-badge { font-size:10px; background:#f59e0b; color:#fff; padding:2px 6px; border-radius:10px; margin-left:6px; }
      
      .ms-select { padding:7px 10px; border:1px solid #e2e8f0; border-radius:6px; font-size:12px; background:#fff; min-width:130px; }
      .ms-select:focus { outline:none; border-color:#3b82f6; }
      .ms-input { padding:7px 10px; border:1px solid #e2e8f0; border-radius:6px; font-size:12px; width:130px; }
      .ms-input:focus { outline:none; border-color:#3b82f6; }
      
      .ms-btn { padding:7px 14px; border:none; border-radius:6px; font-size:12px; font-weight:500; cursor:pointer; transition:all 0.15s; display:inline-flex; align-items:center; gap:5px; }
      .ms-btn-primary { background:#3b82f6; color:#fff; }
      .ms-btn-primary:hover { background:#2563eb; }
      .ms-btn-success { background:#10b981; color:#fff; }
      .ms-btn-success:hover { background:#059669; }
      .ms-btn-warning { background:#f59e0b; color:#fff; }
      .ms-btn-warning:hover { background:#d97706; }
      .ms-btn-danger { background:#ef4444; color:#fff; }
      .ms-btn-danger:hover { background:#dc2626; }
      .ms-btn-ghost { background:#f1f5f9; color:#475569; }
      .ms-btn-ghost:hover { background:#e2e8f0; }
      .ms-btn:disabled { opacity:0.5; cursor:not-allowed; }
      .ms-btn-icon { padding:7px 10px; }
      
      .ms-toolbar-label { font-size:11px; color:#94a3b8; font-weight:500; }
      
      /* Mode Toggle */
      .ms-mode-toggle { display:flex; background:#f1f5f9; border-radius:8px; padding:3px; gap:2px; }
      .ms-mode-btn { padding:7px 16px; border:none; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer; transition:all 0.2s; background:transparent; color:#64748b; white-space:nowrap; }
      .ms-mode-btn:hover { color:#334155; }
      .ms-mode-btn.active { background:#fff; color:#0f172a; box-shadow:0 1px 3px rgba(0,0,0,0.1); }
      
      
      /* Auto Mode Container */
      .ms-auto-container { display:flex; flex-direction:column; height:100%; }
      .ms-auto-toolbar { background:#fff; border-bottom:1px solid #e2e8f0; padding:10px 16px; display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
      
      /* DAW Timeline Grid */
      .ms-daw-wrapper { flex:1; overflow:auto; background:#1e1e2e; position:relative; }
      .ms-daw-grid { position:relative; min-width:800px; }
      
      /* Time ruler at top */
      .ms-daw-ruler { display:flex; height:32px; background:#2a2a3e; border-bottom:1px solid #3a3a52; position:sticky; top:0; z-index:10; margin-left:140px; }
      .ms-daw-ruler-tick { flex:none; border-left:1px solid #3a3a52; padding:0 8px; font-size:10px; color:#8888aa; line-height:32px; font-family:'JetBrains Mono', 'SF Mono', monospace; }
      .ms-daw-ruler-tick:nth-child(even) { color:#6666aa; }
      
      /* Grade rows */
      .ms-daw-grade { display:flex; border-bottom:1px solid #2a2a3e; min-height:80px; position:relative; }
      .ms-daw-grade:hover { background:rgba(255,255,255,0.02); }
      .ms-daw-grade-label { width:140px; min-width:140px; background:#252538; border-right:1px solid #3a3a52; padding:10px 12px; display:flex; flex-direction:column; justify-content:center; position:sticky; left:0; z-index:5; }
      .ms-daw-grade-name { font-size:13px; font-weight:600; color:#e2e8f0; }
      .ms-daw-grade-info { font-size:10px; color:#8888aa; margin-top:2px; }
      .ms-daw-grade-actions { margin-top:6px; display:flex; gap:4px; }
      .ms-daw-grade-btn { padding:2px 6px; font-size:9px; border:1px solid #4a4a62; border-radius:3px; background:transparent; color:#8888aa; cursor:pointer; transition:all 0.15s; }
      .ms-daw-grade-btn:hover { background:#3a3a52; color:#e2e8f0; }
      
      /* Track area (where bands go) */
      .ms-daw-track { flex:1; position:relative; min-height:80px; }
      
      /* Layer bands */
      .ms-daw-band { position:absolute; height:22px; border-radius:4px; cursor:pointer; display:flex; align-items:center; padding:0 8px; font-size:10px; font-weight:600; transition:box-shadow 0.15s, filter 0.15s; z-index:2; user-select:none; }
      .ms-daw-band:hover { box-shadow:0 0 8px rgba(255,255,255,0.2); filter:brightness(1.15); z-index:3; }
      .ms-daw-band.selected { outline:2px solid #fff; outline-offset:1px; z-index:4; }
      .ms-daw-band .band-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
      .ms-daw-band .band-qty { background:rgba(0,0,0,0.3); padding:1px 5px; border-radius:3px; font-size:9px; margin-left:4px; flex-shrink:0; }
      .ms-daw-band .band-resize { position:absolute; top:0; bottom:0; width:6px; cursor:ew-resize; z-index:5; }
      .ms-daw-band .band-resize-left { left:-2px; }
      .ms-daw-band .band-resize-right { right:-2px; }
      
      /* Band colors by type */
      .ms-daw-band[data-type="sport"] { background:rgba(134,239,172,0.7); color:#14532d; }
      .ms-daw-band[data-type="special"] { background:rgba(196,181,253,0.7); color:#3b1f6b; }
      .ms-daw-band[data-type="activity"] { background:rgba(147,197,253,0.7); color:#1e3a5f; }
      .ms-daw-band[data-type="swim"] { background:rgba(103,232,249,0.75); color:#155e75; }
      .ms-daw-band[data-type="lunch"] { background:rgba(252,165,165,0.75); color:#7f1d1d; }
      .ms-daw-band[data-type="snacks"] { background:rgba(253,224,71,0.75); color:#713f12; }
      .ms-daw-band[data-type="dismissal"] { background:rgba(248,113,113,0.8); color:#fff; }
      .ms-daw-band[data-type="custom"] { background:rgba(209,213,219,0.7); color:#374151; }
      .ms-daw-band[data-type="league"] { background:rgba(165,180,252,0.7); color:#312e81; }
      .ms-daw-band[data-type="elective"] { background:rgba(240,171,252,0.7); color:#701a75; }
      
      /* Grid lines */
      .ms-daw-gridline { position:absolute; top:0; bottom:0; width:1px; background:#2a2a3e; z-index:1; pointer-events:none; }
      .ms-daw-gridline.major { background:#3a3a52; }
      
      /* DAW Sidebar (layer palette) */
      .ms-daw-sidebar { width:180px; min-width:0; background:#252538; border-right:1px solid #3a3a52; display:flex; flex-direction:column; height:100%; }
      .ms-daw-sidebar-header { padding:14px 12px; border-bottom:1px solid #3a3a52; }
      .ms-daw-sidebar-header h3 { margin:0; font-size:13px; font-weight:600; color:#e2e8f0; }
      .ms-daw-palette { flex:1; overflow-y:auto; padding:10px; display:flex; flex-direction:column; gap:6px; }
      .ms-daw-tile { padding:8px 10px; border-radius:5px; cursor:grab; font-size:11px; font-weight:600; transition:transform 0.15s; display:flex; align-items:center; gap:6px; }
      .ms-daw-tile:hover { transform:translateX(3px); }
      .ms-daw-tile:active { cursor:grabbing; }
      .ms-daw-tile-color { width:14px; height:14px; border-radius:3px; flex-shrink:0; }
      .ms-daw-tile-divider { height:1px; background:#3a3a52; margin:4px 0; }
      .ms-daw-tile-label { font-size:10px; color:#8888aa; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; padding:4px 0; }
      
      /* Band popover for editing */
      .ms-daw-popover { position:absolute; background:#2a2a3e; border:1px solid #4a4a62; border-radius:8px; padding:12px; z-index:20; min-width:200px; box-shadow:0 8px 24px rgba(0,0,0,0.5); }
      .ms-daw-popover h4 { margin:0 0 10px; font-size:12px; color:#e2e8f0; }
      .ms-daw-popover label { font-size:11px; color:#8888aa; display:block; margin-bottom:4px; }
      .ms-daw-popover input, .ms-daw-popover select { width:100%; padding:6px 8px; background:#1e1e2e; border:1px solid #4a4a62; border-radius:4px; color:#e2e8f0; font-size:12px; box-sizing:border-box; margin-bottom:8px; }
      .ms-daw-popover input:focus, .ms-daw-popover select:focus { outline:none; border-color:#6366f1; }
      .ms-daw-pop-row { display:flex; gap:6px; align-items:center; margin-bottom:8px; }
      .ms-daw-pop-op { width:28px; height:28px; border:1px solid #4a4a62; border-radius:4px; background:transparent; cursor:pointer; font-size:12px; font-weight:600; color:#8888aa; display:flex; align-items:center; justify-content:center; transition:all 0.1s; }
      .ms-daw-pop-op:hover { background:#3a3a52; }
      .ms-daw-pop-op.active { background:#6366f1; color:#fff; border-color:#6366f1; }
      .ms-daw-pop-actions { display:flex; gap:6px; margin-top:10px; padding-top:10px; border-top:1px solid #3a3a52; }
      .ms-daw-pop-btn { flex:1; padding:6px; border:none; border-radius:4px; font-size:11px; font-weight:500; cursor:pointer; }
      .ms-daw-pop-btn-save { background:#6366f1; color:#fff; }
      .ms-daw-pop-btn-save:hover { background:#4f46e5; }
      .ms-daw-pop-btn-del { background:#ef4444; color:#fff; }
      .ms-daw-pop-btn-del:hover { background:#dc2626; }
      .ms-daw-pop-btn-cancel { background:#3a3a52; color:#e2e8f0; }
      
      /* Drop zone highlight */
      .ms-daw-track.drop-target { background:rgba(99,102,241,0.1); outline:2px dashed #6366f1; outline-offset:-2px; }
      
      /* Grid Area */
      .ms-grid-wrapper { flex:1; overflow:auto; background:#fff; }
      
      /* Grid Styles */
      .grid-disabled{position:absolute;width:100%;background-color:#f1f5f9;background-image:linear-gradient(-45deg,#e2e8f0 25%,transparent 25%,transparent 50%,#e2e8f0 50%,#e2e8f0 75%,transparent 75%,transparent);background-size:20px 20px;z-index:1;pointer-events:none}
      .grid-event{z-index:2;position:relative;box-shadow:none; transition:box-shadow 0.15s, outline 0.15s; border-bottom:1px solid rgba(0,0,0,0.1);}
      .grid-event:hover { box-shadow:0 2px 8px rgba(0,0,0,0.15); z-index:3; }
      .grid-event.selected { outline:3px solid #3b82f6; outline-offset:-1px; box-shadow:0 0 0 4px rgba(59,130,246,0.2); z-index:4; }
      .grid-cell{position:relative; border-right:1px solid #e2e8f0; background:#fff;}
      
      /* Resize handles */
      .resize-handle { position:absolute; left:0; right:0; height:8px; cursor:ns-resize; z-index:5; opacity:0; transition:opacity 0.15s; }
      .resize-handle-top { top:-2px; }
      .resize-handle-bottom { bottom:-2px; }
      .grid-event:hover .resize-handle { opacity:1; background:rgba(59,130,246,0.4); }
      .grid-event.resizing { box-shadow:0 0 0 2px #2563eb !important; z-index:100 !important; }
      
      #resize-tooltip { position:fixed; padding:8px 12px; background:#1e293b; color:#fff; border-radius:6px; font-size:12px; font-weight:600; pointer-events:none; z-index:10002; display:none; box-shadow:0 4px 12px rgba(0,0,0,0.25); }
      #drag-ghost { position:fixed; padding:8px 12px; background:#fff; border:2px solid #3b82f6; border-radius:6px; box-shadow:0 4px 12px rgba(59,130,246,0.25); pointer-events:none; z-index:10001; display:none; font-size:12px; }
      .drop-preview { display:none; position:absolute; left:2%; width:96%; background:rgba(59,130,246,0.15); border:2px dashed #3b82f6; border-radius:4px; pointer-events:none; z-index:5; }
      .preview-time-label { text-align:center; padding:6px; color:#1d4ed8; font-weight:600; font-size:11px; background:rgba(255,255,255,0.95); border-radius:3px; margin:3px; }
      
      /* Modal Styles */
      #ms-modal-overlay { position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(15,23,42,0.5); display:flex; align-items:center; justify-content:center; z-index:10000; }
      .ms-modal { background:#fff; border-radius:12px; box-shadow:0 20px 60px rgba(0,0,0,0.3); min-width:280px; max-width:500px; width:95%; max-height:80vh; overflow:hidden; }
      .ms-modal-header { padding:16px 20px; border-bottom:1px solid #e2e8f0; display:flex; align-items:center; justify-content:space-between; }
      .ms-modal-header h3 { margin:0; font-size:16px; font-weight:600; color:#0f172a; }
      .ms-modal-close { background:none; border:none; font-size:20px; color:#94a3b8; cursor:pointer; padding:0; line-height:1; }
      .ms-modal-close:hover { color:#475569; }
      .ms-modal-body { padding:20px; overflow-y:auto; max-height:50vh; }
      .ms-modal-desc { margin:0 0 16px; font-size:13px; color:#64748b; line-height:1.5; }
      .ms-modal-field { margin-bottom:16px; }
      .ms-modal-field:last-child { margin-bottom:0; }
      .ms-modal-field label { display:block; font-size:12px; font-weight:500; color:#475569; margin-bottom:6px; }
      .ms-modal-input { width:100%; padding:10px 12px; border:1px solid #e2e8f0; border-radius:6px; font-size:13px; box-sizing:border-box; }
      .ms-modal-input:focus { outline:none; border-color:#3b82f6; box-shadow:0 0 0 3px rgba(59,130,246,0.1); }
      .ms-modal-footer { padding:16px 20px; border-top:1px solid #e2e8f0; display:flex; justify-content:flex-end; gap:10px; background:#f8fafc; }
      
      .ms-checkbox-group { display:grid; grid-template-columns:repeat(2, 1fr); gap:8px; max-height:200px; overflow-y:auto; padding:8px; background:#f8fafc; border-radius:6px; border:1px solid #e2e8f0; }
      .ms-checkbox-item { display:flex; align-items:center; gap:8px; padding:6px 8px; background:#fff; border-radius:4px; cursor:pointer; font-size:12px; }
      .ms-checkbox-item:hover { background:#f1f5f9; }
      .ms-checkbox-item input { margin:0; }
      .ms-checkbox-item span { color:#334155; }
      
      /* ★ v2.5: Grouped checkbox styles (matches DA bunk overrides) */
      .ms-checkbox-grouped { max-height:250px; overflow-y:auto; padding:8px; background:#f8fafc; border-radius:6px; border:1px solid #e2e8f0; }
      .ms-checkbox-group-header { font-size:11px; font-weight:600; color:#64748b; text-transform:uppercase; letter-spacing:0.5px; padding:8px 4px 4px; margin-top:4px; border-bottom:1px solid #e2e8f0; }
      .ms-checkbox-group-header:first-child { margin-top:0; padding-top:4px; }
      .ms-checkbox-group-items { display:grid; grid-template-columns:repeat(2, 1fr); gap:6px; padding:6px 0; }
      .ms-checkbox-group-empty { font-size:12px; color:#94a3b8; font-style:italic; padding:8px 4px; }
      
      /* Assignments Section */
      .ms-expand { padding:0 16px 12px; }
      .ms-expand-trigger { font-size:12px; color:#3b82f6; cursor:pointer; display:inline-flex; align-items:center; gap:4px; }
      .ms-expand-trigger:hover { text-decoration:underline; }
      .ms-expand-content { margin-top:10px; padding:14px; background:#f8fafc; border-radius:8px; display:none; }
      .ms-expand-content.open { display:block; }
      .ms-assign-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(100px, 1fr)); gap:10px; }
      .ms-assign-item label { display:block; font-size:10px; color:#64748b; margin-bottom:3px; font-weight:500; }
      .ms-assign-item select { width:100%; padding:5px 6px; border:1px solid #e2e8f0; border-radius:4px; font-size:11px; }
    </style>
    
   <!-- Mode Toggle Bar -->
    <div class="ms-mode-toggle" id="ms-mode-toggle" style="margin-bottom:0; padding:8px 16px; background:#fff; border:1px solid #e2e8f0; border-bottom:none; border-radius:12px 12px 0 0;">
      <button class="ms-mode-btn active" data-mode="manual">Manual Build</button>
<button class="ms-mode-btn" data-mode="auto">Auto Build</button>
    </div>
    
    <!-- Manual Mode Container (current system) -->
    <div class="ms-container" id="ms-manual-container" style="border-radius:0 0 12px 12px;">
      <!-- Left Sidebar -->
      <div class="ms-sidebar">
        <div class="ms-sidebar-header">
          <h3>Tile Types</h3>
        </div>
        <div id="scheduler-palette" class="ms-palette"></div>
      </div>
      
      <!-- Main Content -->
      <div class="ms-main">
        <div id="scheduler-toolbar" class="ms-toolbar"></div>
        <div id="scheduler-expand" class="ms-expand"></div>
        <div class="ms-grid-wrapper">
          <div id="scheduler-grid"></div>
        </div>
      </div>
    </div>
    
    <!-- Auto Mode Container (DAW layer timeline) -->
    <div id="ms-auto-container" class="ms-container" style="display:none; border-radius:0 0 12px 12px; background:#1e1e2e;">
      <!-- DAW Sidebar -->
      <div class="ms-daw-sidebar">
        <div class="ms-daw-sidebar-header">
          <h3>Layer Types</h3>
        </div>
        <div id="daw-palette" class="ms-daw-palette"></div>
      </div>
      
      <!-- DAW Main -->
      <div class="ms-auto-container" style="flex:1; display:flex; flex-direction:column; overflow:hidden;">
        <div id="daw-toolbar" class="ms-auto-toolbar"></div>
        <div class="ms-daw-wrapper">
          <div id="daw-grid" class="ms-daw-grid"></div>
        </div>
      </div>
    </div>
  `;
    
  palette = document.getElementById("scheduler-palette");
  grid = document.getElementById("scheduler-grid");
    
  renderToolbar();
  renderExpandSection();
  renderPalette();
  renderGrid();
  
  // Global keyboard listener for Delete key
  document.addEventListener('keydown', handleKeyDown);
}

function handleKeyDown(e) {
  if (e.key === 'Delete' || e.key === 'Backspace') {
    // Don't trigger if typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    
    if (selectedTileId) {
      e.preventDefault();
      deleteTile(selectedTileId);
    }
  }
  // Escape to deselect
  if (e.key === 'Escape') {
    deselectAllTiles();
  }
}

function selectTile(id) {
  deselectAllTiles();
  selectedTileId = id;
  const el = grid.querySelector(`.grid-event[data-id="${id}"]`);
  if (el) el.classList.add('selected');
}

function deselectAllTiles() {
  selectedTileId = null;
  grid.querySelectorAll('.grid-event.selected').forEach(el => el.classList.remove('selected'));
}

async function deleteTile(id) {
  const confirmed = await showConfirm('Delete this block?');
  if (confirmed) {
    dailySkeleton = dailySkeleton.filter(x => x.id !== id);
    selectedTileId = null;
    markUnsavedChanges();
    saveDraftToLocalStorage();
    renderGrid();
  }
}

// --- Render Toolbar ---
function renderToolbar() {
  const toolbar = document.getElementById('scheduler-toolbar');
  if (!toolbar) return;
  
  const saved = window.getSavedSkeletons?.() || {};
  const names = Object.keys(saved).sort();
  const loadOptions = names.map(n => `<option value="${n}">${n}</option>`).join('');
  const assignments = window.getSkeletonAssignments?.() || {};
  
  // Get today's day name
  const dateStr = window.currentScheduleDate || "";
  const [Y, M, D] = dateStr.split('-').map(Number);
  let dow = 0; 
  if (Y && M && D) dow = new Date(Y, M - 1, D).getDay();
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const todayName = dayNames[dow];
  
  // Get the default template for today
  const todayDefault = assignments[todayName] || assignments["Default"] || null;
  
  // If no template is explicitly loaded but there's a default, use that as current
  const effectiveTemplate = currentLoadedTemplate || todayDefault;
  const isFromDefault = !currentLoadedTemplate && todayDefault;
  
  const canUpdate = !!effectiveTemplate;
  const statusClass = hasUnsavedChanges ? 'has-changes' : '';
  
  // Status text logic
  let statusText;
  let statusSubtext = '';
  if (currentLoadedTemplate) {
    statusText = currentLoadedTemplate;
  } else if (todayDefault) {
    statusText = todayDefault;
    statusSubtext = `<span style="font-size:10px;color:#64748b;margin-left:4px;">(${todayName} default)</span>`;
  } else {
    statusText = 'No Template';
  }
  
  const changesBadge = hasUnsavedChanges ? '<span class="ms-status-badge">Unsaved</span>' : '';
  
  toolbar.innerHTML = `
    <!-- Status + Update -->
    <div class="ms-toolbar-group status ${statusClass}">
      <span class="ms-status-label">Current:</span>
      <span class="ms-status-name">${statusText}</span>${statusSubtext}
      ${changesBadge}
    </div>
    <button id="tb-update-btn" class="ms-btn ms-btn-success" ${!canUpdate ? 'disabled' : ''}>
      Update
    </button>
    
    <!-- Load Template -->
    <div class="ms-toolbar-group">
      <span class="ms-toolbar-label">Load:</span>
      <select id="tb-load-select" class="ms-select">
        <option value="">Select...</option>
        ${loadOptions}
      </select>
    </div>
    
    <!-- New + Save -->
    <div class="ms-toolbar-group">
      <span class="ms-toolbar-label">New:</span>
      <input type="text" id="tb-save-name" class="ms-input" placeholder="Template name...">
      <button id="tb-save-btn" class="ms-btn ms-btn-primary">Save</button>
    </div>
    
    <!-- Clear -->
    <button id="tb-clear-btn" class="ms-btn ms-btn-warning ms-btn-icon" title="Clear Grid">
      <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
      Clear
    </button>
    
    <!-- Delete -->
    <div class="ms-toolbar-group" style="border-right:none;">
      <select id="tb-delete-select" class="ms-select" style="min-width:110px;">
        <option value="">Delete...</option>
        ${loadOptions}
      </select>
      <button id="tb-delete-btn" class="ms-btn ms-btn-danger ms-btn-icon" title="Delete Template">
        <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
      </button>
    </div>
  `;
  
  // Bindings
  document.getElementById('tb-load-select').onchange = async function() {
    const name = this.value;
    if (name && saved[name]) {
      const ok = await showConfirm(`Load "${name}"?`);
      if (ok) {
        loadSkeletonToBuilder(name);
      }
    }
    this.value = '';
  };
  
  document.getElementById('tb-update-btn').onclick = async () => {
    const templateToUpdate = currentLoadedTemplate || todayDefault;
    if (!templateToUpdate) return;
    if (!window.AccessControl?.checkSetupAccess('update schedule templates')) return;
    
    const ok = await showConfirm(`Overwrite "${templateToUpdate}" with current grid?`);
    if (ok) {
      window.saveSkeleton?.(templateToUpdate, dailySkeleton);
      window.forceSyncToCloud?.();
      currentLoadedTemplate = templateToUpdate; // Set it as explicitly loaded now
      hasUnsavedChanges = false;
      clearDraftFromLocalStorage();
      await showAlert('Template updated successfully.');
      renderToolbar();
    }
  };
  
  document.getElementById('tb-save-btn').onclick = async () => {
    if (!window.AccessControl?.checkSetupAccess('save schedule templates')) return;
    
    const name = document.getElementById('tb-save-name').value.trim();
    if (!name) {
      await showAlert('Please enter a template name.');
      return;
    }
    
    if (saved[name]) {
      const ok = await showConfirm(`"${name}" already exists. Overwrite?`);
      if (!ok) return;
    }
    
    window.saveSkeleton?.(name, dailySkeleton);
    window.forceSyncToCloud?.();
    currentLoadedTemplate = name;
    hasUnsavedChanges = false;
    clearDraftFromLocalStorage();
    await showAlert('Template saved.');
    document.getElementById('tb-save-name').value = '';
    renderToolbar();
    renderExpandSection();
  };
  
  document.getElementById('tb-clear-btn').onclick = async () => {
    const ok = await showConfirm('Clear grid and start new?');
    if (ok) {
      dailySkeleton = [];
      currentLoadedTemplate = null;
      hasUnsavedChanges = false;
      clearDraftFromLocalStorage();
      renderGrid();
      renderToolbar();
    }
  };
  
  document.getElementById('tb-delete-btn').onclick = async () => {
    if (!window.AccessControl?.checkSetupAccess('delete schedule templates')) return;
    
    const nameToDelete = document.getElementById('tb-delete-select').value;
    if (!nameToDelete) {
      await showAlert('Please select a template to delete.');
      return;
    }
    
    const ok = await showConfirm(`Permanently delete "${nameToDelete}"?`);
    if (ok) {
      if (window.deleteSkeleton) {
        window.deleteSkeleton(nameToDelete);
        window.forceSyncToCloud?.();
        
        if (currentLoadedTemplate === nameToDelete) {
          currentLoadedTemplate = null;
          dailySkeleton = [];
          hasUnsavedChanges = false;
          clearDraftFromLocalStorage();
          renderGrid();
        }
        
        await showAlert('Template deleted.');
        renderToolbar();
        renderExpandSection();
      }
    }
  };
}
// =================================================================
// MODE TOGGLE: Manual ↔ Auto (DAW)
// =================================================================
function setupModeToggle() {
  const toggleBar = document.getElementById('ms-mode-toggle');
  if (!toggleBar) return;
  
  toggleBar.querySelectorAll('.ms-mode-btn').forEach(btn => {
    btn.onclick = () => {
      const mode = btn.dataset.mode;
      if (mode === currentBuilderMode) return;
      
      currentBuilderMode = mode;
      toggleBar.querySelectorAll('.ms-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      const manualEl = document.getElementById('ms-manual-container');
      const autoEl = document.getElementById('ms-auto-container');
      
      if (mode === 'manual') {
        manualEl.style.display = 'flex';
        autoEl.style.display = 'none';
        renderGrid();
      } else {
        manualEl.style.display = 'none';
        autoEl.style.display = 'flex';
        renderDAW();
      }
    };
  });
}

// =================================================================
// DAW (Digital Audio Workstation) LAYER VIEW
// =================================================================
const DAW_LAYER_TYPES = [
  { type:'sport', name:'Sport', color:'#86efac' },
  { type:'special', name:'Special Activity', color:'#c4b5fd' },
  { type:'activity', name:'Activity', color:'#93c5fd' },
  { type:'swim', name:'Swim', color:'#67e8f9', anchor:true },
  { type:'lunch', name:'Lunch', color:'#fca5a5', anchor:true },
  { type:'snacks', name:'Snacks', color:'#fde047', anchor:true },
  { type:'dismissal', name:'Dismissal', color:'#f87171', anchor:true },
  { type:'custom', name:'Custom Pinned', color:'#d1d5db', anchor:true },
  { type:'league', name:'League Game', color:'#a5b4fc' },
  { type:'elective', name:'Elective', color:'#f0abfc' },
];

const DAW_PIXELS_PER_MINUTE = 3;
let dawLayers = {}; // { gradeKey: [{ id, type, startMin, endMin, qty, op }] }
let dawSelectedBand = null;
let dawDragData = null;

function loadDAWLayers() {
  // Load from global settings
  const g = window.loadGlobalSettings?.() || {};
  dawLayers = g.app1?.autoLayerTemplates?.[currentLoadedTemplate || '_current'] || {};
  
  // If empty, seed from divisions
  if (Object.keys(dawLayers).length === 0) {
    const divisions = window.divisions || {};
    Object.keys(divisions).forEach(d => {
      const div = divisions[d];
      if (div.isParent) return;
      dawLayers[d] = [];
    });
  }
}

function saveDAWLayers() {
  const templateKey = currentLoadedTemplate || '_current';
  const g = window.loadGlobalSettings?.() || {};
  if (!g.app1) g.app1 = {};
  if (!g.app1.autoLayerTemplates) g.app1.autoLayerTemplates = {};
  g.app1.autoLayerTemplates[templateKey] = JSON.parse(JSON.stringify(dawLayers));
  window.saveGlobalSettings?.('app1', g.app1);
  window.forceSyncToCloud?.();
}

function renderDAWPalette() {
  const pal = document.getElementById('daw-palette');
  if (!pal) return;
  
  let html = '';
  html += '<div class="ms-daw-tile-label">Floaters</div>';
  DAW_LAYER_TYPES.filter(t => !t.anchor).forEach(t => {
    html += `<div class="ms-daw-tile" draggable="true" data-type="${t.type}" style="color:#e2e8f0;">
      <div class="ms-daw-tile-color" style="background:${t.color};"></div>
      ${t.name}
    </div>`;
  });
  
  html += '<div class="ms-daw-tile-divider"></div>';
  html += '<div class="ms-daw-tile-label">Anchors</div>';
  DAW_LAYER_TYPES.filter(t => t.anchor).forEach(t => {
    html += `<div class="ms-daw-tile" draggable="true" data-type="${t.type}" style="color:#e2e8f0;">
      <div class="ms-daw-tile-color" style="background:${t.color};"></div>
      ${t.name}
    </div>`;
  });
  
  pal.innerHTML = html;
  
  // Drag from palette
  pal.querySelectorAll('.ms-daw-tile').forEach(tile => {
    tile.addEventListener('dragstart', (e) => {
      dawDragData = { source: 'palette', type: tile.dataset.type };
      e.dataTransfer.setData('text/daw-layer', tile.dataset.type);
      e.dataTransfer.effectAllowed = 'copy';
    });
  });
}

function renderDAWToolbar() {
  const toolbar = document.getElementById('daw-toolbar');
  if (!toolbar) return;
  
  const saved = window.getSavedSkeletons?.() || {};
  const names = Object.keys(saved).sort();
  // Also check if there are saved auto layer templates
  const g = window.loadGlobalSettings?.() || {};
  const autoTemplates = g.app1?.autoLayerTemplates || {};
  const autoNames = Object.keys(autoTemplates).filter(n => n !== '_current').sort();
  const loadOptions = autoNames.map(n => `<option value="${n}">${n}</option>`).join('');
  
  toolbar.innerHTML = `
    <div class="ms-toolbar-group status" style="background:#2a2a3e; border-color:#3a3a52;">
      <span class="ms-status-label" style="color:#8888aa;">Template:</span>
      <span class="ms-status-name" style="color:#e2e8f0;">${currentLoadedTemplate || 'Untitled'}</span>
    </div>
    
    <div class="ms-toolbar-group" style="border-color:#3a3a52;">
      <span class="ms-toolbar-label" style="color:#8888aa;">Load:</span>
      <select id="daw-load-select" class="ms-select" style="background:#1e1e2e; color:#e2e8f0; border-color:#4a4a62;">
        <option value="">Select...</option>
        ${loadOptions}
      </select>
    </div>
    
    <div class="ms-toolbar-group" style="border-color:#3a3a52;">
      <input type="text" id="daw-save-name" class="ms-input" placeholder="Template name..." style="background:#1e1e2e; color:#e2e8f0; border-color:#4a4a62;">
      <button id="daw-save-btn" class="ms-btn ms-btn-primary">Save Layers</button>
    </div>
    
    <div class="ms-toolbar-group" style="border-color:#3a3a52;">
      <button id="daw-copy-btn" class="ms-btn ms-btn-ghost" style="background:#2a2a3e; color:#e2e8f0;" title="Copy layers from one grade to others">📋 Copy To...</button>
    </div>
    
    <div style="flex:1;"></div>
    
    <button id="daw-clear-btn" class="ms-btn ms-btn-warning">Clear All</button>
  `;
  
  // Bindings
  document.getElementById('daw-load-select').onchange = async function() {
    const name = this.value;
    if (!name) return;
    if (autoTemplates[name]) {
      const ok = await showConfirm(`Load auto template "${name}"?`);
      if (ok) {
        dawLayers = JSON.parse(JSON.stringify(autoTemplates[name]));
        currentLoadedTemplate = name;
        renderDAW();
      }
    }
    this.value = '';
  };
  
  document.getElementById('daw-save-btn').onclick = async () => {
    const name = document.getElementById('daw-save-name').value.trim();
    if (!name) { await showAlert('Enter a template name.'); return; }
    
    const g2 = window.loadGlobalSettings?.() || {};
    if (!g2.app1) g2.app1 = {};
    if (!g2.app1.autoLayerTemplates) g2.app1.autoLayerTemplates = {};
    g2.app1.autoLayerTemplates[name] = JSON.parse(JSON.stringify(dawLayers));
    window.saveGlobalSettings?.('app1', g2.app1);
    window.forceSyncToCloud?.();
    currentLoadedTemplate = name;
    await showAlert(`Saved auto template "${name}".`);
    renderDAWToolbar();
  };
  
  document.getElementById('daw-clear-btn').onclick = async () => {
    const ok = await showConfirm('Clear all layers from all grades?');
    if (ok) {
      Object.keys(dawLayers).forEach(k => { dawLayers[k] = []; });
      saveDAWLayers();
      renderDAWGrid();
    }
  };
  
  document.getElementById('daw-copy-btn').onclick = () => {
    dawCopyLayersDialog();
  };
}

function renderDAWGrid() {
  const gridEl = document.getElementById('daw-grid');
  if (!gridEl) return;
  
  const divisions = window.divisions || {};
  const grades = Object.keys(divisions).filter(d => !divisions[d].isParent).sort((a, b) => {
    const na = parseInt(a), nb = parseInt(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.localeCompare(b);
  });
  
  if (grades.length === 0) {
    gridEl.innerHTML = '<div style="padding:40px;text-align:center;color:#8888aa;">No grades configured. Go to Setup to create divisions.</div>';
    return;
  }
  
  // Find global time bounds
  let globalStart = 540, globalEnd = 960;
  grades.forEach(g => {
    const div = divisions[g];
    const s = parseTimeToMinutes(div?.startTime);
    const e = parseTimeToMinutes(div?.endTime);
    if (s != null && s < globalStart) globalStart = s;
    if (e != null && e > globalEnd) globalEnd = e;
  });
  
  const totalWidth = (globalEnd - globalStart) * DAW_PIXELS_PER_MINUTE;
  
  let html = '';
  
  // Time ruler
  html += `<div class="ms-daw-ruler" style="width:${totalWidth}px;">`;
  for (let m = globalStart; m < globalEnd; m += 30) {
    const left = (m - globalStart) * DAW_PIXELS_PER_MINUTE;
    html += `<div class="ms-daw-ruler-tick" style="position:absolute;left:${left}px;">${minutesToTime(m)}</div>`;
  }
  html += '</div>';
  
  // Grid lines container (behind bands)
  html += `<div style="position:relative;">`;
  
  // Grade rows
  grades.forEach(gradeKey => {
    const div = divisions[gradeKey];
    const divStart = parseTimeToMinutes(div?.startTime) || globalStart;
    const divEnd = parseTimeToMinutes(div?.endTime) || globalEnd;
    const layers = dawLayers[gradeKey] || [];
    
    // Calculate row height based on layer count (stacking)
    const layerCount = Math.max(1, layers.length);
    const rowHeight = Math.max(80, layerCount * 28 + 16);
    
    html += `<div class="ms-daw-grade" data-grade="${gradeKey}" style="height:${rowHeight}px;">`;
    
    // Grade label
    const bunkCount = (div?.bunks || []).length;
    html += `<div class="ms-daw-grade-label">
      <div class="ms-daw-grade-name">${gradeKey}</div>
      <div class="ms-daw-grade-info">${bunkCount} bunk${bunkCount !== 1 ? 's' : ''} · ${minutesToTime(divStart)}–${minutesToTime(divEnd)}</div>
      <div class="ms-daw-grade-actions">
        <button class="ms-daw-grade-btn" data-action="add-layer" data-grade="${gradeKey}">+ Add</button>
        <button class="ms-daw-grade-btn" data-action="clear-grade" data-grade="${gradeKey}">Clear</button>
      </div>
    </div>`;
    
    // Track area
    html += `<div class="ms-daw-track" data-grade="${gradeKey}" style="width:${totalWidth}px;">`;
    
    // Gridlines
    for (let m = globalStart; m < globalEnd; m += 30) {
      const left = (m - globalStart) * DAW_PIXELS_PER_MINUTE;
      const cls = m % 60 === 0 ? 'major' : '';
      html += `<div class="ms-daw-gridline ${cls}" style="left:${left}px;"></div>`;
    }
    
    // Inactive zones (before div start, after div end)
    if (divStart > globalStart) {
      const w = (divStart - globalStart) * DAW_PIXELS_PER_MINUTE;
      html += `<div style="position:absolute;top:0;left:0;width:${w}px;height:100%;background:rgba(0,0,0,0.3);z-index:1;pointer-events:none;"></div>`;
    }
    if (divEnd < globalEnd) {
      const left = (divEnd - globalStart) * DAW_PIXELS_PER_MINUTE;
      const w = (globalEnd - divEnd) * DAW_PIXELS_PER_MINUTE;
      html += `<div style="position:absolute;top:0;left:${left}px;width:${w}px;height:100%;background:rgba(0,0,0,0.3);z-index:1;pointer-events:none;"></div>`;
    }
    
    // Render bands
    layers.forEach((layer, idx) => {
      const left = (layer.startMin - globalStart) * DAW_PIXELS_PER_MINUTE;
      const width = (layer.endMin - layer.startMin) * DAW_PIXELS_PER_MINUTE;
      const top = 6 + idx * 26;
      const opSymbol = layer.op === '=' ? '=' : layer.op === '<=' ? '≤' : '≥';
      
      html += `<div class="ms-daw-band ${dawSelectedBand === layer.id ? 'selected' : ''}" 
        data-id="${layer.id}" data-type="${layer.type}" data-grade="${gradeKey}"
        style="left:${left}px; width:${width}px; top:${top}px;"
        draggable="true">
        <div class="band-resize band-resize-left"></div>
        <span class="band-label">${DAW_LAYER_TYPES.find(t => t.type === layer.type)?.name || layer.type}</span>
        <span class="band-qty">${opSymbol}${layer.qty}</span>
        <div class="band-resize band-resize-right"></div>
      </div>`;
    });
    
    html += '</div>'; // track
    html += '</div>'; // grade row
  });
  
  html += '</div>'; // relative container
  
  gridEl.innerHTML = html;
  
  // Bind events
  bindDAWEvents(gridEl, globalStart, globalEnd);
}

function bindDAWEvents(gridEl, globalStart, globalEnd) {
  // Click on band to select/edit
  gridEl.querySelectorAll('.ms-daw-band').forEach(band => {
    band.addEventListener('click', (e) => {
      if (e.target.classList.contains('band-resize')) return;
      const id = band.dataset.id;
      const grade = band.dataset.grade;
      dawSelectedBand = dawSelectedBand === id ? null : id;
      
      // Remove existing popovers
      gridEl.querySelectorAll('.ms-daw-popover').forEach(p => p.remove());
      
      if (dawSelectedBand) {
        const layer = (dawLayers[grade] || []).find(l => l.id === id);
        if (layer) showDAWPopover(band, layer, grade);
      }
      
      // Update selection styling
      gridEl.querySelectorAll('.ms-daw-band').forEach(b => b.classList.remove('selected'));
      if (dawSelectedBand) band.classList.add('selected');
    });
    
    // Drag existing band to reposition
    band.addEventListener('dragstart', (e) => {
      if (e.target.classList.contains('band-resize')) { e.preventDefault(); return; }
      const id = band.dataset.id;
      const grade = band.dataset.grade;
      const layer = (dawLayers[grade] || []).find(l => l.id === id);
      if (!layer) return;
      dawDragData = { source: 'band', id, grade, layer, offsetMin: 0 };
      
      const rect = band.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      dawDragData.offsetMin = Math.round(clickX / DAW_PIXELS_PER_MINUTE);
      
      e.dataTransfer.setData('text/daw-band-move', id);
      e.dataTransfer.effectAllowed = 'move';
      band.style.opacity = '0.4';
    });
    
    band.addEventListener('dragend', () => {
      band.style.opacity = '1';
      dawDragData = null;
    });
    
    // Resize handles
    band.querySelectorAll('.band-resize').forEach(handle => {
      let isResizing = false;
      let startX, startMin, startWidth, isLeft;
      
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        isResizing = true;
        isLeft = handle.classList.contains('band-resize-left');
        startX = e.clientX;
        
        const id = band.dataset.id;
        const grade = band.dataset.grade;
        const layer = (dawLayers[grade] || []).find(l => l.id === id);
        if (!layer) return;
        startMin = isLeft ? layer.startMin : layer.endMin;
        
        const onMove = (e2) => {
          if (!isResizing) return;
          const dx = e2.clientX - startX;
          const dMin = Math.round(dx / DAW_PIXELS_PER_MINUTE / SNAP_MINS) * SNAP_MINS;
          const newMin = startMin + dMin;
          
          if (isLeft) {
            layer.startMin = Math.max(globalStart, Math.min(layer.endMin - 15, newMin));
          } else {
            layer.endMin = Math.min(globalEnd, Math.max(layer.startMin + 15, newMin));
          }
          
          // Live update position
          const left = (layer.startMin - globalStart) * DAW_PIXELS_PER_MINUTE;
          const width = (layer.endMin - layer.startMin) * DAW_PIXELS_PER_MINUTE;
          band.style.left = left + 'px';
          band.style.width = width + 'px';
        };
        
        const onUp = () => {
          isResizing = false;
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          saveDAWLayers();
        };
        
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
  });
  
  // Drop on tracks (palette → track, or band move)
  gridEl.querySelectorAll('.ms-daw-track').forEach(track => {
    track.addEventListener('dragover', (e) => {
      const isDawDrop = e.dataTransfer.types.includes('text/daw-layer') || e.dataTransfer.types.includes('text/daw-band-move');
      if (!isDawDrop) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = e.dataTransfer.types.includes('text/daw-band-move') ? 'move' : 'copy';
      track.classList.add('drop-target');
    });
    
    track.addEventListener('dragleave', (e) => {
      if (!track.contains(e.relatedTarget)) track.classList.remove('drop-target');
    });
    
    track.addEventListener('drop', (e) => {
      e.preventDefault();
      track.classList.remove('drop-target');
      
      const grade = track.dataset.grade;
      const rect = track.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const dropMin = Math.round((x / DAW_PIXELS_PER_MINUTE + globalStart) / SNAP_MINS) * SNAP_MINS;
      
      if (e.dataTransfer.types.includes('text/daw-layer')) {
        // New band from palette
        const type = e.dataTransfer.getData('text/daw-layer');
        const layerDef = DAW_LAYER_TYPES.find(t => t.type === type);
        if (!layerDef) return;
        
        const div = (window.divisions || {})[grade] || {};
        const divStart = parseTimeToMinutes(div.startTime) || globalStart;
        const divEnd = parseTimeToMinutes(div.endTime) || globalEnd;
        
        let startMin, endMin;
        if (layerDef.anchor) {
          // Anchors get a fixed 30-min window at drop point
          startMin = Math.max(divStart, dropMin - 15);
          endMin = Math.min(divEnd, startMin + 30);
        } else {
          // Floaters span the full division range
          startMin = divStart;
          endMin = divEnd;
        }
        
        if (!dawLayers[grade]) dawLayers[grade] = [];
        dawLayers[grade].push({
          id: 'daw_' + Math.random().toString(36).slice(2, 9),
          type,
          startMin,
          endMin,
          qty: 1,
          op: layerDef.anchor ? '=' : '>=',
        });
        
        saveDAWLayers();
        renderDAWGrid();
      }
      else if (e.dataTransfer.types.includes('text/daw-band-move') && dawDragData?.source === 'band') {
        // Move existing band
        const { id, grade: fromGrade, layer, offsetMin } = dawDragData;
        const duration = layer.endMin - layer.startMin;
        const newStart = Math.round((dropMin - offsetMin) / SNAP_MINS) * SNAP_MINS;
        const newEnd = newStart + duration;
        
        // Remove from old grade if moving between grades
        if (fromGrade !== grade) {
          dawLayers[fromGrade] = (dawLayers[fromGrade] || []).filter(l => l.id !== id);
          if (!dawLayers[grade]) dawLayers[grade] = [];
          layer.startMin = Math.max(globalStart, newStart);
          layer.endMin = Math.min(globalEnd, newEnd);
          dawLayers[grade].push(layer);
        } else {
          layer.startMin = Math.max(globalStart, newStart);
          layer.endMin = Math.min(globalEnd, newEnd);
        }
        
        saveDAWLayers();
        renderDAWGrid();
      }
      
      dawDragData = null;
    });
  });
  
  // Grade action buttons
  gridEl.querySelectorAll('[data-action="add-layer"]').forEach(btn => {
    btn.onclick = () => {
      const grade = btn.dataset.grade;
      dawAddLayerDialog(grade);
    };
  });
  
  gridEl.querySelectorAll('[data-action="clear-grade"]').forEach(btn => {
    btn.onclick = async () => {
      const grade = btn.dataset.grade;
      const ok = await showConfirm(`Clear all layers from ${grade}?`);
      if (ok) {
        dawLayers[grade] = [];
        saveDAWLayers();
        renderDAWGrid();
      }
    };
  });
  
  // Click on empty track space to deselect
  gridEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('ms-daw-track') || e.target.classList.contains('ms-daw-gridline')) {
      dawSelectedBand = null;
      gridEl.querySelectorAll('.ms-daw-band').forEach(b => b.classList.remove('selected'));
      gridEl.querySelectorAll('.ms-daw-popover').forEach(p => p.remove());
    }
  });
  
  // Keyboard: Delete selected band
  const dawKeyHandler = (e) => {
    if (currentBuilderMode !== 'auto') return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    
    if ((e.key === 'Delete' || e.key === 'Backspace') && dawSelectedBand) {
      e.preventDefault();
      Object.keys(dawLayers).forEach(grade => {
        dawLayers[grade] = (dawLayers[grade] || []).filter(l => l.id !== dawSelectedBand);
      });
      dawSelectedBand = null;
      saveDAWLayers();
      renderDAWGrid();
    }
    if (e.key === 'Escape') {
      dawSelectedBand = null;
      gridEl.querySelectorAll('.ms-daw-band').forEach(b => b.classList.remove('selected'));
      gridEl.querySelectorAll('.ms-daw-popover').forEach(p => p.remove());
    }
  };
  document.removeEventListener('keydown', dawKeyHandler);
  document.addEventListener('keydown', dawKeyHandler);
}

function showDAWPopover(bandEl, layer, grade) {
  // Remove existing
  document.querySelectorAll('.ms-daw-popover').forEach(p => p.remove());
  
  const typeName = DAW_LAYER_TYPES.find(t => t.type === layer.type)?.name || layer.type;
  
  const popover = document.createElement('div');
  popover.className = 'ms-daw-popover';
  popover.innerHTML = `
    <h4>${typeName}</h4>
    <label>Time Window</label>
    <div class="ms-daw-pop-row">
      <input type="text" id="daw-pop-start" value="${minutesToTime(layer.startMin)}" style="width:45%;">
      <span style="color:#8888aa;">→</span>
      <input type="text" id="daw-pop-end" value="${minutesToTime(layer.endMin)}" style="width:45%;">
    </div>
    <label>Quantity</label>
    <div class="ms-daw-pop-row">
      <button class="ms-daw-pop-op ${layer.op === '>=' ? 'active' : ''}" data-op=">=">≥</button>
      <button class="ms-daw-pop-op ${layer.op === '=' ? 'active' : ''}" data-op="=">=</button>
      <button class="ms-daw-pop-op ${layer.op === '<=' ? 'active' : ''}" data-op="<=">≤</button>
      <input type="number" id="daw-pop-qty" value="${layer.qty}" min="1" max="10" style="width:50px;">
    </div>
    <div class="ms-daw-pop-actions">
      <button class="ms-daw-pop-btn ms-daw-pop-btn-save">Save</button>
      <button class="ms-daw-pop-btn ms-daw-pop-btn-del">Delete</button>
      <button class="ms-daw-pop-btn ms-daw-pop-btn-cancel">Close</button>
    </div>
  `;
  
  // Position below the band
  const bandRect = bandEl.getBoundingClientRect();
  const trackRect = bandEl.closest('.ms-daw-track').getBoundingClientRect();
  popover.style.left = (bandRect.left - trackRect.left) + 'px';
  popover.style.top = (bandRect.bottom - trackRect.top + 4) + 'px';
  
  bandEl.closest('.ms-daw-track').appendChild(popover);
  
  // Operator buttons
  popover.querySelectorAll('.ms-daw-pop-op').forEach(btn => {
    btn.onclick = () => {
      popover.querySelectorAll('.ms-daw-pop-op').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    };
  });
  
  // Save
  popover.querySelector('.ms-daw-pop-btn-save').onclick = () => {
    const startStr = popover.querySelector('#daw-pop-start').value;
    const endStr = popover.querySelector('#daw-pop-end').value;
    const s = parseTimeToMinutes(startStr);
    const e2 = parseTimeToMinutes(endStr);
    if (s != null) layer.startMin = s;
    if (e2 != null) layer.endMin = e2;
    layer.qty = parseInt(popover.querySelector('#daw-pop-qty').value) || 1;
    const activeOp = popover.querySelector('.ms-daw-pop-op.active');
    if (activeOp) layer.op = activeOp.dataset.op;
    
    saveDAWLayers();
    renderDAWGrid();
  };
  
  // Delete
  popover.querySelector('.ms-daw-pop-btn-del').onclick = () => {
    dawLayers[grade] = (dawLayers[grade] || []).filter(l => l.id !== layer.id);
    dawSelectedBand = null;
    saveDAWLayers();
    renderDAWGrid();
  };
  
  // Close
  popover.querySelector('.ms-daw-pop-btn-cancel').onclick = () => {
    popover.remove();
    dawSelectedBand = null;
    document.querySelectorAll('.ms-daw-band').forEach(b => b.classList.remove('selected'));
  };
}

async function dawAddLayerDialog(grade) {
  const div = (window.divisions || {})[grade] || {};
  const divStart = parseTimeToMinutes(div.startTime) || 540;
  const divEnd = parseTimeToMinutes(div.endTime) || 960;
  
  const typeOptions = DAW_LAYER_TYPES.map(t => ({ value: t.type, label: t.name }));
  
  const result = await showModal({
    title: `Add Layer to ${grade}`,
    fields: [
      { name: 'type', label: 'Layer Type', type: 'select', options: typeOptions, default: 'activity' },
      { name: 'startTime', label: 'Start Time', type: 'time', default: minutesToTime(divStart), placeholder: '9:00am' },
      { name: 'endTime', label: 'End Time', type: 'time', default: minutesToTime(divEnd), placeholder: '4:00pm' },
    ],
    confirmText: 'Add Layer'
  });
  
  if (!result) return;
  
  const startMin = parseTimeToMinutes(result.startTime) || divStart;
  const endMin = parseTimeToMinutes(result.endTime) || divEnd;
  
  if (!dawLayers[grade]) dawLayers[grade] = [];
  const layerDef = DAW_LAYER_TYPES.find(t => t.type === result.type);
  
  dawLayers[grade].push({
    id: 'daw_' + Math.random().toString(36).slice(2, 9),
    type: result.type,
    startMin: Math.max(divStart, startMin),
    endMin: Math.min(divEnd, endMin),
    qty: 1,
    op: layerDef?.anchor ? '=' : '>=',
  });
  
  saveDAWLayers();
  renderDAWGrid();
}

async function dawCopyLayersDialog() {
  const divisions = window.divisions || {};
  const grades = Object.keys(divisions).filter(d => !divisions[d].isParent).sort();
  
  if (grades.length < 2) {
    await showAlert('Need at least 2 grades to copy between.');
    return;
  }
  
  const result = await showModal({
    title: 'Copy Layers',
    description: 'Copy all layers from one grade to others.',
    fields: [
      { name: 'from', label: 'Copy From', type: 'select', options: grades.map(g => ({ value: g, label: g })) },
      { name: 'to', label: 'Copy To', type: 'checkbox-group', options: grades },
    ],
    confirmText: 'Copy'
  });
  
  if (!result || !result.from || !result.to || result.to.length === 0) return;
  
  const source = dawLayers[result.from] || [];
  let copied = 0;
  result.to.forEach(targetGrade => {
    if (targetGrade === result.from) return;
    // Clone layers with new IDs, adjusting to target division times
    const targetDiv = divisions[targetGrade] || {};
    const tStart = parseTimeToMinutes(targetDiv.startTime) || 540;
    const tEnd = parseTimeToMinutes(targetDiv.endTime) || 960;
    
    dawLayers[targetGrade] = source.map(l => ({
      ...l,
      id: 'daw_' + Math.random().toString(36).slice(2, 9),
      startMin: Math.max(tStart, l.startMin),
      endMin: Math.min(tEnd, l.endMin),
    }));
    copied++;
  });
  
  saveDAWLayers();
  renderDAWGrid();
  await showAlert(`Copied layers to ${copied} grade(s).`);
}

function renderDAW() {
  loadDAWLayers();
  renderDAWPalette();
  renderDAWToolbar();
  renderDAWGrid();
}
function updateToolbarStatus() {
  const statusGroup = document.querySelector('.ms-toolbar-group.status');
  if (statusGroup) {
    statusGroup.classList.toggle('has-changes', hasUnsavedChanges);
    const badge = statusGroup.querySelector('.ms-status-badge');
    if (hasUnsavedChanges && !badge) {
      const nameEl = statusGroup.querySelector('.ms-status-name');
      nameEl.insertAdjacentHTML('afterend', '<span class="ms-status-badge">Unsaved</span>');
    } else if (!hasUnsavedChanges && badge) {
      badge.remove();
    }
  }
}

// --- Render Expand Section (Assignments) ---
function renderExpandSection() {
  const expandEl = document.getElementById('scheduler-expand');
  if (!expandEl) return;
  
  const saved = window.getSavedSkeletons?.() || {};
  const names = Object.keys(saved).sort();
  const assignments = window.getSkeletonAssignments?.() || {};
  const loadOptions = names.map(n => `<option value="${n}">${n}</option>`).join('');
  
  expandEl.innerHTML = `
    <span class="ms-expand-trigger" onclick="this.nextElementSibling.classList.toggle('open')">
      <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
      Day Assignments
    </span>
    <div class="ms-expand-content">
      <div class="ms-assign-grid">
        ${["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Default"].map(day => `
          <div class="ms-assign-item">
            <label>${day}</label>
            <select data-day="${day}">
              <option value="">None</option>
              ${loadOptions}
            </select>
          </div>
        `).join('')}
      </div>
      <button id="assign-save-btn" class="ms-btn ms-btn-success" style="margin-top:12px;">Save Assignments</button>
    </div>
  `;
  
  expandEl.querySelectorAll('select[data-day]').forEach(sel => {
    sel.value = assignments[sel.dataset.day] || '';
  });
  
  document.getElementById('assign-save-btn').onclick = async () => {
    const map = {};
    expandEl.querySelectorAll('select[data-day]').forEach(s => { 
      if (s.value) map[s.dataset.day] = s.value; 
    });
    window.saveSkeletonAssignments?.(map);
    window.forceSyncToCloud?.();
    await showAlert('Assignments saved.');
  };
}

// --- Render Palette ---
function renderPalette() {
  palette.innerHTML = '';
  
  const categories = [
    { label: 'Slots', types: ['activity', 'sports', 'special'] },
    { label: 'Advanced', types: ['smart', 'split', 'elective'] },
    { label: 'Leagues', types: ['league', 'specialty_league'] },
    { label: 'Fixed', types: ['swim', 'lunch', 'snacks', 'dismissal', 'custom'] }
  ];
  
  categories.forEach((cat, catIndex) => {
    const label = document.createElement('div');
    label.className = 'ms-tile-label';
    label.textContent = cat.label;
    palette.appendChild(label);
    
    cat.types.forEach(type => {
      const tile = TILES.find(t => t.type === type);
      if (!tile) return;
      
      const el = document.createElement('div');
      el.className = 'ms-tile';
      el.textContent = tile.name;
      el.style.cssText = tile.style;
      el.draggable = true;
      el.title = tile.description || '';
      
      el.onclick = (e) => {
        if (e.detail === 1) {
          setTimeout(() => {
            if (!el.dragging) showTileInfo(tile);
          }, 200);
        }
      };
      
      el.ondragstart = (e) => { 
        el.dragging = true;
        e.dataTransfer.setData('application/json', JSON.stringify(tile)); 
      };
      el.ondragend = () => { el.dragging = false; };
      
      // Mobile touch — primary handling by mobile_touch_drag.js
      let touchStartY = 0;
      el.addEventListener('touchstart', (e) => {
        touchStartY = e.touches[0].clientY;
        el.dataset.tileData = JSON.stringify(tile);
        if (!window.MobileTouchDrag) el.style.opacity = '0.6';
      });
      
      el.addEventListener('touchend', (e) => {
        el.style.opacity = '1';
        if (window.MobileTouchDrag) return;
        const touch = e.changedTouches[0];
        if (Math.abs(touch.clientY - touchStartY) < 10) {
          showTileInfo(tile);
          return;
        }
        const elementAtPoint = document.elementFromPoint(touch.clientX, touch.clientY);
        const cell = elementAtPoint?.closest('.grid-cell');
        if (cell?.ondrop) {
          cell.ondrop({
            preventDefault: () => {},
            clientX: touch.clientX,
            clientY: touch.clientY,
            dataTransfer: {
              getData: (t) => t === 'application/json' ? JSON.stringify(tile) : '',
              types: ['application/json']
            }
          });
        }
      });
      
      palette.appendChild(el);
    });
    
    if (catIndex < categories.length - 1) {
      const divider = document.createElement('div');
      divider.className = 'ms-tile-divider';
      palette.appendChild(divider);
    }
  });
}

function showTileInfo(tile) {
  const descriptions = {
    'activity': 'ACTIVITY SLOT\n\nA flexible time block where the scheduler assigns either a sport or special activity based on availability and fairness rules.',
    'sports': 'SPORTS SLOT\n\nDedicated time for sports activities only. The scheduler will assign an available field and sport.',
    'special': 'SPECIAL ACTIVITY\n\nTime reserved for special activities like Art, Music, Drama, etc.',
    'smart': 'SMART TILE\n\nCalculates how many bunks can do Main 1 based on capacity:\n\n• Bunks that fit → Main 1\n• Everyone else → Main 2\n• If Main 1 is full → Fallback is used\n\nNext period, groups SWAP:\n• Main 1 bunks → get Main 2\n• Main 2 bunks → get Main 1\n\nExample: Main 1 = Swim (capacity 4), Main 2 = Sports\nPeriod 1: Bunks 1-4 swim, Bunks 5-8 sports\nPeriod 2: Bunks 5-8 swim, Bunks 1-4 sports\n\nNote: Enter tile types (Sports, Special) not specific activities.',
    'split': 'SPLIT ACTIVITY\n\nSplits the division into two groups for the time block:\n\n• First half of time:\n   - Group 1 does Main 1\n   - Group 2 does Main 2\n• Midway through: Groups SWAP\n• Second half of time:\n   - Group 1 does Main 2\n   - Group 2 does Main 1\n\nExamples: Swim, Sports, Art, Special, Activity',
    'elective': 'ELECTIVE\n\nReserves specific fields/activities for THIS division only. Other divisions cannot use them during this time.',
    'league': 'LEAGUE GAME\n\nFull buyout for a regular league matchup. All bunks in the division play head-to-head games.',
    'specialty_league': 'SPECIALTY LEAGUE\n\nSimilar to regular leagues but for special sports.',
    'swim': 'SWIM\n\nPinned swim time. Automatically reserves the pool/swim area.',
    'lunch': 'LUNCH\n\nFixed lunch period. No scheduling occurs during this time.',
    'snacks': 'SNACKS\n\nFixed snack break.',
    'dismissal': 'DISMISSAL\n\nEnd of day marker.',
    'custom': 'CUSTOM PINNED\n\nCreate any fixed event (e.g., Assembly, Davening, Special Program).\n\nYou can reserve specific locations from your Locations settings.'
  };
  showAlert(descriptions[tile.type] || tile.description);
}

// =================================================================
// Color Softening Helper - Makes division colors match soft pastel palette
// =================================================================
function softenColor(hexColor) {
  if (!hexColor) return '#94a3b8';
  
  // Remove # if present
  let hex = hexColor.replace('#', '');
  
  // Handle shorthand hex (e.g., #fff)
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }
  
  // Parse RGB
  let r = parseInt(hex.substring(0, 2), 16);
  let g = parseInt(hex.substring(2, 4), 16);
  let b = parseInt(hex.substring(4, 6), 16);
  
  // If parsing failed, return a default soft color
  if (isNaN(r) || isNaN(g) || isNaN(b)) return '#94a3b8';
  
  // Soften by blending with white to create pastel effect
  // Mix with white at about 40% to match tile palette
  const mixRatio = 0.4;
  r = Math.round(r + (255 - r) * mixRatio);
  g = Math.round(g + (255 - g) * mixRatio);
  b = Math.round(b + (255 - b) * mixRatio);
  
  // Ensure values stay within bounds
  r = Math.min(255, Math.max(0, r));
  g = Math.min(255, Math.max(0, g));
  b = Math.min(255, Math.max(0, b));
  
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// --- RENDER GRID ---
function renderGrid() {
  const divisions = window.divisions || {};
  const availableDivisions = window.availableDivisions || [];

  if (availableDivisions.length === 0) {
    grid.innerHTML = `<div style="padding:40px;text-align:center;color:#64748b;font-size:13px;">
      No divisions found. Please go to Setup to create divisions.
    </div>`;
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

  const latestPinned = Math.max(-Infinity, ...dailySkeleton.map(e => parseTimeToMinutes(e.endTime) || -Infinity));
  if (latestPinned > -Infinity) latestMin = Math.max(latestMin, latestPinned);
  if (latestMin <= earliestMin) latestMin = earliestMin + 60;

  const totalHeight = (latestMin - earliestMin) * PIXELS_PER_MINUTE;

  let html = `<div style="display:grid; grid-template-columns:50px repeat(${availableDivisions.length}, 1fr); position:relative; min-width:700px;">`;
    
  // Header
  html += `<div style="grid-row:1; position:sticky; top:0; background:#f8fafc; z-index:10; border-bottom:1px solid #e2e8f0; padding:10px 6px; font-weight:600; font-size:11px; color:#64748b;">Time</div>`;
  availableDivisions.forEach((divName, i) => {
    const rawColor = divisions[divName]?.color || '#475569';
    const color = softenColor(rawColor);
    html += `<div style="grid-row:1; grid-column:${i+2}; position:sticky; top:0; background:${color}; color:#1e293b; z-index:10; border-bottom:1px solid ${color}; padding:10px 6px; text-align:center; font-weight:600; font-size:12px;">${divName}</div>`;
  });

  // Time Column
  html += `<div style="grid-row:2; grid-column:1; height:${totalHeight}px; position:relative; background:#f8fafc; border-right:1px solid #e2e8f0;">`;
  for (let m = earliestMin; m < latestMin; m += INCREMENT_MINS) {
    const top = (m - earliestMin) * PIXELS_PER_MINUTE;
    html += `<div style="position:absolute; top:${top}px; left:0; width:100%; border-top:1px dashed #e2e8f0; font-size:10px; padding:2px 4px; color:#64748b;">${minutesToTime(m)}</div>`;
  }
  html += `</div>`;

  // Division Columns
  availableDivisions.forEach((divName, i) => {
    const div = divisions[divName];
    const s = parseTimeToMinutes(div?.startTime);
    const e = parseTimeToMinutes(div?.endTime);
      
    html += `<div class="grid-cell" data-div="${divName}" data-start-min="${earliestMin}" style="grid-row:2; grid-column:${i+2}; height:${totalHeight}px;">`;
      
    if (s !== null && s > earliestMin) {
      html += `<div class="grid-disabled" style="top:0; height:${(s - earliestMin) * PIXELS_PER_MINUTE}px;"></div>`;
    }
    if (e !== null && e < latestMin) {
      html += `<div class="grid-disabled" style="top:${(e - earliestMin) * PIXELS_PER_MINUTE}px; height:${(latestMin - e) * PIXELS_PER_MINUTE}px;"></div>`;
    }

    dailySkeleton.filter(ev => ev.division === divName).forEach(ev => {
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
  grid.innerHTML = html;
  grid.dataset.earliestMin = earliestMin;

  addDropListeners('.grid-cell');
  addDragToRepositionListeners(grid);
  addResizeListeners(grid);
  addClickToSelectListeners();
}

function addClickToSelectListeners() {
  grid.querySelectorAll('.grid-event').forEach(el => {
    el.onclick = (e) => {
      if (e.target.classList.contains('resize-handle')) return;
      e.stopPropagation();
      selectTile(el.dataset.id);
    };
    
    // Double-click still works as fallback
    el.ondblclick = async (e) => {
      e.stopPropagation();
      if (e.target.classList.contains('resize-handle')) return;
      await deleteTile(el.dataset.id);
    };
  });
  
  // Click on grid background to deselect
  grid.onclick = (e) => {
    if (e.target.classList.contains('grid-cell') || e.target.id === 'scheduler-grid') {
      deselectAllTiles();
    }
  };
}

// --- Render Tile ---
function renderEventTile(ev, top, height) {
  let tile = TILES.find(t => t.name === ev.event);
  if (!tile && ev.type) tile = TILES.find(t => t.type === ev.type);
  // ★ v2.5: Match DA's fallback logic for slot-type events that don't match by name/type
  if (!tile) {
    if (ev.event === 'General Activity Slot') tile = TILES.find(t => t.type === 'activity');
    else if (ev.event === 'Sports Slot') tile = TILES.find(t => t.type === 'sports');
    else if (ev.event === 'Special Activity') tile = TILES.find(t => t.type === 'special');
    else tile = TILES.find(t => t.type === 'custom');
  }
  const style = tile ? tile.style : 'background:#d1d5db;color:#374151;';
  
  // Add 1px gap at bottom to prevent overlap with next tile
  const adjustedHeight = Math.max(height - 1, 10);
  
  let innerHtml = `
    <div class="tile-header">
      <strong style="font-size:11px;">${ev.event}</strong>
      <div style="font-size:10px;opacity:0.9;">${ev.startTime}-${ev.endTime}</div>
    </div>
  `;
  
  if (ev.location) {
    innerHtml += `<div style="font-size:9px;opacity:0.85;margin-top:2px;">📍 ${ev.location}</div>`;
  } else if (ev.reservedFields?.length > 0 && ev.type !== 'elective') {
    innerHtml += `<div style="font-size:9px;opacity:0.85;margin-top:2px;">📍 ${ev.reservedFields.join(', ')}</div>`;
  }
  
  if (ev.type === 'elective' && ev.electiveActivities?.length > 0) {
    const actList = ev.electiveActivities.slice(0, 3).join(', ');
    const more = ev.electiveActivities.length > 3 ? ` +${ev.electiveActivities.length - 3}` : '';
    innerHtml += `<div style="font-size:9px;opacity:0.85;margin-top:2px;">🎯 ${actList}${more}</div>`;
  }
  
  if (ev.type === 'smart' && ev.smartData) {
    innerHtml += `<div style="font-size:9px;opacity:0.8;margin-top:2px;">Fallback: ${ev.smartData.fallbackActivity}</div>`;
  }
  
  // ★ v2.5: Show split tile sub-events
  if (ev.type === 'split' && ev.subEvents?.length === 2) {
    innerHtml += `<div style="font-size:9px;opacity:0.8;margin-top:2px;">↔ ${ev.subEvents[0].event} / ${ev.subEvents[1].event}</div>`;
  }

  const selectedClass = selectedTileId === ev.id ? ' selected' : '';
  return `<div class="grid-event${selectedClass}" data-id="${ev.id}" draggable="true" title="Click to select, Delete key to remove" 
          style="${style}; position:absolute; top:${top}px; height:${adjustedHeight}px; width:96%; left:2%; padding:5px 7px; font-size:11px; overflow:hidden; border-radius:5px; cursor:pointer; display:flex; flex-direction:column; box-sizing:border-box;">
          <div class="resize-handle resize-handle-top"></div>
          ${innerHtml}
          <div class="resize-handle resize-handle-bottom"></div>
          </div>`;
}

// --- Drop Listeners ---
function addDropListeners(selector) {
  grid.querySelectorAll(selector).forEach(cell => {
    cell.ondragover = e => { e.preventDefault(); cell.style.background = '#ecfdf5'; };
    cell.ondragleave = e => { cell.style.background = ''; };
    cell.ondrop = async e => {
      e.preventDefault();
      cell.style.background = '';

      // Handle moving existing tiles
      if (e.dataTransfer.types.includes('text/event-move')) {
        const eventId = e.dataTransfer.getData('text/event-move');
        const event = dailySkeleton.find(ev => ev.id === eventId);
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
        
        markUnsavedChanges();
        saveDraftToLocalStorage();
        renderGrid();
        return;
      }

      const tileData = JSON.parse(e.dataTransfer.getData('application/json'));
      const divName = cell.dataset.div;
      const earliestMin = parseInt(cell.dataset.startMin);
      
      const rect = cell.getBoundingClientRect();
      const offsetY = e.clientY - rect.top;
      
      let minOffset = Math.round(offsetY / PIXELS_PER_MINUTE / 15) * 15;
      let startMin = earliestMin + minOffset;
      let endMin = startMin + INCREMENT_MINS;
      
      const startStr = minutesToTime(startMin);
      const endStr = minutesToTime(endMin);

      let newEvent = null;
      
      // SMART TILE
      if (tileData.type === 'smart') {
        const result = await showModal({
          title: 'Smart Tile Setup',
          description: 'Fills Main 1 based on capacity, rest get Main 2. Next period they swap. If Main 1 is full, Fallback is used.',
          fields: [
            { name: 'startTime', label: 'Start Time', type: 'text', placeholder: 'e.g., 11:00am' },
            { name: 'endTime', label: 'End Time', type: 'text', placeholder: 'e.g., 11:30am' },
            { name: 'main1', label: 'Main 1 (limited capacity)', type: 'text', placeholder: 'e.g., Special, Swim' },
            { name: 'main2', label: 'Main 2 (everyone else)', type: 'text', placeholder: 'e.g., Sports, Activity' },
            { name: 'fallbackActivity', label: 'Fallback (when Main 1 is full)', type: 'text', default: 'Activity', placeholder: 'e.g., Activity, Sports' }
          ]
        });
        if (!result || !result.main1 || !result.main2) return;
        
        newEvent = {
          id: Date.now().toString(),
          type: 'smart',
          event: `${result.main1} / ${result.main2}`,
          division: divName,
          startTime: result.startTime,
          endTime: result.endTime,
          smartData: { main1: result.main1, main2: result.main2, fallbackFor: result.main1, fallbackActivity: result.fallbackActivity || 'Activity' }
        };
      }
      // ★ v2.5: SPLIT TILE - Fixed to match daily adjustments (Main 1/Main 2 + mapEventNameForOptimizer)
      else if (tileData.type === 'split') {
        const result = await showModal({
          title: 'Split Activity Setup',
          description: 'Splits division into two groups. Midway through the time block, groups SWAP.\n\nExamples: Swim, Sports, Art, Special, Activity',
          fields: [
            { name: 'startTime', label: 'Start Time', type: 'text', placeholder: 'e.g., 11:00am' },
            { name: 'endTime', label: 'End Time', type: 'text', placeholder: 'e.g., 11:30am' },
            { name: 'main1', label: 'Main 1 (Group 1 starts here)', type: 'text', placeholder: 'e.g., Swim, Sports, Art' },
            { name: 'main2', label: 'Main 2 (Group 2 starts here)', type: 'text', placeholder: 'e.g., Sports, Special, Activity' }
          ]
        });
        if (!result || !result.main1 || !result.main2) return;
        
        // Map through optimizer (same as daily adjustments) to get proper type+event structure
        const event1 = mapEventNameForOptimizer(result.main1);
        const event2 = mapEventNameForOptimizer(result.main2);
        
        newEvent = {
          id: Date.now().toString(),
          type: 'split',
          event: `${result.main1} / ${result.main2}`,
          division: divName,
          startTime: result.startTime,
          endTime: result.endTime,
          // CRITICAL: Ensure .event property is always present in subEvents (matches DA)
          subEvents: [
            { ...event1, event: event1.event || result.main1 },
            { ...event2, event: event2.event || result.main2 }
          ]
        };
        
        console.log(`[SPLIT TILE] Created split tile for ${divName}:`, newEvent.subEvents);
      }
      // ELECTIVE
      else if (tileData.type === 'elective') {
        const locations = getAllLocations();
        if (locations.length === 0) {
          await showAlert('No locations configured. Please set up fields/facilities first.');
          return;
        }
        
        const result = await showModal({
          title: `Elective for ${divName}`,
          description: 'Select activities to RESERVE for this division only. Other divisions cannot use these during this time.',
          fields: [
            { name: 'startTime', label: 'Start Time', type: 'text', placeholder: 'e.g., 11:00am' },
            { name: 'endTime', label: 'End Time', type: 'text', placeholder: 'e.g., 11:30am' },
            { name: 'activities', label: 'Reserve Locations', type: 'checkbox-group', options: locations }
          ]
        });
        if (!result || !result.activities?.length) return;
        
        const eventName = `Elective: ${result.activities.slice(0, 3).join(', ')}${result.activities.length > 3 ? '...' : ''}`;
        newEvent = {
          id: Date.now().toString(),
          type: 'elective',
          event: eventName,
          division: divName,
          startTime: result.startTime,
          endTime: result.endTime,
          electiveActivities: result.activities,
          reservedFields: result.activities
        };
      }
      // ★ v2.5: CUSTOM PINNED - Now uses grouped locations from locationZones (matches DA bunk overrides)
      else if (tileData.type === 'custom') {
        const { groups: locationGroups, hasAny: hasLocations } = getGroupedLocationOptions();
        
        // Build modal fields
        const modalFields = [
          { name: 'eventName', label: 'Event Name', type: 'text', default: '', placeholder: 'e.g., Regroup, Assembly, Davening' },
          { name: 'startTime', label: 'Start Time', type: 'text', placeholder: 'e.g., 11:00am' },
          { name: 'endTime', label: 'End Time', type: 'text', placeholder: 'e.g., 11:45am' }
        ];
        
        // Add grouped locations if available
        if (hasLocations) {
          modalFields.push({ name: 'reservedFields', label: 'Reserve Locations (optional)', type: 'grouped-checkbox', groups: locationGroups });
        }
        
        const result = await showModal({
          title: 'Custom Pinned Event',
          description: hasLocations 
            ? 'Create a fixed event. Optionally reserve locations from your setup.'
            : 'Create a fixed event. (No locations found — add them in Setup → Location Zones)',
          fields: modalFields
        });
        if (!result || !result.eventName?.trim()) {
          if (result) await showAlert('Please enter an event name.');
          return;
        }
        
        const reservedFields = result.reservedFields || [];
        newEvent = {
          id: Date.now().toString(),
          type: 'pinned',
          event: result.eventName.trim(),
          division: divName,
          startTime: result.startTime,
          endTime: result.endTime,
          reservedFields: reservedFields,
          location: reservedFields.length === 1 ? reservedFields[0] : null
        };
      }
      // OTHER PINNED (swim, lunch, snacks, dismissal)
      else if (['lunch', 'snacks', 'dismissal', 'swim'].includes(tileData.type)) {
        let name = tileData.name;
        let reservedFields = [];
        let location = window.getPinnedTileDefaultLocation?.(tileData.type) || null;
        
        if (location) reservedFields = [location];
        
        if (tileData.type === 'swim' && reservedFields.length === 0) {
          const globalSettings = window.loadGlobalSettings?.() || {};
          const fields = globalSettings.app1?.fields || [];
          const swimField = fields.find(f => 
            /\bswim\b/i.test(f.name) || /\bpool\b/i.test(f.name)
          );
          if (swimField) {
            reservedFields = [swimField.name];
            location = swimField.name;
          }
        }
        
        const result = await showModal({
          title: name,
          fields: [
            { name: 'startTime', label: 'Start Time', type: 'text', placeholder: 'e.g., 11:00am' },
            { name: 'endTime', label: 'End Time', type: 'text', placeholder: 'e.g., 11:45am' }
          ]
        });
        if (!result) return;
        
        newEvent = {
          id: Date.now().toString(),
          type: 'pinned',
          event: name,
          division: divName,
          startTime: result.startTime,
          endTime: result.endTime,
          reservedFields: reservedFields,
          location: location
        };
      }
      // STANDARD SLOTS & LEAGUES
      else {
        let name = tileData.name;
        let finalType = tileData.type;

        if (tileData.type === 'activity') { name = "General Activity Slot"; finalType = 'slot'; }
        else if (tileData.type === 'sports') { name = "Sports Slot"; finalType = 'slot'; }
        else if (tileData.type === 'special') { name = "Special Activity"; finalType = 'slot'; }
        else if (tileData.type === 'league') { name = "League Game"; finalType = 'league'; }
        else if (tileData.type === 'specialty_league') { name = "Specialty League"; finalType = 'specialty_league'; }
        
        const result = await showModal({
          title: name,
          fields: [
            { name: 'startTime', label: 'Start Time', type: 'text', placeholder: 'e.g., 11:00am' },
            { name: 'endTime', label: 'End Time', type: 'text', placeholder: 'e.g., 11:45am' }
          ]
        });
        if (!result) return;
        
        newEvent = {
          id: Date.now().toString(),
          type: finalType,
          event: name,
          division: divName,
          startTime: result.startTime,
          endTime: result.endTime
        };
      }

      if (newEvent) {
        const newStartVal = parseTimeToMinutes(newEvent.startTime);
        const newEndVal = parseTimeToMinutes(newEvent.endTime);

        // ★ EARLY/LATE TILE GUARD — flag tiles outside 8am-8pm
        // Exception: skip if the division's own time range covers the time
        const GUARD_START = 480;  // 8:00 AM
        const GUARD_END = 1200;   // 8:00 PM
        const guardDiv = (window.divisions || {})[divName] || {};
        const guardDivStart = parseTimeToMinutes(guardDiv.startTime);
        const guardDivEnd = parseTimeToMinutes(guardDiv.endTime);
        const hasDivTimes = (guardDivStart !== null && guardDivEnd !== null);

        const startOutside = newStartVal !== null && (newStartVal < GUARD_START || newStartVal > GUARD_END);
        const endOutside = newEndVal !== null && (newEndVal < GUARD_START || newEndVal > GUARD_END);
        const startCovered = hasDivTimes && newStartVal >= guardDivStart && newStartVal <= guardDivEnd;
        const endCovered = hasDivTimes && newEndVal >= guardDivStart && newEndVal <= guardDivEnd;

        if ((startOutside && !startCovered) || (endOutside && !endCovered)) {
          const ok = await showConfirm(
            `⚠️ This tile (${newEvent.startTime} – ${newEvent.endTime}) has times outside normal camp hours (8:00 AM – 8:00 PM).\n\nJust confirming — is this tile correct?`
          );
          if (!ok) return;
        }

        // Remove overlapping events
        dailySkeleton = dailySkeleton.filter(existing => {
          if (existing.division !== divName) return true;
          const exStart = parseTimeToMinutes(existing.startTime);
          const exEnd = parseTimeToMinutes(existing.endTime);
          if (exStart === null || exEnd === null) return true;
          const overlaps = (exStart < newEndVal) && (exEnd > newStartVal);
          return !overlaps;
        });

        dailySkeleton.push(newEvent);
        markUnsavedChanges();
        saveDraftToLocalStorage();
        renderGrid();
      }
    };
  });
}
// =================================================================
// RESIZE FUNCTIONALITY
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
        const event = dailySkeleton.find(ev => ev.id === eventId);
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
        
        tooltip.innerHTML = `${minutesToTime(newStartMin)} - ${minutesToTime(newEndMin)} (${durationStr})`;
        tooltip.style.display = 'block';
        tooltip.style.left = (e.clientX + 12) + 'px';
        tooltip.style.top = (e.clientY - 30) + 'px';
      }
      
      function onMouseUp() {
        if (!isResizing) return;
        isResizing = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        tile.classList.remove('resizing');
        tooltip.style.display = 'none';
        
        const event = dailySkeleton.find(ev => ev.id === eventId);
        if (!event) return;
        
        const divisions = window.divisions || {};
        const div = divisions[event.division] || {};
        const divStartMin = parseTimeToMinutes(div.startTime) || 540;
        const divEndMin = parseTimeToMinutes(div.endTime) || 960;
        
        const newTop = parseInt(tile.style.top, 10);
        const newHeightPx = parseInt(tile.style.height, 10);
        const newStartMin = earliestMin + (newTop / PIXELS_PER_MINUTE);
        const newEndMin = newStartMin + (newHeightPx / PIXELS_PER_MINUTE);
        
        event.startTime = minutesToTime(Math.max(divStartMin, Math.round(newStartMin / SNAP_MINS) * SNAP_MINS));
        event.endTime = minutesToTime(Math.min(divEndMin, Math.round(newEndMin / SNAP_MINS) * SNAP_MINS));
        
        markUnsavedChanges();
        saveDraftToLocalStorage();
        renderGrid();
      }
      
      handle.addEventListener('dragstart', (e) => { e.preventDefault(); e.stopPropagation(); });
    });
  });
}

// =================================================================
// DRAG-TO-REPOSITION FUNCTIONALITY
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
      const event = dailySkeleton.find(ev => ev.id === eventId);
      if (!event) return;
      
      const duration = parseTimeToMinutes(event.endTime) - parseTimeToMinutes(event.startTime);
      dragData = { type: 'move', id: eventId, event, duration };
      
      e.dataTransfer.setData('text/event-move', eventId);
      e.dataTransfer.effectAllowed = 'move';
      
      ghost.innerHTML = `<strong>${event.event}</strong><br><span style="color:#64748b;">${event.startTime} - ${event.endTime}</span>`;
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
      cell.style.background = '#ecfdf5';
      
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
  });
}

// --- Helpers ---
function loadDailySkeleton() {
  const assignments = window.getSkeletonAssignments?.() || {};
  const skeletons = window.getSavedSkeletons?.() || {};
  const dateStr = window.currentScheduleDate || "";
  const [Y, M, D] = dateStr.split('-').map(Number);
  let dow = 0; if (Y && M && D) dow = new Date(Y, M - 1, D).getDay();
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const today = dayNames[dow];
  let tmpl = assignments[today] || assignments["Default"];
  dailySkeleton = (tmpl && skeletons[tmpl]) ? JSON.parse(JSON.stringify(skeletons[tmpl])) : [];
}

function loadSkeletonToBuilder(name) {
  const all = window.getSavedSkeletons?.() || {};
  if (all[name]) {
    dailySkeleton = JSON.parse(JSON.stringify(all[name]));
    currentLoadedTemplate = name;
    hasUnsavedChanges = false;
  }
  renderGrid();
  renderToolbar();
  renderExpandSection();
  saveDraftToLocalStorage();
}

function parseTimeToMinutes(str) {
  if (!str) return null;
  let s = str.toLowerCase().replace(/am|pm/g, '').trim();
  let [h, m] = s.split(':').map(Number);
  if (str.toLowerCase().includes('pm') && h !== 12) h += 12;
  if (str.toLowerCase().includes('am') && h === 12) h = 0;
  return h * 60 + (m || 0);
}

function minutesToTime(min) {
  let h = Math.floor(min / 60), m = min % 60, ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, '0')}${ap}`;
}
// ★★★ AUTO BUILDER v2: Mode toggle ★★★
function renderModeToggle() {
  const container = document.getElementById('master_scheduler');
  if (!container) return;
  
  // Check if toggle already exists
  if (container.querySelector('.ms-mode-toggle')) return;
  
  const toggle = document.createElement('div');
  toggle.className = 'ms-mode-toggle';
  toggle.style.cssText = 'display:flex; gap:4px; margin-bottom:12px; background:#f1f5f9; border-radius:8px; padding:3px; width:fit-content;';
  
  const btnManual = document.createElement('button');
  btnManual.textContent = 'Manual';
  btnManual.className = 'ms-mode-btn active';
  btnManual.dataset.mode = 'manual';
  
  const btnAuto = document.createElement('button');
  btnAuto.textContent = 'Auto';
  btnAuto.className = 'ms-mode-btn';
  btnAuto.dataset.mode = 'auto';
  
  [btnManual, btnAuto].forEach(btn => {
    btn.style.cssText = 'padding:6px 16px; border:none; border-radius:6px; font-size:0.85rem; font-weight:600; cursor:pointer; transition:all 0.2s;';
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      container.querySelectorAll('.ms-mode-btn').forEach(b => {
        b.classList.toggle('active', b === btn);
        b.style.background = b === btn ? '#147D91' : 'transparent';
        b.style.color = b === btn ? 'white' : '#64748b';
      });
      
      const manualContainer = container.querySelector('.ms-grid-container, .ms-palette-and-grid');
      const autoContainer = container.querySelector('#auto-planner-root');
      
      if (mode === 'auto') {
        if (manualContainer) manualContainer.style.display = 'none';
        if (!autoContainer) {
          const div = document.createElement('div');
          div.id = 'auto-planner-root';
          container.appendChild(div);
          window.AutoSchedulePlanner?.init('auto-planner-root');
        } else {
          autoContainer.style.display = '';
        }
      } else {
        if (manualContainer) manualContainer.style.display = '';
        if (autoContainer) autoContainer.style.display = 'none';
      }
    });
  });
  
  // Set initial styles
  btnManual.style.background = '#147D91';
  btnManual.style.color = 'white';
  btnAuto.style.background = 'transparent';
  btnAuto.style.color = '#64748b';
  
  toggle.appendChild(btnManual);
  toggle.appendChild(btnAuto);
  
  // Insert at top of container
  container.insertBefore(toggle, container.firstChild);
}

// Call after init
const _origInit = init;
init = function() {
  _origInit();
  setTimeout(renderModeToggle, 100);
};
window.initMasterScheduler = init;
// Expose internals for mobile touch support + auto build integration
window.MasterSchedulerInternal = {
  get dailySkeleton() { return dailySkeleton; },
  setSkeleton: function(newSkeleton) { dailySkeleton = newSkeleton; },
  markUnsavedChanges: typeof markUnsavedChanges === 'function' ? markUnsavedChanges : function(){},
  saveDraftToLocalStorage: typeof saveDraftToLocalStorage === 'function' ? saveDraftToLocalStorage : function(){},
  renderGrid: typeof renderGrid === 'function' ? renderGrid : function(){},
  renderPalette: typeof renderPalette === 'function' ? renderPalette : function(){},
  renderToolbar: typeof renderToolbar === 'function' ? renderToolbar : function(){},
  showModal: typeof showModal === 'function' ? showModal : null,
  parseTimeToMinutes: typeof parseTimeToMinutes === 'function' ? parseTimeToMinutes : function(){ return null; },
  minutesToTime: typeof minutesToTime === 'function' ? minutesToTime : function(){ return ''; },
};
})();
