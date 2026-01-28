// =================================================================
// master_schedule_builder.js (UPDATED - REDESIGNED UI)
// Beta v2.4
// Updates:
// 1. Tile palette on LEFT SIDEBAR with solid colors
// 2. Toolbar: Status+Update | Load | New+Save | Clear | Delete
// 3. Delete key support for removing selected tiles
// 4. In-page modal inputs instead of browser prompts
// 5. Checkbox selection for locations/facilities
// 6. Removed draft restore prompt
// =================================================================

(function(){
'use strict';

let container=null, palette=null, grid=null;
let dailySkeleton=[];
let currentLoadedTemplate = null;
let selectedTileId = null;
let hasUnsavedChanges = false;

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
  {type:'smart', name:'Smart Tile', style:'background:#7dd3fc;color:#0c4a6e;border:2px dashed #0284c7;', description:'Balances 2 activities with a fallback.'},
  {type:'split', name:'Split Activity', style:'background:#fdba74;color:#7c2d12;', description:'Two activities share the block (Switch halfway).'},
  {type:'elective', name:'Elective', style:'background:#f0abfc;color:#701a75;', description:'Reserve multiple activities for this division only.'},
  
  // Leagues
  {type:'league', name:'League Game', style:'background:#a5b4fc;color:#312e81;', description:'Regular League slot (Full Buyout).'},
  {type:'specialty_league', name:'Specialty League', style:'background:#d8b4fe;color:#581c87;', description:'Specialty League slot (Full Buyout).'},
  
  // Pinned Events
  {type:'swim', name:'Swim', style:'background:#67e8f9;color:#155e75;', description:'Pinned.'},
  {type:'lunch', name:'Lunch', style:'background:#fca5a5;color:#7f1d1d;', description:'Pinned.'},
  {type:'snacks', name:'Snacks', style:'background:#fde047;color:#713f12;', description:'Pinned.'},
  {type:'dismissal', name:'Dismissal', style:'background:#f87171;color:#fff;', description:'Pinned.'},
  {type:'custom', name:'Custom Pinned', style:'background:#cbd5e1;color:#334155;', description:'Pinned custom (e.g., Regroup).'}
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
// Get all available locations (fields + facilities + special activities)
// =================================================================
function getAllLocations() {
  const globalSettings = window.loadGlobalSettings?.() || {};
  const app1 = globalSettings.app1 || {};
  
  // Get fields
  const fields = (app1.fields || []).map(f => typeof f === 'string' ? f : f.name).filter(Boolean);
  
  // Get special activities
  const specialActivities = (app1.specialActivities || []).map(s => typeof s === 'string' ? s : s.name).filter(Boolean);
  
  // Get facilities - handle both array of strings and array of objects
  const facilities = (app1.facilities || []).map(f => typeof f === 'string' ? f : (f.name || f)).filter(Boolean);
  
  // Get locations if stored separately
  const locations = (app1.locations || []).map(l => typeof l === 'string' ? l : (l.name || l)).filter(Boolean);
  
  // Combine all and remove duplicates
  const all = [...new Set([...fields, ...facilities, ...locations, ...specialActivities])].filter(Boolean).sort();
  
  console.log('[getAllLocations] Found:', { fields, facilities, locations, specialActivities, combined: all });
  
  return all;
}

// =================================================================
// Swim/Pool Alias Handling
// =================================================================
const SWIM_POOL_PATTERNS = ['swim', 'pool', 'swimming', 'aqua'];

function isSwimPoolAlias(name) {
  const lower = (name || '').toLowerCase().trim();
  return SWIM_POOL_PATTERNS.some(p => lower.includes(p));
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
      .ms-container { display:flex; gap:0; min-height:600px; background:#fff; border:1px solid #e2e8f0; border-radius:12px; overflow:hidden; }
      
      /* Left Sidebar */
      .ms-sidebar { width:180px; min-width:180px; background:#f8fafc; border-right:1px solid #e2e8f0; display:flex; flex-direction:column; transition:width 0.2s, min-width 0.2s; }
      .ms-sidebar-header { padding:14px 12px; border-bottom:1px solid #e2e8f0; background:#fff; cursor:pointer; display:flex; align-items:center; justify-content:space-between; user-select:none; }
      .ms-sidebar-header:hover { background:#f8fafc; }
      .ms-sidebar-header h3 { margin:0; font-size:13px; font-weight:600; color:#475569; }
      .ms-collapse-icon { transition:transform 0.2s; color:#94a3b8; }
      .ms-sidebar-header.collapsed .ms-collapse-icon { transform:rotate(-90deg); }
      .ms-palette { flex:1; overflow-y:auto; padding:10px; display:flex; flex-direction:column; gap:6px; transition:opacity 0.2s, max-height 0.3s; }
      .ms-palette.collapsed { opacity:0; max-height:0; overflow:hidden; padding:0 10px; }
      .ms-palette { flex:1; overflow-y:auto; padding:10px; display:flex; flex-direction:column; gap:6px; }
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
      
      /* Grid Area */
      .ms-grid-wrapper { flex:1; overflow:auto; background:#fff; }
      
      /* Grid Styles */
      .grid-disabled{position:absolute;width:100%;background-color:#f1f5f9;background-image:linear-gradient(-45deg,#e2e8f0 25%,transparent 25%,transparent 50%,#e2e8f0 50%,#e2e8f0 75%,transparent 75%,transparent);background-size:20px 20px;z-index:1;pointer-events:none}
      .grid-event{z-index:2;position:relative;box-shadow:0 1px 3px rgba(0,0,0,0.15); transition:box-shadow 0.15s, outline 0.15s;}
      .grid-event.selected { outline:3px solid #3b82f6; outline-offset:-1px; box-shadow:0 0 0 4px rgba(59,130,246,0.2), 0 2px 8px rgba(0,0,0,0.15); }
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
      .ms-modal { background:#fff; border-radius:12px; box-shadow:0 20px 60px rgba(0,0,0,0.3); min-width:360px; max-width:500px; max-height:80vh; overflow:hidden; }
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
    
    <div class="ms-container">
      <!-- Left Sidebar -->
      <div class="ms-sidebar">
        <div class="ms-sidebar-header" onclick="document.getElementById('scheduler-palette').classList.toggle('collapsed'); this.classList.toggle('collapsed');">
          <h3>Tile Types</h3>
          <svg class="ms-collapse-icon" width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
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
      
      // Mobile touch
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
    'smart': 'SMART TILE\n\nBalances two activities across bunks. One group gets Activity A while another gets Activity B, then they swap.',
    'split': 'SPLIT ACTIVITY\n\nDivides the time block in half. First half is one activity, second half is another.',
    'elective': 'ELECTIVE\n\nReserves specific fields/activities for THIS division only. Other divisions cannot use them during this time.',
    'league': 'LEAGUE GAME\n\nFull buyout for a regular league matchup. All bunks in the division play head-to-head games.',
    'specialty_league': 'SPECIALTY LEAGUE\n\nSimilar to regular leagues but for special sports.',
    'swim': 'SWIM\n\nPinned swim time. Automatically reserves the pool/swim area.',
    'lunch': 'LUNCH\n\nFixed lunch period. No scheduling occurs during this time.',
    'snacks': 'SNACKS\n\nFixed snack break.',
    'dismissal': 'DISMISSAL\n\nEnd of day marker.',
    'custom': 'CUSTOM PINNED\n\nCreate any fixed event (e.g., Assembly, Special Program). You can reserve specific locations.'
  };
  showAlert(descriptions[tile.type] || tile.description);
}

// =================================================================
// Color Softening Helper - Makes division colors match soft palette
// =================================================================
function softenColor(hexColor) {
  if (!hexColor) return '#94a3b8';
  
  // Remove # if present
  let hex = hexColor.replace('#', '');
  
  // Parse RGB
  let r = parseInt(hex.substring(0, 2), 16);
  let g = parseInt(hex.substring(2, 4), 16);
  let b = parseInt(hex.substring(4, 6), 16);
  
  // If parsing failed, return a default soft color
  if (isNaN(r) || isNaN(g) || isNaN(b)) return '#94a3b8';
  
  // Soften by blending with white (increase lightness) and reduce saturation
  // Mix with white at about 30-40% to soften
  const mixRatio = 0.35;
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
    // Use darker text for light backgrounds
    const textColor = '#fff';
    html += `<div style="grid-row:1; grid-column:${i+2}; position:sticky; top:0; background:${color}; color:${textColor}; z-index:10; border-bottom:1px solid ${color}; padding:10px 6px; text-align:center; font-weight:600; font-size:12px; text-shadow:0 1px 2px rgba(0,0,0,0.15);">${divName}</div>`;
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
  const style = tile ? tile.style : 'background:#6b7280;color:#fff;';
  
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
    innerHtml += `<div style="font-size:9px;opacity:0.8;margin-top:2px;">↩ ${ev.smartData.fallbackActivity}</div>`;
  }

  const selectedClass = selectedTileId === ev.id ? ' selected' : '';
  return `<div class="grid-event${selectedClass}" data-id="${ev.id}" draggable="true" title="Click to select, Delete key to remove" 
          style="${style}; position:absolute; top:${top}px; height:${height}px; width:96%; left:2%; padding:5px 7px; font-size:11px; overflow:hidden; border-radius:5px; cursor:pointer; display:flex; flex-direction:column;">
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
          description: 'Configure two activities that will be balanced across bunks.',
          fields: [
            { name: 'startTime', label: 'Start Time', type: 'text', default: startStr },
            { name: 'endTime', label: 'End Time', type: 'text', default: endStr },
            { name: 'main1', label: 'Activity 1', type: 'text', placeholder: 'e.g., Swim' },
            { name: 'main2', label: 'Activity 2', type: 'text', placeholder: 'e.g., Art' },
            { name: 'fallbackFor', label: 'Which needs fallback?', type: 'select', options: ['Activity 1', 'Activity 2'] },
            { name: 'fallbackActivity', label: 'Fallback Activity', type: 'text', default: 'Sports' }
          ]
        });
        if (!result || !result.main1 || !result.main2) return;
        
        const fbFor = result.fallbackFor === 'Activity 1' ? result.main1 : result.main2;
        newEvent = {
          id: Date.now().toString(),
          type: 'smart',
          event: `${result.main1} / ${result.main2}`,
          division: divName,
          startTime: result.startTime,
          endTime: result.endTime,
          smartData: { main1: result.main1, main2: result.main2, fallbackFor: fbFor, fallbackActivity: result.fallbackActivity }
        };
      }
      // SPLIT TILE
      else if (tileData.type === 'split') {
        const result = await showModal({
          title: 'Split Activity Setup',
          description: 'Two activities share the block. Groups swap halfway through.',
          fields: [
            { name: 'startTime', label: 'Start Time', type: 'text', default: startStr },
            { name: 'endTime', label: 'End Time', type: 'text', default: endStr },
            { name: 'activity1', label: 'Activity 1 (Group 1 first)', type: 'text', placeholder: 'e.g., Basketball' },
            { name: 'activity2', label: 'Activity 2 (Group 2 first)', type: 'text', placeholder: 'e.g., Soccer' }
          ]
        });
        if (!result || !result.activity1 || !result.activity2) return;
        
        newEvent = {
          id: Date.now().toString(),
          type: 'split',
          event: `${result.activity1} / ${result.activity2}`,
          division: divName,
          startTime: result.startTime,
          endTime: result.endTime,
          subEvents: [{ event: result.activity1 }, { event: result.activity2 }]
        };
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
            { name: 'startTime', label: 'Start Time', type: 'text', default: startStr },
            { name: 'endTime', label: 'End Time', type: 'text', default: endStr },
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
      // CUSTOM PINNED
      else if (tileData.type === 'custom') {
        const locations = getAllLocations();
        
        const result = await showModal({
          title: 'Custom Pinned Event',
          description: 'Create a fixed event. Optionally reserve locations.',
          fields: [
            { name: 'eventName', label: 'Event Name', type: 'text', default: '', placeholder: 'e.g., Regroup, Assembly, Special Program' },
            { name: 'startTime', label: 'Start Time', type: 'text', default: startStr },
            { name: 'endTime', label: 'End Time', type: 'text', default: endStr },
            ...(locations.length > 0 ? [{ name: 'reservedFields', label: 'Reserve Locations (optional)', type: 'checkbox-group', options: locations }] : [])
          ]
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
            f.name.toLowerCase().includes('swim') || f.name.toLowerCase().includes('pool')
          );
          if (swimField) {
            reservedFields = [swimField.name];
            location = swimField.name;
          }
        }
        
        const result = await showModal({
          title: name,
          fields: [
            { name: 'startTime', label: 'Start Time', type: 'text', default: startStr },
            { name: 'endTime', label: 'End Time', type: 'text', default: endStr }
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
            { name: 'startTime', label: 'Start Time', type: 'text', default: startStr },
            { name: 'endTime', label: 'End Time', type: 'text', default: endStr }
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

window.initMasterScheduler = init;

})();
