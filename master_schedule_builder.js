// =================================================================
// master_schedule_builder.js (UPDATED - REDESIGNED UI)
// Beta v2.3
// Updates:
// 1. Moved tile palette to LEFT SIDEBAR
// 2. Redesigned template controls - cleaner, more professional
// 3. Made UPDATE button always visible and prominent
// 4. Professional color palette for all tiles
// 5. Improved overall layout and visual hierarchy
// =================================================================

(function(){
'use strict';

let container=null, palette=null, grid=null;
let dailySkeleton=[];
let currentLoadedTemplate = null;

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

// --- Tiles (Professional Color Palette) ---
const TILES=[
  // Scheduling Slots - Clean accent colors
  {type:'activity', name:'Activity', style:'background:#f0f9ff;border-left:4px solid #0284c7;color:#0c4a6e;', description:'Flexible slot (Sport or Special).'},
  {type:'sports', name:'Sports', style:'background:#f0fdf4;border-left:4px solid #16a34a;color:#14532d;', description:'Sports slot only.'},
  {type:'special', name:'Special Activity', style:'background:#faf5ff;border-left:4px solid #9333ea;color:#581c87;', description:'Special Activity slot only.'},
  
  // Advanced Tiles
  {type:'smart', name:'Smart Tile', style:'background:#eff6ff;border:2px dashed #3b82f6;color:#1e40af;', description:'Balances 2 activities with a fallback.'},
  {type:'split', name:'Split Activity', style:'background:#fff7ed;border-left:4px solid #ea580c;color:#7c2d12;', description:'Two activities share the block (Switch halfway).'},
  {type:'elective', name:'Elective', style:'background:#fdf4ff;border-left:4px solid #c026d3;color:#701a75;', description:'Reserve multiple activities for this division only.'},
  
  // Leagues
  {type:'league', name:'League Game', style:'background:#f5f3ff;border-left:4px solid #7c3aed;color:#4c1d95;', description:'Regular League slot (Full Buyout).'},
  {type:'specialty_league', name:'Specialty League', style:'background:#fffbeb;border-left:4px solid #d97706;color:#78350f;', description:'Specialty League slot (Full Buyout).'},
  
  // Pinned Events
  {type:'swim', name:'Swim', style:'background:#e0f2fe;border-left:4px solid #0891b2;color:#155e75;', description:'Pinned.'},
  {type:'lunch', name:'Lunch', style:'background:#fef2f2;border-left:4px solid #dc2626;color:#7f1d1d;', description:'Pinned.'},
  {type:'snacks', name:'Snacks', style:'background:#fefce8;border-left:4px solid #ca8a04;color:#713f12;', description:'Pinned.'},
  {type:'dismissal', name:'Dismissal', style:'background:#991b1b;color:#fef2f2;border-left:4px solid #450a0a;', description:'Pinned.'},
  {type:'custom', name:'Custom Pinned', style:'background:#f8fafc;border-left:4px solid #475569;color:#1e293b;', description:'Pinned custom (e.g., Regroup).'}
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
// Field Selection Helper for Reserved Fields
// =================================================================
function promptForReservedFields(eventName) {
  const globalSettings = window.loadGlobalSettings?.() || {};
  const app1 = globalSettings.app1 || {};
    
  const allFields = (app1.fields || []).map(f => f.name);
  const specialActivities = (app1.specialActivities || []).map(s => s.name);
    
  const allLocations = [...new Set([...allFields, ...specialActivities])].sort();
    
  if (allLocations.length === 0) {
    return [];
  }
    
  const fieldInput = prompt(
    `Which field(s) will "${eventName}" use?\n\n` +
    `This reserves the field so the scheduler won't assign it to other bunks.\n\n` +
    `Available fields:\n${allLocations.join(', ')}\n\n` +
    `Enter field names separated by commas (or leave blank if none):`,
    ''
  );
    
  if (!fieldInput || !fieldInput.trim()) {
    return [];
  }
    
  const requested = fieldInput.split(',').map(f => f.trim()).filter(Boolean);
  const validated = [];
  const invalid = [];
    
  requested.forEach(name => {
    const match = allLocations.find(loc => loc.toLowerCase() === name.toLowerCase());
    if (match) {
      validated.push(match);
    } else {
      invalid.push(name);
    }
  });
    
  if (invalid.length > 0) {
    alert(`Warning: These fields were not found and will be ignored:\n${invalid.join(', ')}`);
  }
    
  return validated;
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

// =================================================================
// Elective Activity Selection Helper
// =================================================================
function promptForElectiveActivities(divName) {
  const globalSettings = window.loadGlobalSettings?.() || {};
  const app1 = globalSettings.app1 || {};
    
  const allFields = (app1.fields || []).map(f => f.name);
  const specialActivities = (app1.specialActivities || []).map(s => s.name);
  const allLocations = [...new Set([...allFields, ...specialActivities])].sort();
    
  console.log('[Elective] Available locations:', allLocations);
    
  if (allLocations.length === 0) {
    alert('No fields or special activities configured. Please set them up first.');
    return null;
  }
    
  const poolFieldName = findPoolField(allLocations);
  console.log('[Elective] Pool field found:', poolFieldName);
    
  const activitiesInput = prompt(
    `ELECTIVE for ${divName}\n\n` +
    `Enter activities to RESERVE for this division (separated by commas).\n` +
    `Other divisions will NOT be able to use these during this time.\n\n` +
    `Available:\n${allLocations.join(', ')}\n\n` +
    `Tip: "Swim" or "Pool" will work for your swimming area.\n\n` +
    `Example: Swim, Court 1, Canteen`,
    ''
  );
    
  if (!activitiesInput || !activitiesInput.trim()) {
    return null;
  }
    
  const requested = activitiesInput.split(',').map(s => s.trim()).filter(Boolean);
  const validated = [];
  const invalid = [];
    
  requested.forEach(name => {
    console.log(`[Elective] Processing: "${name}"`);
      
    if (isSwimPoolAlias(name)) {
      console.log(`[Elective] "${name}" is a swim/pool alias`);
      if (poolFieldName) {
        if (!validated.includes(poolFieldName)) {
          validated.push(poolFieldName);
          console.log(`[Elective] Resolved "${name}" → "${poolFieldName}"`);
        }
      } else {
        if (!validated.includes(name)) {
          validated.push(name);
          console.log(`[Elective] No pool field found, adding "${name}" as-is`);
        }
      }
      return;
    }
      
    const match = allLocations.find(loc => loc.toLowerCase() === name.toLowerCase());
    if (match) {
      if (!validated.includes(match)) {
        validated.push(match);
      }
    } else {
      invalid.push(name);
    }
  });
    
  console.log('[Elective] Validated:', validated);
  console.log('[Elective] Invalid:', invalid);
    
  if (validated.length === 0) {
    alert('No valid activities selected. Please try again.');
    return null;
  }
    
  if (invalid.length > 0) {
    alert(`Warning: These were not found and will be ignored:\n${invalid.join(', ')}`);
  }
    
  return validated;
}

// --- Init ---
function init(){
  container=document.getElementById("master-scheduler-content");
  if(!container) return;
    
  loadDailySkeleton();

  const savedDraft = localStorage.getItem(SKELETON_DRAFT_KEY);
  const savedDraftName = localStorage.getItem(SKELETON_DRAFT_NAME_KEY);

  if (savedDraft) {
    if (confirm("Load unsaved master schedule draft?")) {
      dailySkeleton = JSON.parse(savedDraft);
      if(savedDraftName) currentLoadedTemplate = savedDraftName;
    } else {
      clearDraftFromLocalStorage();
    }
  }

  // Inject HTML + CSS with new layout
  container.innerHTML=`
    <style>
      /* === MASTER SCHEDULER STYLES === */
      .ms-container { display:flex; gap:0; min-height:600px; background:#fff; border:1px solid #e2e8f0; border-radius:12px; overflow:hidden; }
      
      /* Left Sidebar - Tile Palette */
      .ms-sidebar { width:200px; min-width:200px; background:#f8fafc; border-right:1px solid #e2e8f0; display:flex; flex-direction:column; }
      .ms-sidebar-header { padding:16px; border-bottom:1px solid #e2e8f0; background:#fff; }
      .ms-sidebar-header h3 { margin:0; font-size:14px; font-weight:600; color:#334155; text-transform:uppercase; letter-spacing:0.5px; }
      .ms-palette { flex:1; overflow-y:auto; padding:12px; display:flex; flex-direction:column; gap:8px; }
      .ms-tile { padding:10px 12px; border-radius:6px; cursor:grab; font-size:13px; font-weight:500; transition:transform 0.15s, box-shadow 0.15s; }
      .ms-tile:hover { transform:translateX(4px); box-shadow:0 2px 8px rgba(0,0,0,0.1); }
      .ms-tile:active { cursor:grabbing; }
      .ms-tile-divider { height:1px; background:#e2e8f0; margin:8px 0; }
      .ms-tile-label { font-size:11px; color:#64748b; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; padding:4px 0; }
      
      /* Main Content Area */
      .ms-main { flex:1; display:flex; flex-direction:column; overflow:hidden; }
      
      /* Template Controls Header */
      .ms-header { background:#fff; border-bottom:1px solid #e2e8f0; padding:16px 20px; }
      .ms-header-row { display:flex; align-items:center; gap:16px; flex-wrap:wrap; }
      .ms-status { display:flex; align-items:center; gap:8px; padding:8px 16px; background:#f1f5f9; border-radius:8px; }
      .ms-status-dot { width:8px; height:8px; border-radius:50%; }
      .ms-status-dot.new { background:#94a3b8; }
      .ms-status-dot.editing { background:#22c55e; }
      .ms-status-text { font-size:13px; color:#475569; }
      .ms-status-name { font-weight:600; color:#0f172a; }
      
      .ms-control-group { display:flex; align-items:center; gap:8px; }
      .ms-control-group label { font-size:12px; color:#64748b; font-weight:500; }
      .ms-select { padding:8px 12px; border:1px solid #e2e8f0; border-radius:6px; font-size:13px; background:#fff; min-width:140px; }
      .ms-select:focus { outline:none; border-color:#3b82f6; box-shadow:0 0 0 3px rgba(59,130,246,0.1); }
      .ms-input { padding:8px 12px; border:1px solid #e2e8f0; border-radius:6px; font-size:13px; width:150px; }
      .ms-input:focus { outline:none; border-color:#3b82f6; box-shadow:0 0 0 3px rgba(59,130,246,0.1); }
      
      .ms-btn { padding:8px 16px; border:none; border-radius:6px; font-size:13px; font-weight:500; cursor:pointer; transition:all 0.15s; display:inline-flex; align-items:center; gap:6px; }
      .ms-btn-primary { background:#3b82f6; color:#fff; }
      .ms-btn-primary:hover { background:#2563eb; }
      .ms-btn-success { background:#22c55e; color:#fff; }
      .ms-btn-success:hover { background:#16a34a; }
      .ms-btn-warning { background:#f59e0b; color:#fff; }
      .ms-btn-warning:hover { background:#d97706; }
      .ms-btn-danger { background:#ef4444; color:#fff; }
      .ms-btn-danger:hover { background:#dc2626; }
      .ms-btn-ghost { background:#f1f5f9; color:#475569; }
      .ms-btn-ghost:hover { background:#e2e8f0; }
      .ms-btn:disabled { opacity:0.5; cursor:not-allowed; }
      
      .ms-divider { width:1px; height:32px; background:#e2e8f0; margin:0 8px; }
      
      /* Expandable Section */
      .ms-expand { margin-top:12px; }
      .ms-expand-trigger { font-size:13px; color:#3b82f6; cursor:pointer; display:inline-flex; align-items:center; gap:4px; }
      .ms-expand-trigger:hover { text-decoration:underline; }
      .ms-expand-content { margin-top:12px; padding:16px; background:#f8fafc; border-radius:8px; display:none; }
      .ms-expand-content.open { display:block; }
      .ms-assign-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(120px, 1fr)); gap:12px; }
      .ms-assign-item label { display:block; font-size:11px; color:#64748b; margin-bottom:4px; font-weight:500; }
      .ms-assign-item select { width:100%; padding:6px 8px; border:1px solid #e2e8f0; border-radius:4px; font-size:12px; }
      .ms-delete-section { margin-top:16px; padding-top:16px; border-top:1px solid #e2e8f0; display:flex; align-items:center; gap:12px; }
      
      /* Grid Area */
      .ms-grid-wrapper { flex:1; overflow:auto; background:#fff; }
      
      /* Grid Styles */
      .grid-disabled{position:absolute;width:100%;background-color:#f1f5f9;background-image:linear-gradient(-45deg,#e2e8f0 25%,transparent 25%,transparent 50%,#e2e8f0 50%,#e2e8f0 75%,transparent 75%,transparent);background-size:20px 20px;z-index:1;pointer-events:none}
      .grid-event{z-index:2;position:relative;box-shadow:0 1px 3px rgba(0,0,0,0.12);}
      .grid-cell{position:relative; border-right:1px solid #e2e8f0; background:#fff;}
      
      /* Resize handles */
      .resize-handle { position:absolute; left:0; right:0; height:10px; cursor:ns-resize; z-index:5; opacity:0; transition:opacity 0.15s; }
      .resize-handle-top { top:-2px; }
      .resize-handle-bottom { bottom:-2px; }
      .grid-event:hover .resize-handle { opacity:1; background:rgba(37,99,235,0.3); }
      .grid-event.resizing { box-shadow:0 0 0 2px #2563eb, 0 4px 12px rgba(37,99,235,0.25) !important; z-index:100 !important; }
      
      /* Resize tooltip */
      #resize-tooltip { position:fixed; padding:10px 14px; background:#111827; color:#fff; border-radius:8px; font-size:0.9em; font-weight:600; pointer-events:none; z-index:10002; display:none; box-shadow:0 8px 24px rgba(15,23,42,0.35); text-align:center; line-height:1.4; }
      #resize-tooltip span { font-size:0.85em; opacity:0.7; }
      
      /* Drag ghost */
      #drag-ghost { position:fixed; padding:10px 14px; background:#ffffff; border:2px solid #2563eb; border-radius:8px; box-shadow:0 8px 24px rgba(37,99,235,0.25); pointer-events:none; z-index:10001; display:none; font-size:0.9em; color:#111827; }
      #drag-ghost span { color:#6b7280; }
      
      /* Drop preview */
      .drop-preview { display:none; position:absolute; left:2%; width:96%; background:rgba(37,99,235,0.15); border:2px dashed #2563eb; border-radius:4px; pointer-events:none; z-index:5; }
      .preview-time-label { text-align:center; padding:8px 4px; color:#1d4ed8; font-weight:700; font-size:0.9em; background:rgba(255,255,255,0.95); border-radius:3px; margin:4px; box-shadow:0 2px 6px rgba(0,0,0,0.1); }
    </style>
    
    <div class="ms-container">
      <!-- Left Sidebar - Tile Palette -->
      <div class="ms-sidebar">
        <div class="ms-sidebar-header">
          <h3>Block Types</h3>
        </div>
        <div id="scheduler-palette" class="ms-palette"></div>
      </div>
      
      <!-- Main Content -->
      <div class="ms-main">
        <!-- Header Controls -->
        <div id="scheduler-template-ui" class="ms-header"></div>
        
        <!-- Grid -->
        <div class="ms-grid-wrapper">
          <div id="scheduler-grid"></div>
        </div>
      </div>
    </div>
  `;
    
  palette=document.getElementById("scheduler-palette");
  grid=document.getElementById("scheduler-grid");
    
  renderTemplateUI();
  renderPalette();
  renderGrid();
}

// --- Render Template Controls (Redesigned) ---
function renderTemplateUI(){
  const ui=document.getElementById("scheduler-template-ui");
  if(!ui) return;
  const saved=window.getSavedSkeletons?.()||{};
  const names=Object.keys(saved).sort();
  const assignments=window.getSkeletonAssignments?.()||{};
  let loadOptions=names.map(n=>`<option value="${n}">${n}</option>`).join('');

  const isEditing = !!currentLoadedTemplate;
  const statusDotClass = isEditing ? 'editing' : 'new';
  const statusText = isEditing ? `Editing: <span class="ms-status-name">${currentLoadedTemplate}</span>` : 'New Schedule';

  ui.innerHTML=`
    <!-- Main Controls Row -->
    <div class="ms-header-row">
      <!-- Status Badge -->
      <div class="ms-status">
        <div class="ms-status-dot ${statusDotClass}"></div>
        <span class="ms-status-text">${statusText}</span>
      </div>
      
      <div class="ms-divider"></div>
      
      <!-- Load Template -->
      <div class="ms-control-group">
        <label>Load:</label>
        <select id="template-load-select" class="ms-select">
          <option value="">Select template...</option>
          ${loadOptions}
        </select>
      </div>
      
      <div class="ms-divider"></div>
      
      <!-- Update Button (Always visible, disabled if no template) -->
      <button id="template-update-btn" class="ms-btn ms-btn-success" ${!isEditing ? 'disabled title="Load a template to update"' : ''}>
        <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>
        Update${isEditing ? ` "${currentLoadedTemplate}"` : ''}
      </button>
      
      <!-- Save As New -->
      <div class="ms-control-group">
        <input type="text" id="template-save-name" class="ms-input" placeholder="New template name...">
        <button id="template-save-btn" class="ms-btn ms-btn-primary">Save As New</button>
      </div>
      
      <div class="ms-divider"></div>
      
      <!-- Clear -->
      <button id="template-clear-btn" class="ms-btn ms-btn-warning">
        <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
        New
      </button>
    </div>
    
    <!-- Expandable Assignments & Delete Section -->
    <div class="ms-expand">
      <span class="ms-expand-trigger" onclick="this.nextElementSibling.classList.toggle('open')">
        <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
        Day Assignments & Delete Options
      </span>
      <div class="ms-expand-content">
        <div class="ms-assign-grid">
          ${["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Default"].map(day=>`
            <div class="ms-assign-item">
              <label>${day}</label>
              <select data-day="${day}">
                <option value="">None</option>
                ${loadOptions}
              </select>
            </div>
          `).join('')}
        </div>
        <button id="template-assign-save-btn" class="ms-btn ms-btn-success" style="margin-top:16px;">
          <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
          Save Assignments
        </button>
        
        <div class="ms-delete-section">
          <label style="font-size:13px;color:#64748b;">Delete Template:</label>
          <select id="template-delete-select" class="ms-select" style="min-width:160px;">
            <option value="">Select to delete...</option>
            ${loadOptions}
          </select>
          <button id="template-delete-btn" class="ms-btn ms-btn-danger">
            <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
            Delete
          </button>
        </div>
      </div>
    </div>
  `;

  // Bindings
  const loadSel=document.getElementById("template-load-select");
  const saveName=document.getElementById("template-save-name");
    
  loadSel.onchange=()=>{
    const name=loadSel.value;
    if(name && saved[name] && confirm(`Load "${name}"?`)){
      loadSkeletonToBuilder(name);
      saveName.value=name; 
    }
  };

  // 1. UPDATE EXISTING
  const updateBtn = document.getElementById("template-update-btn");
  if(updateBtn) {
      updateBtn.onclick = () => {
          if (!currentLoadedTemplate) {
              alert("No template loaded. Load a template first or use 'Save As New'.");
              return;
          }
          
          // RBAC Check
          if (!window.AccessControl?.checkSetupAccess('update schedule templates')) return;
          
          if(confirm(`Overwrite "${currentLoadedTemplate}" with current grid?`)){
              window.saveSkeleton?.(currentLoadedTemplate, dailySkeleton);
              window.forceSyncToCloud?.();
              
              clearDraftFromLocalStorage();
              alert("Updated successfully.");
              renderTemplateUI();
          }
      };
  }

  // 2. SAVE AS NEW
  document.getElementById("template-save-btn").onclick=()=>{
    if (!window.AccessControl?.checkSetupAccess('save schedule templates')) return;
    
    const name=saveName.value.trim();
    if(!name) { alert("Please enter a name."); return; }
    
    if(saved[name] && !confirm(`"${name}" already exists. Overwrite?`)) return;

    window.saveSkeleton?.(name, dailySkeleton);
    window.forceSyncToCloud?.();
    
    currentLoadedTemplate = name;
    clearDraftFromLocalStorage();
    alert("Saved.");
    renderTemplateUI();
  };

  // 3. CLEAR / NEW
  document.getElementById("template-clear-btn").onclick=()=>{
    if(confirm("Clear grid and start new?")) {
        dailySkeleton=[];
        currentLoadedTemplate = null;
        clearDraftFromLocalStorage();
        renderGrid();
        renderTemplateUI();
    }
  };

  // 4. ASSIGNMENTS
  ui.querySelectorAll('select[data-day]').forEach(sel=>{
      const day=sel.dataset.day;
      sel.value=assignments[day]||"";
  });

  document.getElementById("template-assign-save-btn").onclick=()=>{
      const map={};
      ui.querySelectorAll('select[data-day]').forEach(s=>{ if(s.value) map[s.dataset.day]=s.value; });
      window.saveSkeletonAssignments?.(map);
      window.forceSyncToCloud?.();
      
      alert("Assignments Saved.");
  };

  // 5. DELETE
  document.getElementById("template-delete-btn").onclick=()=>{
      if (!window.AccessControl?.checkSetupAccess('delete schedule templates')) return;
      
      const delSel = document.getElementById("template-delete-select");
      const nameToDelete = delSel.value;
        
      if(!nameToDelete) {
          alert("Please select a template to delete.");
          return;
      }

      if(confirm(`Permanently delete "${nameToDelete}"?`)){
          if(window.deleteSkeleton) {
              window.deleteSkeleton(nameToDelete);
              window.forceSyncToCloud?.();
                
              if(currentLoadedTemplate === nameToDelete){
                  currentLoadedTemplate = null;
                  dailySkeleton = [];
                  clearDraftFromLocalStorage();
                  renderGrid();
              }
                
              alert("Deleted.");
              renderTemplateUI();
          } else {
              alert("Error: 'window.deleteSkeleton' function not defined.");
          }
      }
  };
}

// --- Render Palette (Vertical Layout with Categories) ---
function renderPalette(){
  palette.innerHTML='';
  
  // Category labels
  const categories = [
    { label: 'Scheduling Slots', types: ['activity', 'sports', 'special'] },
    { label: 'Advanced', types: ['smart', 'split', 'elective'] },
    { label: 'Leagues', types: ['league', 'specialty_league'] },
    { label: 'Fixed Events', types: ['swim', 'lunch', 'snacks', 'dismissal', 'custom'] }
  ];
  
  categories.forEach((cat, catIndex) => {
    // Add label
    const label = document.createElement('div');
    label.className = 'ms-tile-label';
    label.textContent = cat.label;
    palette.appendChild(label);
    
    // Add tiles for this category
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
            if (!el.dragging) {
              showTileInfo(tile);
            }
          }, 200);
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
        const touchEndY = touch.clientY;
        
        if (Math.abs(touchEndY - touchStartY) < 10) {
          showTileInfo(tile);
          return;
        }

        const elementAtPoint = document.elementFromPoint(touch.clientX, touch.clientY);
        const cell = elementAtPoint ? elementAtPoint.closest('.grid-cell') : null;
        
        if (cell && cell.ondrop) {
           const fakeEvent = {
             preventDefault: () => {},
             clientX: touch.clientX,
             clientY: touch.clientY,
             dataTransfer: {
               getData: (type) => {
                 if (type === 'application/json') return JSON.stringify(tile);
                 return '';
               },
               types: ['application/json']
             }
           };
           cell.ondrop(fakeEvent);
        }
      });
      
      palette.appendChild(el);
    });
    
    // Add divider (except after last category)
    if (catIndex < categories.length - 1) {
      const divider = document.createElement('div');
      divider.className = 'ms-tile-divider';
      palette.appendChild(divider);
    }
  });
}

// --- Tile Info Popup ---
function showTileInfo(tile) {
  const descriptions = {
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
    
  const desc = descriptions[tile.type] || tile.description || 'No description available.';
  alert(`${tile.name.toUpperCase()}\n\n${desc}`);
}

// --- RENDER GRID ---
function renderGrid(){
  const divisions=window.divisions||{};
  const availableDivisions=window.availableDivisions||[];

  if (availableDivisions.length === 0) {
      grid.innerHTML = `<div style="padding:40px;text-align:center;color:#64748b;font-size:14px;">
        <svg width="48" height="48" fill="none" stroke="currentColor" viewBox="0 0 24 24" style="margin:0 auto 12px;opacity:0.5;display:block;">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
        </svg>
        No divisions found. Please go to Setup to create divisions.
      </div>`;
      return;
  }

  let earliestMin=null, latestMin=null;
  Object.values(divisions).forEach(div=>{
    const s=parseTimeToMinutes(div.startTime);
    const e=parseTimeToMinutes(div.endTime);
    if(s!==null && (earliestMin===null || s<earliestMin)) earliestMin=s;
    if(e!==null && (latestMin===null || e>latestMin)) latestMin=e;
  });
  if(earliestMin===null) earliestMin=540;
  if(latestMin===null) latestMin=960;

  const latestPinned=Math.max(-Infinity, ...dailySkeleton.map(e=>parseTimeToMinutes(e.endTime)|| -Infinity));
  if(latestPinned > -Infinity) latestMin = Math.max(latestMin, latestPinned);
  if(latestMin <= earliestMin) latestMin = earliestMin + 60;

  const totalHeight = (latestMin - earliestMin) * PIXELS_PER_MINUTE;

  let html=`<div style="display:grid; grid-template-columns:60px repeat(${availableDivisions.length}, 1fr); position:relative; min-width:800px;">`;
    
  // Header Row
  html+=`<div style="grid-row:1; position:sticky; top:0; background:#f8fafc; z-index:10; border-bottom:1px solid #e2e8f0; padding:12px 8px; font-weight:600; font-size:12px; color:#64748b; text-transform:uppercase; letter-spacing:0.5px;">Time</div>`;
  availableDivisions.forEach((divName,i)=>{
      const color = divisions[divName]?.color || '#475569';
      html+=`<div style="grid-row:1; grid-column:${i+2}; position:sticky; top:0; background:${color}; color:#fff; z-index:10; border-bottom:1px solid ${color}; padding:12px 8px; text-align:center; font-weight:600; font-size:13px;">${divName}</div>`;
  });

  // Time Column
  html+=`<div style="grid-row:2; grid-column:1; height:${totalHeight}px; position:relative; background:#f8fafc; border-right:1px solid #e2e8f0;">`;
  for(let m=earliestMin; m<latestMin; m+=INCREMENT_MINS){
      const top=(m-earliestMin)*PIXELS_PER_MINUTE;
      html+=`<div style="position:absolute; top:${top}px; left:0; width:100%; border-top:1px dashed #e2e8f0; font-size:11px; padding:2px 4px; color:#64748b;">${minutesToTime(m)}</div>`;
  }
  html+=`</div>`;

  // Division Columns
  availableDivisions.forEach((divName,i)=>{
      const div=divisions[divName];
      const s=parseTimeToMinutes(div?.startTime);
      const e=parseTimeToMinutes(div?.endTime);
        
      html+=`<div class="grid-cell" data-div="${divName}" data-start-min="${earliestMin}" style="grid-row:2; grid-column:${i+2}; height:${totalHeight}px;">`;
        
      if(s!==null && s>earliestMin){
          html+=`<div class="grid-disabled" style="top:0; height:${(s-earliestMin)*PIXELS_PER_MINUTE}px;"></div>`;
      }
      if(e!==null && e<latestMin){
          html+=`<div class="grid-disabled" style="top:${(e-earliestMin)*PIXELS_PER_MINUTE}px; height:${(latestMin-e)*PIXELS_PER_MINUTE}px;"></div>`;
      }

      dailySkeleton.filter(ev=>ev.division===divName).forEach(ev=>{
          const start=parseTimeToMinutes(ev.startTime);
          const end=parseTimeToMinutes(ev.endTime);
          if(start!=null && end!=null && end>start){
              const top=(start-earliestMin)*PIXELS_PER_MINUTE;
              const height=(end-start)*PIXELS_PER_MINUTE;
              html+=renderEventTile(ev, top, height);
          }
      });
      
      html+=`<div class="drop-preview"></div>`;
      html+=`</div>`;
  });

  html+=`</div>`;
  grid.innerHTML=html;
  grid.dataset.earliestMin = earliestMin;

  addDropListeners('.grid-cell');
  addDragToRepositionListeners(grid);
  addResizeListeners(grid);
  addRemoveListeners('.grid-event');
}

// --- Render Tile ---
function renderEventTile(ev, top, height){
    let tile = TILES.find(t=>t.name===ev.event);
    if(!tile && ev.type) tile = TILES.find(t=>t.type===ev.type);
    const style = tile ? tile.style : 'background:#f8fafc;border-left:4px solid #94a3b8;color:#475569;';
    
    let innerHtml = `
        <div class="tile-header">
            <strong style="font-size:12px;">${ev.event}</strong>
            <div style="font-size:11px;opacity:0.8;">${ev.startTime}-${ev.endTime}</div>
        </div>
    `;
    
    if(ev.location) {
        innerHtml += `
            <div style="font-size:10px;color:inherit;opacity:0.9;margin-top:2px;display:flex;align-items:center;gap:2px;">
                <span>📍</span><span>${ev.location}</span>
            </div>
        `;
    }
    else if (ev.reservedFields && ev.reservedFields.length > 0 && ev.type !== 'elective') {
        innerHtml += `<div style="font-size:10px;opacity:0.9;margin-top:2px;">📍 ${ev.reservedFields.join(', ')}</div>`;
    }
    
    if (ev.type === 'elective' && ev.electiveActivities && ev.electiveActivities.length > 0) {
        const actList = ev.electiveActivities.slice(0, 4).join(', ');
        const more = ev.electiveActivities.length > 4 ? ` +${ev.electiveActivities.length - 4}` : '';
        innerHtml += `<div style="font-size:10px;opacity:0.9;margin-top:2px;">🎯 ${actList}${more}</div>`;
    }
    
    if(ev.type==='smart' && ev.smartData){
        innerHtml += `<div style="font-size:10px;opacity:0.8;margin-top:2px;">↩ ${ev.smartData.fallbackActivity}</div>`;
    }

    return `<div class="grid-event" data-id="${ev.id}" draggable="true" title="${ev.event} (${ev.startTime}-${ev.endTime}) - Double-click to remove" 
            style="${style}; position:absolute; top:${top}px; height:${height}px; width:96%; left:2%; padding:6px 8px; font-size:12px; overflow:hidden; border-radius:6px; cursor:pointer; display:flex; flex-direction:column;">
            <div class="resize-handle resize-handle-top"></div>
            ${innerHtml}
            <div class="resize-handle resize-handle-bottom"></div>
            </div>`;
}

// --- Logic: Add/Remove ---
function addDropListeners(selector){
    grid.querySelectorAll(selector).forEach(cell=>{
        cell.ondragover=e=>{ e.preventDefault(); cell.style.background='#f0fdf4'; };
        cell.ondragleave=e=>{ cell.style.background=''; };
        cell.ondrop=e=>{
            e.preventDefault();
            cell.style.background='';

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
                
                saveDraftToLocalStorage();
                renderGrid();
                return;
            }

            const tileData=JSON.parse(e.dataTransfer.getData('application/json'));
            const divName=cell.dataset.div;
            const earliestMin=parseInt(cell.dataset.startMin);
            
            const rect=cell.getBoundingClientRect();
            const offsetY = e.clientY - rect.top;
            
            let minOffset = Math.round(offsetY / PIXELS_PER_MINUTE / 15) * 15;
            let startMin = earliestMin + minOffset;
            let endMin = startMin + INCREMENT_MINS;
            
            const startStr = minutesToTime(startMin);
            const endStr = minutesToTime(endMin);

            let newEvent = null;
            
            if(tileData.type==='smart'){
                let st=prompt("Start Time:", startStr); if(!st) return;
                let et=prompt("End Time:", endStr); if(!et) return;
                
                let mains = prompt("Enter TWO main activities (e.g. Swim / Art):");
                if(!mains) return;
                let [m1, m2] = mains.split(/[\/,]/).map(s=>s.trim());
                if(!m2) { alert("Need two activities."); return; }
                
                let fbTarget = prompt(`Which one needs fallback if busy?\n1: ${m1}\n2: ${m2}`);
                if(!fbTarget) return;
                let fallbackFor = (fbTarget==='1'||fbTarget.toLowerCase()===m1.toLowerCase()) ? m1 : m2;
                
                let fbAct = prompt(`Fallback activity if ${fallbackFor} is full?`, "Sports");
                
                newEvent = {
                    id: Date.now().toString(),
                    type: 'smart',
                    event: `${m1} / ${m2}`,
                    division: divName,
                    startTime: st,
                    endTime: et,
                    smartData: { main1:m1, main2:m2, fallbackFor, fallbackActivity:fbAct }
                };
            }
            else if(tileData.type==='split'){
                let st=prompt("Start Time:", startStr); 
                if(!st) return;
                
                let et=prompt("End Time:", endStr); 
                if(!et) return;
                
                let a1=prompt("Activity 1 (Main 1):\n\nGroup 1 does this FIRST, Group 2 does this SECOND"); 
                if(!a1) return;
                
                let a2=prompt("Activity 2 (Main 2):\n\nGroup 2 does this FIRST, Group 1 does this SECOND"); 
                if(!a2) return;
                
                newEvent = {
                    id: Date.now().toString(),
                    type: 'split',
                    event: `${a1} / ${a2}`,
                    division: divName,
                    startTime: st,
                    endTime: et,
                    subEvents: [
                        { event: a1 },
                        { event: a2 }
                    ]
                };
                
                console.log(`[SPLIT TILE] Created split tile for ${divName}:`);
                console.log(`  Main 1: "${a1}", Main 2: "${a2}"`);
                console.log(`  Time: ${st} - ${et}`);
            }
            else if (tileData.type === 'elective') {
                let st = prompt("Start Time:", startStr); if (!st) return;
                let et = prompt("End Time:", endStr); if (!et) return;
                
                const activities = promptForElectiveActivities(divName);
                if (!activities || activities.length === 0) return;
                
                const eventName = `Elective: ${activities.slice(0, 3).join(', ')}${activities.length > 3 ? '...' : ''}`;
                
                newEvent = {
                    id: Date.now().toString(),
                    type: 'elective',
                    event: eventName,
                    division: divName,
                    startTime: st,
                    endTime: et,
                    electiveActivities: activities,
                    reservedFields: activities
                };
            }
            else if (['lunch','snacks','custom','dismissal','swim'].includes(tileData.type)) {
                let name = tileData.name;
                let reservedFields = [];
                let location = null;
                
                location = window.getPinnedTileDefaultLocation?.(tileData.type) || null;
                if (location) {
                    reservedFields = [location];
                }
                
                if (tileData.type === 'custom') {
                    name = prompt("Event Name (e.g., 'Special with R. Rosenfeld'):", "Regroup");
                    if (!name) return;
                    
                    const manualFields = promptForReservedFields(name);
                    if (manualFields.length > 0) {
                        reservedFields = manualFields;
                        location = manualFields.length === 1 ? manualFields[0] : null;
                    }
                }
                else if (tileData.type === 'swim') {
                    if (reservedFields.length === 0) {
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
                }
                
                let st = prompt(`${name} Start:`, startStr); if(!st) return;
                let et = prompt(`${name} End:`, endStr); if(!et) return;
                
                newEvent = {
                    id: Date.now().toString(),
                    type: 'pinned',
                    event: name,
                    division: divName,
                    startTime: st,
                    endTime: et,
                    reservedFields: reservedFields,
                    location: location
                };
            }
            else {
                let name = tileData.name;
                let finalType = tileData.type;

                if (tileData.type === 'activity') { name = "General Activity Slot"; finalType = 'slot'; }
                else if (tileData.type === 'sports') { name = "Sports Slot"; finalType = 'slot'; }
                else if (tileData.type === 'special') { name = "Special Activity"; finalType = 'slot'; }
                else if(tileData.type==='league') {
                    name = "League Game";
                    finalType = 'league';
                }
                else if(tileData.type === 'specialty_league') { 
                    name = "Specialty League"; 
                    finalType = 'specialty_league'; 
                }
                
                if(!name) return;

                if (/league/i.test(name) && finalType === 'slot') {
                    finalType = 'league';
                }
                
                let st=prompt(`${name} Start:`, startStr); if(!st) return;
                let et=prompt(`${name} End:`, endStr); if(!et) return;
                
                newEvent = {
                    id: Date.now().toString(),
                    type: finalType,
                    event: name,
                    division: divName,
                    startTime: st,
                    endTime: et
                };
            }

            if (newEvent) {
                const newStartVal = parseTimeToMinutes(newEvent.startTime);
                const newEndVal = parseTimeToMinutes(newEvent.endTime);

                dailySkeleton = dailySkeleton.filter(existing => {
                    if (existing.division !== divName) return true;

                    const exStart = parseTimeToMinutes(existing.startTime);
                    const exEnd = parseTimeToMinutes(existing.endTime);

                    if (exStart === null || exEnd === null) return true;

                    const overlaps = (exStart < newEndVal) && (exEnd > newStartVal);
                    return !overlaps; 
                });

                dailySkeleton.push(newEvent);
                saveDraftToLocalStorage();
                renderGrid();
            }
        };
    });
}

function addRemoveListeners(selector){
    grid.querySelectorAll(selector).forEach(el=>{
        el.ondblclick=e=>{
            e.stopPropagation();
            if (e.target.classList.contains('resize-handle')) return;
            if(confirm("Delete this block?")){
                const id=el.dataset.id;
                dailySkeleton = dailySkeleton.filter(x=>x.id!==id);
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
      cell.style.background = '#f0fdf4';
      
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
function loadDailySkeleton(){
  const assignments=window.getSkeletonAssignments?.()||{};
  const skeletons=window.getSavedSkeletons?.()||{};
  const dateStr=window.currentScheduleDate||"";
  const [Y,M,D]=dateStr.split('-').map(Number);
  let dow=0; if(Y&&M&&D) dow=new Date(Y,M-1,D).getDay();
  const dayNames=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const today=dayNames[dow];
  let tmpl=assignments[today] || assignments["Default"];
  dailySkeleton = (tmpl && skeletons[tmpl]) ? JSON.parse(JSON.stringify(skeletons[tmpl])) : [];
}

function loadSkeletonToBuilder(name){
  const all=window.getSavedSkeletons?.()||{};
  if(all[name]) {
      dailySkeleton=JSON.parse(JSON.stringify(all[name]));
      currentLoadedTemplate = name;
  }
  renderGrid();
  renderTemplateUI();
  saveDraftToLocalStorage();
}

function parseTimeToMinutes(str){
  if(!str) return null;
  let s=str.toLowerCase().replace(/am|pm/g,'').trim();
  let [h,m]=s.split(':').map(Number);
  if(str.toLowerCase().includes('pm') && h!==12) h+=12;
  if(str.toLowerCase().includes('am') && h===12) h=0;
  return h*60+(m||0);
}
function minutesToTime(min){
  let h=Math.floor(min/60), m=min%60, ap=h>=12?'pm':'am';
  h=h%12||12;
  return `${h}:${m.toString().padStart(2,'0')}${ap}`;
}

window.initMasterScheduler = init;

})();
