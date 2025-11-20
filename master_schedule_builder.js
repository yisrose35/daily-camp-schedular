// =================================================================
// master_schedule_builder.js (MODERNIZED UI)
// =================================================================
(function(){
'use strict';

let container=null, palette=null, grid=null;
let dailySkeleton=[];

const SKELETON_DRAFT_KEY = 'master-schedule-draft';
const SKELETON_DRAFT_NAME_KEY = 'master-schedule-draft-name';

function saveDraftToLocalStorage() {
    try {
        if (dailySkeleton && dailySkeleton.length > 0) {
            localStorage.setItem(SKELETON_DRAFT_KEY, JSON.stringify(dailySkeleton));
        } else {
            localStorage.removeItem(SKELETON_DRAFT_KEY);
        }
    } catch (e) { console.error("Error saving draft:", e); }
}

function clearDraftFromLocalStorage() {
    localStorage.removeItem(SKELETON_DRAFT_KEY);
    localStorage.removeItem(SKELETON_DRAFT_NAME_KEY);
    console.log("Master template draft cleared.");
}

const PIXELS_PER_MINUTE=2;
const INCREMENT_MINS=30;

// TILES: Removed inline styles, relying on CSS classes
const TILES=[
  {type:'activity', name:'Activity', className:'tile-activity', description:'Flexible slot (Sport or Special).'},
  {type:'sports', name:'Sports', className:'tile-sports', description:'Sports slot only.'},
  {type:'special', name:'Special Activity', className:'tile-special', description:'Special Activity slot only.'},
  {type:'split', name:'Split Activity', className:'tile-split', description:'Two activities share the block.'},
  {type:'league', name:'League Game', className:'tile-league', description:'Regular League slot.'},
  {type:'specialty_league', name:'Specialty League', className:'tile-specialty', description:'Specialty League slot.'},
  {type:'swim', name:'Swim', className:'tile-swim', description:'Pinned.'},
  {type:'lunch', name:'Lunch', className:'tile-lunch', description:'Pinned.'},
  {type:'snacks', name:'Snacks', className:'tile-snack', description:'Pinned.'},
  {type:'dismissal', name:'Dismissal', className:'tile-dismissal', description:'Pinned.'},
  {type:'custom', name:'Custom Pinned Event', className:'tile-custom', description:'Pinned custom (e.g., Regroup).'}
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

function init(){
  container=document.getElementById("master-scheduler-content");
  if(!container) return;
  loadDailySkeleton();

  const savedDraft = localStorage.getItem(SKELETON_DRAFT_KEY);
  if (savedDraft) {
      if (confirm("You have an unsaved master schedule draft. Load it?")) {
          dailySkeleton = JSON.parse(savedDraft);
      } else {
          clearDraftFromLocalStorage();
      }
  }

  // Updated Structure with Classes
  container.innerHTML=`
    <div id="scheduler-template-ui" class="card mb-4"></div>
    <div class="card mb-3">
        <div id="scheduler-palette" class="flex-row flex-wrap"></div>
    </div>
    <div id="scheduler-grid" class="schedule-view-wrapper"></div>
  `;
  palette=document.getElementById("scheduler-palette");
  grid=document.getElementById("scheduler-grid");
  renderTemplateUI();
  renderPalette();
  renderGrid();
}

function renderTemplateUI(){
  const ui=document.getElementById("scheduler-template-ui");
  if(!ui) return;
  const saved=window.getSavedSkeletons?.()||{};
  const names=Object.keys(saved).sort();
  const assignments=window.getSkeletonAssignments?.()||{};
  let loadOptions=names.map(n=>`<option value="${n}">${n}</option>`).join('');
  
  // Using 'flex-row', 'btn', 'btn-primary' classes
  ui.innerHTML=`
    <div class="flex-row flex-wrap gap-4 align-end">
      <div class="form-group" id="load-template-group">
        <label>Load Template</label>
        <select id="template-load-select">${loadOptions}<option value="">-- Select template --</option></select>
      </div>
      <div class="form-group">
        <label>Save Current Grid as</label>
        <input type="text" id="template-save-name" placeholder="e.g., Friday Short Day">
      </div>
      <div class="flex-row">
          <button id="template-save-btn" class="primary">Save</button>
          <button id="template-clear-btn" class="btn" style="background:var(--warning); color:white;">New Grid</button>
      </div>
    </div>
    
    <details id="template-manage-details" style="margin-top:1.5rem;">
      <summary style="cursor:pointer; color:var(--primary); font-weight:600;">Manage Assignments & Delete...</summary>
      <div class="card mt-3" style="background:var(--bg-subtle);">
        <h4>Day of Week Assignments</h4>
        <div class="flex-row flex-wrap gap-3">
          ${["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Default"].map(day=>`
            <div style="display:flex; flex-direction:column; min-width:140px;">
              <label style="font-size:0.85rem; color:var(--text-muted);">${day}:</label>
              <select data-day="${day}">${loadOptions}</select>
            </div>`).join('')}
        </div>
        <div class="flex-row gap-3 mt-3 pt-3" style="border-top:1px dashed var(--border);">
            <button id="template-assign-save-btn" class="primary">Save Assignments</button>
            <button id="template-delete-btn" class="danger">Delete Selected Template</button>
        </div>
      </div>
    </details>
  `;

  const loadSel=document.getElementById("template-load-select");
  const saveName=document.getElementById("template-save-name");

  const savedDraftName = localStorage.getItem(SKELETON_DRAFT_NAME_KEY);
  if (savedDraftName) saveName.value = savedDraftName;
  
  saveName.oninput = () => { localStorage.setItem(SKELETON_DRAFT_NAME_KEY, saveName.value.trim()); };

  loadSel.onchange=()=>{ 
    const name=loadSel.value; 
    if(name && saved[name]){ 
      if(confirm(`Load "${name}"?`)){ 
        loadSkeletonToBuilder(name); 
        saveName.value=name; 
        saveDraftToLocalStorage();
        localStorage.setItem(SKELETON_DRAFT_NAME_KEY, name);
      } else loadSel.value=""; 
    } 
  };
  
  document.getElementById("template-save-btn").onclick=()=>{ 
    const name=saveName.value.trim(); 
    if(!name){ alert("Enter a name"); return; } 
    if(confirm(`Save as "${name}"?`)){ 
      window.saveSkeleton?.(name,dailySkeleton); 
      clearDraftFromLocalStorage();
      alert("Template saved!"); 
      renderTemplateUI(); 
    } 
  };

  document.getElementById("template-clear-btn").onclick=()=>{
    if(dailySkeleton.length > 0) {
        if(!confirm("Make sure to save your work!\n\nClick OK to continue to generating a new grid.")) return;
    }
    dailySkeleton = [];
    saveName.value = ""; 
    loadSel.value = ""; 
    localStorage.removeItem(SKELETON_DRAFT_NAME_KEY); 
    saveDraftToLocalStorage(); 
    renderGrid();
  };

  document.getElementById("template-delete-btn").onclick=()=>{ 
    const name=loadSel.value; 
    if(!name){ alert("Select a template to delete."); return; } 
    if(confirm(`Delete "${name}"?`)){ 
      window.deleteSkeleton?.(name); 
      clearDraftFromLocalStorage();
      alert("Deleted!"); 
      renderTemplateUI(); 
      loadSkeletonToBuilder(null); 
    } 
  };

  const selects=ui.querySelectorAll('.card select');
  const namesWithNone = (sel,day)=>{
    const noneOpt=document.createElement('option');
    noneOpt.value=""; noneOpt.textContent=(day==="Default")?"-- Use No Default --":"-- Use Default --";
    sel.prepend(noneOpt);
  };
  selects.forEach(sel=>{
    const day=sel.dataset.day;
    if(day) {
        namesWithNone(sel,day);
        sel.value=assignments[day]||"";
    }
  });
  document.getElementById("template-assign-save-btn").onclick=()=>{
    const newAssign={};
    selects.forEach(sel=>{ const day=sel.dataset.day; const name=sel.value; if(day && name) newAssign[day]=name; });
    window.saveSkeletonAssignments?.(newAssign);
    alert("Assignments saved!");
  };
}

function renderPalette(){
  palette.innerHTML='<span style="font-weight:600; align-self:center; margin-right:10px;">Drag tiles:</span>';
  TILES.forEach(tile=>{
    const el=document.createElement('div');
    el.className='grid-tile-draggable ' + (tile.className || ''); // Add specific class
    el.textContent=tile.name;
    el.draggable=true;
    el.onclick=()=>alert(tile.description);
    el.ondragstart=(e)=>{ e.dataTransfer.setData('application/json',JSON.stringify(tile)); e.dataTransfer.effectAllowed='copy'; el.style.opacity='0.5'; };
    el.ondragend=()=>{ el.style.opacity='1'; };
    palette.appendChild(el);
  });
}

function renderGrid(){
  const divisions=window.divisions||{};
  const availableDivisions=window.availableDivisions||[];

  let earliestMin=null, latestMin=null;
  Object.values(divisions).forEach(div=>{
    const s=parseTimeToMinutes(div.startTime);
    const e=parseTimeToMinutes(div.endTime);
    if(s!==null && (earliestMin===null || s<earliestMin)) earliestMin=s;
    if(e!==null && (latestMin===null || e>latestMin)) latestMin=e;
  });
  if(earliestMin===null) earliestMin=540;
  if(latestMin===null) latestMin=960;

  const latestPinnedEnd=Math.max(-Infinity, ...dailySkeleton.filter(ev=>ev && ev.type==='pinned').map(ev=>parseTimeToMinutes(ev.endTime)??-Infinity));
  if(Number.isFinite(latestPinnedEnd)) latestMin=Math.max(latestMin, latestPinnedEnd);
  if(latestMin<=earliestMin) latestMin=earliestMin+60;

  const totalHeight=(latestMin-earliestMin)*PIXELS_PER_MINUTE;

  let html=`<div style="display:grid; grid-template-columns:60px repeat(${availableDivisions.length},1fr); position:relative;">`;
  
  // Header Row
  html+=`<div class="grid-header-time">Time</div>`;
  availableDivisions.forEach((divName,i)=>{
    const color = divisions[divName]?.color || '#64748b';
    // Inline style needed here for dynamic user-defined color
    html+=`<div class="grid-header-div" style="grid-column:${i+2}; background-color:${color};">${divName}</div>`;
  });

  // Time Column Background
  html+=`<div class="grid-time-col" style="grid-row:2; grid-column:1; height:${totalHeight}px;">`;
  for(let m=earliestMin;m<latestMin;m+=INCREMENT_MINS){
    const top=(m-earliestMin)*PIXELS_PER_MINUTE;
    html+=`<div class="grid-time-marker" style="top:${top}px; height:${INCREMENT_MINS*PIXELS_PER_MINUTE}px;">${minutesToTime(m)}</div>`;
  }
  html+=`</div>`;

  // Division Columns
  availableDivisions.forEach((divName,i)=>{
    const div=divisions[divName];
    const s=parseTimeToMinutes(div?.startTime);
    const e=parseTimeToMinutes(div?.endTime);
    
    html+=`<div class="grid-cell-col" data-div="${divName}" data-start-min="${earliestMin}" style="grid-row:2; grid-column:${i+2}; height:${totalHeight}px;">`;
    
    // Grey out unavailable times
    if(s!==null && s>earliestMin){
      const gh=(s-earliestMin)*PIXELS_PER_MINUTE;
      html+=`<div class="grid-disabled-zone" style="top:0; height:${gh}px;"></div>`;
    }
    if(e!==null && e<latestMin){
      const gt=(e-earliestMin)*PIXELS_PER_MINUTE;
      const gh=(latestMin-e)*PIXELS_PER_MINUTE;
      html+=`<div class="grid-disabled-zone" style="top:${gt}px; height:${gh}px;"></div>`;
    }

    // Events
    dailySkeleton.filter(ev=>ev.division===divName).forEach(event=>{
      const startMin=parseTimeToMinutes(event.startTime);
      const endMin=parseTimeToMinutes(event.endTime);
      if(startMin==null||endMin==null) return;
      const vs=Math.max(startMin,earliestMin);
      const ve=Math.min(endMin,latestMin);
      if(ve<=vs) return;
      const top=(vs-earliestMin)*PIXELS_PER_MINUTE;
      const height=(ve-vs)*PIXELS_PER_MINUTE;
      html+=renderEventTile(event,top,height);
    });
    html+=`</div>`;
  });

  html+=`</div>`;
  grid.innerHTML=html;
  addDropListeners('.grid-cell-col');
  addRemoveListeners('.grid-event');
}

function addDropListeners(selector){
  grid.querySelectorAll(selector).forEach(cell=>{
    cell.ondragover=(e)=>{ e.preventDefault(); e.dataTransfer.dropEffect='copy'; cell.classList.add('drag-over'); };
    cell.ondragleave=()=>{ cell.classList.remove('drag-over'); };
    cell.ondrop=(e)=>{
      e.preventDefault();
      cell.classList.remove('drag-over');
      const tileData=JSON.parse(e.dataTransfer.getData('application/json'));
      const divName=cell.dataset.div;
      // ... (Logic remains identical) ...
      const div=window.divisions[divName]||{};
      const divStart=parseTimeToMinutes(div.startTime);
      const divEnd=parseTimeToMinutes(div.endTime);
      const rect=cell.getBoundingClientRect();
      const scrollTop=grid.scrollTop;
      const y=e.clientY-rect.top+scrollTop;
      const droppedMin=Math.round(y/PIXELS_PER_MINUTE/15)*15;
      const earliestMin=parseInt(cell.dataset.startMin,10);
      const defaultStart=minutesToTime(earliestMin+droppedMin);

      let eventType='slot';
      let eventName=tileData.name;
      let newEvent=null;

      if(tileData.type==='activity') eventName='General Activity Slot';
      else if(tileData.type==='sports') eventName='Sports Slot';
      else if(tileData.type==='special') eventName='Special Activity';
      else if(['league','specialty_league','swim'].includes(tileData.type)) eventName=tileData.name;

      const validate=(timeStr,isStart)=>{
        const m=parseTimeToMinutes(timeStr);
        if(m===null){ alert("Invalid time."); return null; }
        if(divStart!==null && m<divStart){ alert(`Error: Time is before start.`); return null; }
        if(divEnd!==null && (isStart? m>=divEnd : m>divEnd)){ alert(`Error: Time is after end.`); return null; }
        return m;
      };

      if(tileData.type==='split'){
        let st,et,sm,em;
        while(true){ st=prompt(`Start Time:`,defaultStart); if(!st) return; sm=validate(st,true); if(sm!==null) break; }
        while(true){ et=prompt(`End Time:`); if(!et) return; em=validate(et,false); if(em!==null){ if(em<=sm) alert("End < Start"); else break; } }
        const n1=prompt("First Activity:"); if(!n1) return;
        const n2=prompt("Second Activity:"); if(!n2) return;
        const e1=mapEventNameForOptimizer(n1), e2=mapEventNameForOptimizer(n2);
        newEvent={id:`evt_${Math.random().toString(36).slice(2,9)}`, type:'split', event:`${n1} / ${n2}`, division:divName, startTime:st, endTime:et, subEvents:[e1,e2]};
      } else if(['lunch','snacks','custom','dismissal','swim'].includes(tileData.type)){
        eventType='pinned';
        if(tileData.type==='custom'){
          eventName=prompt("Event Name:");
          if(!eventName) return;
        } else { eventName=tileData.name; }
      }

      if(!newEvent){
        let st,et,sm,em;
        while(true){ st=prompt(`Start Time for ${eventName}:`,defaultStart); if(!st) return; sm=validate(st,true); if(sm!==null) break; }
        while(true){ et=prompt(`End Time:`); if(!et) return; em=validate(et,false); if(em!==null){ if(em<=sm) alert("End < Start"); else break; } }
        newEvent={ id:`evt_${Math.random().toString(36).slice(2,9)}`, type:eventType, event:eventName, division:divName, startTime:st, endTime:et };
      }

      dailySkeleton.push(newEvent);
      saveDraftToLocalStorage();
      renderGrid();
    };
  });
}

function addRemoveListeners(selector){
  grid.querySelectorAll(selector).forEach(tile=>{
    tile.onclick=(e)=>{
      e.stopPropagation();
      const id=tile.dataset.eventId;
      if(!id) return;
      if(confirm(`Remove event?`)){
        dailySkeleton=dailySkeleton.filter(v=>v.id!==id);
        saveDraftToLocalStorage();
        renderGrid();
      }
    };
  });
}

function renderEventTile(event, top, height){
  let tileClass = 'tile-default';
  // Map event names to CSS classes
  const lower = (event.event||'').toLowerCase();
  if(lower.includes('dismissal')) tileClass = 'tile-dismissal';
  else if(lower.includes('lunch')) tileClass = 'tile-lunch';
  else if(lower.includes('swim')) tileClass = 'tile-swim';
  else if(lower.includes('snack')) tileClass = 'tile-snack';
  else if(lower.includes('sports')) tileClass = 'tile-sports';
  else if(lower.includes('special')) tileClass = 'tile-special';
  else if(lower.includes('activity')) tileClass = 'tile-activity';
  else if(lower.includes('league')) tileClass = 'tile-league';

  // Inline style needed for absolute positioning in the time grid
  return `
    <div class="grid-event ${tileClass}" data-event-id="${event.id}" 
         style="top:${top}px; height:${height}px; width: calc(100% - 4px); left: 2px;">
      <strong>${event.event}</strong>
      <div class="small-time">${event.startTime} - ${event.endTime}</div>
    </div>`;
}

function loadDailySkeleton(){
  const assignments=window.getSkeletonAssignments?.()||{};
  const skeletons=window.getSavedSkeletons?.()||{};
  const dateStr=window.currentScheduleDate||"";
  const [Y,M,D]=dateStr.split('-').map(Number);
  let dow=0; if(Y&&M&&D) dow=new Date(Y,M-1,D).getDay();
  const dayNames=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const today=dayNames[dow];
  let tmpl=assignments[today];
  if(!tmpl || !skeletons[tmpl]) tmpl=assignments["Default"];
  const s=skeletons[tmpl];
  dailySkeleton=s? JSON.parse(JSON.stringify(s)): [];
}
function loadSkeletonToBuilder(name){
  if(!name) dailySkeleton=[];
  else {
    const all=window.getSavedSkeletons?.()||{};
    dailySkeleton=all[name] ? JSON.parse(JSON.stringify(all[name])) : [];
  }
  renderGrid();
  saveDraftToLocalStorage();
}
function parseTimeToMinutes(str){ /* Same as before */ if(!str)return null; let s=str.trim().toLowerCase(),mer=null; if(s.endsWith('am')||s.endsWith('pm')){mer=s.endsWith('am')?'am':'pm';s=s.replace(/am|pm/g,'').trim();} const m=s.match(/^(\d{1,2})\s*:\s*(\d{2})$/); if(!m)return null; let hh=parseInt(m[1],10),mm=parseInt(m[2],10); if(mer){if(hh===12)hh=mer==='am'?0:12;else if(mer==='pm')hh+=12;} return hh*60+mm; }
function minutesToTime(min){ const hh=Math.floor(min/60),mm=min%60,h=hh%12||12,ap=hh<12?'am':'pm'; return `${h}:${String(mm).padStart(2,'0')}${ap}`; }

window.initMasterScheduler=init;
})();
