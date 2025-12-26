// =================================================================
// master_schedule_builder.js (UPDATED - ELECTIVE TILE SUPPORT)
// Beta
// Updates:
// 1. Added Elective tile type for reserving multiple activities
// 2. Added "Update [Template Name]" button to save changes to current file.
// 3. Wired up "Delete Selected Template" button.
// 4. Tracks 'currentLoadedTemplate' to distinguish between new drafts and existing files.
// 5. Auto-assigns default locations to pinned tiles if configured.
// =================================================================

(function(){
'use strict';

let container=null, palette=null, grid=null;
let dailySkeleton=[];
let currentLoadedTemplate = null; // Tracks which template is currently being edited

// --- Constants ---
const SKELETON_DRAFT_KEY = 'master-schedule-draft';
const SKELETON_DRAFT_NAME_KEY = 'master-schedule-draft-name';
const PIXELS_PER_MINUTE=2;
const INCREMENT_MINS=30;

// --- Persistence ---
function saveDraftToLocalStorage() {
  try {
    if (dailySkeleton && dailySkeleton.length > 0) {
      localStorage.setItem(SKELETON_DRAFT_KEY, JSON.stringify(dailySkeleton));
      // Persist the loaded name if available so refresh keeps context
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

// --- Tiles ---
const TILES=[
  {type:'activity', name:'Activity', style:'background:#e0f7fa;border:1px solid #007bff;', description:'Flexible slot (Sport or Special).'},
  {type:'sports', name:'Sports', style:'background:#dcedc8;border:1px solid #689f38;', description:'Sports slot only.'},
  {type:'special', name:'Special Activity', style:'background:#e8f5e9;border:1px solid #43a047;', description:'Special Activity slot only.'},
  {type:'smart', name:'Smart Tile', style:'background:#e3f2fd;border:2px dashed #0288d1;color:#01579b;', description:'Balances 2 activities with a fallback.'},
  {type:'split', name:'Split Activity', style:'background:#fff3e0;border:1px solid #f57c00;', description:'Two activities share the block (Switch halfway).'},
  {type:'elective', name:'Elective', style:'background:#e1bee7;border:2px solid #8e24aa;color:#4a148c;', description:'Reserve multiple activities for this division only.'},
  {type:'league', name:'League Game', style:'background:#d1c4e9;border:1px solid #5e35b1;', description:'Regular League slot (Full Buyout).'},
  {type:'specialty_league', name:'Specialty League', style:'background:#fff8e1;border:1px solid #f9a825;', description:'Specialty League slot (Full Buyout).'},
  {type:'swim', name:'Swim', style:'background:#bbdefb;border:1px solid #1976d2;', description:'Pinned.'},
  {type:'lunch', name:'Lunch', style:'background:#fbe9e7;border:1px solid #d84315;', description:'Pinned.'},
  {type:'snacks', name:'Snacks', style:'background:#fff9c4;border:1px solid #fbc02d;', description:'Pinned.'},
  {type:'dismissal', name:'Dismissal', style:'background:#f44336;color:white;border:1px solid #b71c1c;', description:'Pinned.'},
  {type:'custom', name:'Custom Pinned Event', style:'background:#eee;border:1px solid #616161;', description:'Pinned custom (e.g., Regroup).'}
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
   
  // Combine fields and special activities as potential "locations"
  const allLocations = [...new Set([...allFields, ...specialActivities])].sort();
   
  if (allLocations.length === 0) {
    return []; // No fields configured
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
   
  // Parse and validate field names
  const requested = fieldInput.split(',').map(f => f.trim()).filter(Boolean);
  const validated = [];
  const invalid = [];
   
  requested.forEach(name => {
    // Try to match (case-insensitive)
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
  return SWIM_POOL_PATTERNS.some(p => lower.includes(p) || p.includes(lower));
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
   
  // Parse and validate
  const requested = activitiesInput.split(',').map(s => s.trim()).filter(Boolean);
  const validated = [];
  const invalid = [];
   
  requested.forEach(name => {
    console.log(`[Elective] Processing: "${name}"`);
     
    // Check for swim/pool aliases FIRST
    if (isSwimPoolAlias(name)) {
      console.log(`[Elective] "${name}" is a swim/pool alias`);
      if (poolFieldName) {
        if (!validated.includes(poolFieldName)) {
          validated.push(poolFieldName);
          console.log(`[Elective] Resolved "${name}" → "${poolFieldName}"`);
        }
      } else {
        // No pool field in settings, add the literal name
        if (!validated.includes(name)) {
          validated.push(name);
          console.log(`[Elective] No pool field found, adding "${name}" as-is`);
        }
      }
      return; // Don't check against allLocations for swim/pool
    }
     
    // Standard matching for non-swim activities
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

  // Inject HTML + CSS
  container.innerHTML=`
    <div id="scheduler-template-ui" style="padding:15px;background:#f9f9f9;border:1px solid #ddd;border-radius:8px;margin-bottom:20px;"></div>
    <div id="scheduler-palette" style="padding:10px;background:#f4f4f4;border-radius:8px;margin-bottom:15px;display:flex;flex-wrap:wrap;gap:10px;"></div>
    <div id="scheduler-grid-wrapper" style="overflow-x:auto; border:1px solid #999; background:#fff;">
        <div id="scheduler-grid"></div>
    </div>
    <style>
      .grid-disabled{position:absolute;width:100%;background-color:#80808040;background-image:linear-gradient(-45deg,#0000001a 25%,transparent 25%,transparent 50%,#0000001a 50%,#0000001a 75%,transparent 75%,transparent);background-size:20px 20px;z-index:1;pointer-events:none}
      .grid-event{z-index:2;position:relative;box-shadow:0 1px 3px rgba(0,0,0,0.2);}
      .grid-cell{position:relative; border-right:1px solid #ccc; background:#fff;}
    </style>
  `;
   
  palette=document.getElementById("scheduler-palette");
  grid=document.getElementById("scheduler-grid");
   
  renderTemplateUI();
  renderPalette();
  renderGrid();
}

// --- Render Template Controls ---
function renderTemplateUI(){
  const ui=document.getElementById("scheduler-template-ui");
  if(!ui) return;
  const saved=window.getSavedSkeletons?.()||{};
  const names=Object.keys(saved).sort();
  const assignments=window.getSkeletonAssignments?.()||{};
  let loadOptions=names.map(n=>`<option value="${n}">${n}</option>`).join('');

  // Determine button state for "Update"
  const updateBtnStyle = currentLoadedTemplate ? '' : 'display:none;';
  const currentNameLabel = currentLoadedTemplate ? `Editing: <b>${currentLoadedTemplate}</b>` : 'New Schedule';

  ui.innerHTML=`
    <div style="margin-bottom:10px;color:#555;">${currentNameLabel}</div>
    <div class="template-toolbar" style="display:flex;flex-wrap:wrap;gap:20px;align-items:flex-end;">
      <div class="template-group"><label>Load Template</label><br>
        <select id="template-load-select" style="padding:6px;"><option value="">-- Select --</option>${loadOptions}</select>
      </div>
       
      <!-- UPDATE BUTTON (Only shows if editing existing) -->
      <div class="template-group" style="${updateBtnStyle}">
         <label>&nbsp;</label><br>
         <button id="template-update-btn" style="background:#17a2b8;color:#fff;font-weight:bold;">Update "${currentLoadedTemplate}"</button>
      </div>

      <div class="template-group"><label>Save As New</label><br>
        <input type="text" id="template-save-name" placeholder="New Name...">
        <button id="template-save-btn" style="background:#007bff;color:#fff;">Save As</button>
      </div>
       
      <div class="template-group"><label>&nbsp;</label><br>
        <button id="template-clear-btn" style="background:#ff9800;color:#fff;">New/Clear</button>
      </div>
    </div>

    <details style="margin-top:10px;">
      <summary style="cursor:pointer;color:#007bff;">Assignments & Delete</summary>
      <div style="margin-top:10px;padding:10px;border:1px solid #eee;">
        <div style="display:flex;flex-wrap:wrap;gap:10px;">
          ${["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Default"].map(day=>`<br>
          <div><label>${day}</label><br><select data-day="${day}" style="width:100px;">${loadOptions}</select></div>`).join('')}
        </div>
        <button id="template-assign-save-btn" style="margin-top:10px;background:#28a745;color:white;">Save Assignments</button>
        <hr>
        <div style="display:flex; align-items:center; gap:10px; margin-top:10px;">
            <label style="color:#c0392b;">Delete Template:</label>
            <select id="template-delete-select" style="padding:4px;"><option value="">-- Select to Delete --</option>${loadOptions}</select>
            <button id="template-delete-btn" style="background:#c0392b;color:white;">Delete Permanently</button>
        </div>
      </div>
    </details>
  `;

  // Bindings
  const loadSel=document.getElementById("template-load-select");
  const saveName=document.getElementById("template-save-name");
   
  loadSel.onchange=()=>{
    const name=loadSel.value;
    if(name && saved[name] && confirm(`Load "${name}"?`)){
      loadSkeletonToBuilder(name);
      // Pre-fill save as name just in case, but rely on update button for edits
      saveName.value=name; 
    }
  };

  // 1. UPDATE EXISTING
  const updateBtn = document.getElementById("template-update-btn");
  if(updateBtn) {
      updateBtn.onclick = () => {
          if(currentLoadedTemplate && confirm(`Overwrite existing template "${currentLoadedTemplate}" with current grid?`)){
              window.saveSkeleton?.(currentLoadedTemplate, dailySkeleton);
              clearDraftFromLocalStorage();
              alert("Updated successfully.");
              renderTemplateUI();
          }
      };
  }

  // 2. SAVE AS NEW
  document.getElementById("template-save-btn").onclick=()=>{
    const name=saveName.value.trim();
    if(!name) { alert("Please enter a name."); return; }
   
    if(saved[name] && !confirm(`"${name}" already exists. Overwrite?`)) return;

    window.saveSkeleton?.(name, dailySkeleton);
    currentLoadedTemplate = name; // Switch context to this new save
    clearDraftFromLocalStorage();
    alert("Saved.");
    renderTemplateUI();
  };

  // 3. CLEAR / NEW
  document.getElementById("template-clear-btn").onclick=()=>{
    if(confirm("Clear grid and start new?")) {
        dailySkeleton=[];
        currentLoadedTemplate = null; // Reset context
        clearDraftFromLocalStorage();
        renderGrid();
        renderTemplateUI();
    }
  };

  // 4. ASSIGNMENTS
  ui.querySelectorAll('select[data-day]').forEach(sel=>{
      const day=sel.dataset.day;
      const opt=document.createElement('option');
      opt.value=""; opt.textContent="-- None --";
      sel.prepend(opt);
      sel.value=assignments[day]||"";
  });

  document.getElementById("template-assign-save-btn").onclick=()=>{
      const map={};
      ui.querySelectorAll('select[data-day]').forEach(s=>{ if(s.value) map[s.dataset.day]=s.value; });
      window.saveSkeletonAssignments?.(map);
      alert("Assignments Saved.");
  };

  // 5. DELETE
  document.getElementById("template-delete-btn").onclick=()=>{
      const delSel = document.getElementById("template-delete-select");
      const nameToDelete = delSel.value;
       
      if(!nameToDelete) {
          alert("Please select a template from the dropdown next to the Delete button.");
          return;
      }

      if(confirm(`Are you sure you want to PERMANENTLY DELETE "${nameToDelete}"?`)){
          if(window.deleteSkeleton) {
              window.deleteSkeleton(nameToDelete);
               
              // If we deleted the one we are looking at, reset context
              if(currentLoadedTemplate === nameToDelete){
                  currentLoadedTemplate = null;
                  dailySkeleton = []; // Optional: Clear grid or keep as unsaved? Let's clear to be safe.
                  clearDraftFromLocalStorage();
                  renderGrid();
              }
               
              alert("Deleted.");
              renderTemplateUI();
          } else {
              alert("Error: 'window.deleteSkeleton' function is not defined in your global setup. Please add it to your setup script.");
          }
      }
  };
}

// --- Render Palette ---
function renderPalette(){
  palette.innerHTML='';
  TILES.forEach(tile=>{
    const el=document.createElement('div');
    el.className='grid-tile-draggable';
    el.textContent=tile.name;
    el.style.cssText=tile.style;
    el.style.padding='8px 12px';
    el.style.borderRadius='5px';
    el.style.cursor='grab';
    el.draggable=true;
    el.title = tile.description || '';
    
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
    
    el.ondragstart=(e)=>{ 
      el.dragging = true;
      e.dataTransfer.setData('application/json',JSON.stringify(tile)); 
    };
    el.ondragend = () => { el.dragging = false; };
    
    palette.appendChild(el);
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

// --- RENDER GRID (Fixed) ---
function renderGrid(){
  const divisions=window.divisions||{};
  const availableDivisions=window.availableDivisions||[];

  if (availableDivisions.length === 0) {
      grid.innerHTML = `<div style="padding:20px;text-align:center;color:#666;">No divisions found. Please go to Setup to create divisions.</div>`;
      return;
  }

  // Calculate Times
  let earliestMin=null, latestMin=null;
  Object.values(divisions).forEach(div=>{
    const s=parseTimeToMinutes(div.startTime);
    const e=parseTimeToMinutes(div.endTime);
    if(s!==null && (earliestMin===null || s<earliestMin)) earliestMin=s;
    if(e!==null && (latestMin===null || e>latestMin)) latestMin=e;
  });
  if(earliestMin===null) earliestMin=540;
  if(latestMin===null) latestMin=960;

  // Stretch for pinned events
  const latestPinned=Math.max(-Infinity, ...dailySkeleton.map(e=>parseTimeToMinutes(e.endTime)|| -Infinity));
  if(latestPinned > -Infinity) latestMin = Math.max(latestMin, latestPinned);
  if(latestMin <= earliestMin) latestMin = earliestMin + 60;

  const totalHeight = (latestMin - earliestMin) * PIXELS_PER_MINUTE;

  // Build HTML
  let html=`<div style="display:grid; grid-template-columns:60px repeat(${availableDivisions.length}, 1fr); position:relative; min-width:800px;">`;
   
  // Header Row
  html+=`<div style="grid-row:1; position:sticky; top:0; background:#fff; z-index:10; border-bottom:1px solid #999; padding:8px; font-weight:bold;">Time</div>`;
  availableDivisions.forEach((divName,i)=>{
      const color = divisions[divName]?.color || '#444';
      html+=`<div style="grid-row:1; grid-column:${i+2}; position:sticky; top:0; background:${color}; color:#fff; z-index:10; border-bottom:1px solid #999; padding:8px; text-align:center; font-weight:bold;">${divName}</div>`;
  });

  // Time Column
  html+=`<div style="grid-row:2; grid-column:1; height:${totalHeight}px; position:relative; background:#f9f9f9; border-right:1px solid #ccc;">`;
  for(let m=earliestMin; m<latestMin; m+=INCREMENT_MINS){
      const top=(m-earliestMin)*PIXELS_PER_MINUTE;
      html+=`<div style="position:absolute; top:${top}px; left:0; width:100%; border-top:1px dashed #ddd; font-size:10px; padding:2px; color:#666;">${minutesToTime(m)}</div>`;
  }
  html+=`</div>`;

  // Division Columns
  availableDivisions.forEach((divName,i)=>{
      const div=divisions[divName];
      const s=parseTimeToMinutes(div?.startTime);
      const e=parseTimeToMinutes(div?.endTime);
       
      html+=`<div class="grid-cell" data-div="${divName}" data-start-min="${earliestMin}" style="grid-row:2; grid-column:${i+2}; height:${totalHeight}px;">`;
       
      // Grey out unavailable times
      if(s!==null && s>earliestMin){
          html+=`<div class="grid-disabled" style="top:0; height:${(s-earliestMin)*PIXELS_PER_MINUTE}px;"></div>`;
      }
      if(e!==null && e<latestMin){
          html+=`<div class="grid-disabled" style="top:${(e-earliestMin)*PIXELS_PER_MINUTE}px; height:${(latestMin-e)*PIXELS_PER_MINUTE}px;"></div>`;
      }

      // Render Events
      dailySkeleton.filter(ev=>ev.division===divName).forEach(ev=>{
          const start=parseTimeToMinutes(ev.startTime);
          const end=parseTimeToMinutes(ev.endTime);
          if(start!=null && end!=null && end>start){
              const top=(start-earliestMin)*PIXELS_PER_MINUTE;
              const height=(end-start)*PIXELS_PER_MINUTE;
              html+=renderEventTile(ev, top, height);
          }
      });

      html+=`</div>`;
  });

  html+=`</div>`;
  grid.innerHTML=html;

  // Bind Events
  addDropListeners('.grid-cell');
  addRemoveListeners('.grid-event');
}

// --- Render Tile (UPDATED to show reserved fields and elective activities) ---
function renderEventTile(ev, top, height){
    let tile = TILES.find(t=>t.name===ev.event);
    if(!tile && ev.type) tile = TILES.find(t=>t.type===ev.type);
    const style = tile ? tile.style : 'background:#eee;border:1px solid #666;';
    
    // Main Content
    let innerHtml = `
        <div class="tile-header">
            <strong>${ev.event}</strong>
            <div style="font-size:0.8em">${ev.startTime}-${ev.endTime}</div>
        </div>
    `;
    
    // 1. LOCATION INDICATOR (New Feature)
    if(ev.location) {
        innerHtml += `
            <div class="tile-location-badge" style="
                font-size: 0.75rem; 
                color: #c62828; 
                margin-top: 2px; 
                display: flex; 
                align-items: center; 
                gap: 2px;
                font-weight: 500;
            ">
                <span>📍</span>
                <span>${ev.location}</span>
            </div>
        `;
    }
    // 2. Fallback: Reserved Fields (if location is missing but reservedFields exist)
    else if (ev.reservedFields && ev.reservedFields.length > 0 && ev.type !== 'elective') {
        innerHtml += `<div style="font-size:0.7em;color:#c62828;margin-top:2px;">📍 ${ev.reservedFields.join(', ')}</div>`;
    }
    
    // Show elective activities
    if (ev.type === 'elective' && ev.electiveActivities && ev.electiveActivities.length > 0) {
        const actList = ev.electiveActivities.slice(0, 4).join(', ');
        const more = ev.electiveActivities.length > 4 ? ` +${ev.electiveActivities.length - 4}` : '';
        innerHtml += `<div style="font-size:0.7em;color:#6a1b9a;margin-top:2px;">🎯 ${actList}${more}</div>`;
    }
    
    // Smart tile fallback info
    if(ev.type==='smart' && ev.smartData){
        innerHtml += `<div style="font-size:0.75em;margin-top:2px;">F: ${ev.smartData.fallbackActivity} (if ${ev.smartData.fallbackFor.substring(0,4)} busy)</div>`;
    }

    // Return the complete tile HTML
    return `<div class="grid-event" data-id="${ev.id}" title="Click to remove" 
            style="${style}; position:absolute; top:${top}px; height:${height}px; width:96%; left:2%; padding:2px; font-size:0.85rem; overflow:hidden; border-radius:4px; cursor:pointer; display:flex; flex-direction:column;">
            ${innerHtml}
            </div>`;
}

// --- Logic: Add/Remove ---
function addDropListeners(selector){
    grid.querySelectorAll(selector).forEach(cell=>{
        cell.ondragover=e=>{ e.preventDefault(); cell.style.background='#e6fffa'; };
        cell.ondragleave=e=>{ cell.style.background=''; };
        cell.ondrop=e=>{
            e.preventDefault();
            cell.style.background='';
            const tileData=JSON.parse(e.dataTransfer.getData('application/json'));
            const divName=cell.dataset.div;
            const earliestMin=parseInt(cell.dataset.startMin);
            
            // Calc time
            const rect=cell.getBoundingClientRect();
            const offsetY = e.clientY - rect.top;
            
            // Snap to 15 mins
            let minOffset = Math.round(offsetY / PIXELS_PER_MINUTE / 15) * 15;
            let startMin = earliestMin + minOffset;
            let endMin = startMin + INCREMENT_MINS; // Default 30 min
            
            const startStr = minutesToTime(startMin);
            const endStr = minutesToTime(endMin);

            // PROMPTS
            let newEvent = null;
            
            // 1. Smart Tile
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
            // 2. Split Tile
            else if(tileData.type==='split'){
                let st=prompt("Start Time:", startStr); if(!st) return;
                let et=prompt("End Time:", endStr); if(!et) return;
                let a1=prompt("Activity 1 (First Half):"); if(!a1) return;
                let a2=prompt("Activity 2 (Second Half):"); if(!a2) return;
                
                newEvent = {
                    id: Date.now().toString(),
                    type: 'split',
                    event: `${a1} / ${a2}`,
                    division: divName,
                    startTime: st,
                    endTime: et,
                    subEvents: [{event:a1}, {event:a2}]
                };
            }
            // 3. ELECTIVE TILE - Reserve multiple activities for this division
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
                    reservedFields: activities // Also mark as reserved for field conflict detection
                };
            }
            // 4. PINNED TILES WITH FIELD RESERVATION
            else if (['lunch','snacks','custom','dismissal','swim'].includes(tileData.type)) {
                let name = tileData.name;
                let reservedFields = [];
                let location = null;
                
                // NEW: Auto-assign location from defaults if available
                location = window.getPinnedTileDefaultLocation?.(tileData.type) || null;
                if (location) {
                    reservedFields = [location]; // Sync to reservedFields so it appears in UI
                }
                
                if (tileData.type === 'custom') {
                    name = prompt("Event Name (e.g., 'Special with R. Rosenfeld'):", "Regroup");
                    if (!name) return;
                    
                    // Ask for reserved fields (Manual override)
                    const manualFields = promptForReservedFields(name);
                    if (manualFields.length > 0) {
                        reservedFields = manualFields;
                        location = manualFields[0]; // Sync location
                    }
                }
                else if (tileData.type === 'swim') {
                    // Only auto-discover if no default location was configured
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
                    location: location // Store location as requested
                };
            }
            // 5. Standard & League Types
            else {
                let name = tileData.name;
                let finalType = tileData.type;

                // Standardize for Optimizer
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

                // Safety Auto-fix for League
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
                // 1. Calculate the New Event's Minute Range
                const newStartVal = parseTimeToMinutes(newEvent.startTime);
                const newEndVal = parseTimeToMinutes(newEvent.endTime);

                // 2. FILTER: Remove any existing event in this division that overlaps
                dailySkeleton = dailySkeleton.filter(existing => {
                    // Keep events in other columns
                    if (existing.division !== divName) return true;

                    const exStart = parseTimeToMinutes(existing.startTime);
                    const exEnd = parseTimeToMinutes(existing.endTime);

                    // Skip invalid data
                    if (exStart === null || exEnd === null) return true;

                    // OVERLAP CHECK:
                    // An overlap occurs if (ExistingStart < NewEnd) AND (ExistingEnd > NewStart)
                    const overlaps = (exStart < newEndVal) && (exEnd > newStartVal);

                    // If it overlaps, return FALSE to remove it (erase the bottom tile)
                    return !overlaps; 
                });

                // 3. Add the New Event
                dailySkeleton.push(newEvent);
                saveDraftToLocalStorage();
                renderGrid();
            }
        };
    });
}

function addRemoveListeners(selector){
    grid.querySelectorAll(selector).forEach(el=>{
        el.onclick=e=>{
            e.stopPropagation();
            if(confirm("Delete this block?")){
                const id=el.dataset.id;
                dailySkeleton = dailySkeleton.filter(x=>x.id!==id);
                saveDraftToLocalStorage();
                renderGrid();
            }
        };
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
      currentLoadedTemplate = name; // Track that we are editing this template
  }
  renderGrid();
  renderTemplateUI(); // Re-render UI to show Update button
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
