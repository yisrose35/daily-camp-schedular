// =================================================================
// master_schedule_builder.js  (UPDATED)
// - Updated "New Grid" prompt to be clearer about saving.
// - Retains auto-save draft logic.
// =================================================================
(function(){
'use strict';

let container=null, palette=null, grid=null;
let dailySkeleton=[];

// --- Constants for the auto-save draft ---
const SKELETON_DRAFT_KEY = 'master-schedule-draft';
const SKELETON_DRAFT_NAME_KEY = 'master-schedule-draft-name';

// --- Function to save the current draft ---
function saveDraftToLocalStorage() {
    try {
        if (dailySkeleton && dailySkeleton.length > 0) {
            localStorage.setItem(SKELETON_DRAFT_KEY, JSON.stringify(dailySkeleton));
        } else {
            localStorage.removeItem(SKELETON_DRAFT_KEY);
        }
    } catch (e) {
        console.error("Error saving draft to localStorage:", e);
    }
}

// --- Function to clear the draft ---
function clearDraftFromLocalStorage() {
    localStorage.removeItem(SKELETON_DRAFT_KEY);
    localStorage.removeItem(SKELETON_DRAFT_NAME_KEY);
    console.log("Master template draft cleared.");
}

const PIXELS_PER_MINUTE=2;
const INCREMENT_MINS=30;

const TILES=[
  {type:'activity', name:'Activity', style:'background:#e0f7fa;border:1px solid #007bff;', description:'Flexible slot (Sport or Special).'},
  {type:'sports', name:'Sports', style:'background:#dcedc8;border:1px solid #689f38;', description:'Sports slot only.'},
  {type:'special', name:'Special Activity', style:'background:#e8f5e9;border:1px solid #43a047;', description:'Special Activity slot only.'},
  {type:'split', name:'Split Activity', style:'background:#fff3e0;border:1px solid #f57c00;', description:'Two activities share the block.'},
  {type:'league', name:'League Game', style:'background:#d1c4e9;border:1px solid #5e35b1;', description:'Regular League slot.'},
  {type:'specialty_league', name:'Specialty League', style:'background:#fff8e1;border:1px solid #f9a825;', description:'Specialty League slot.'},
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

function init(){
  container=document.getElementById("master-scheduler-content");
  if(!container) return;
  loadDailySkeleton();

  // --- Load draft from localStorage ---
  const savedDraft = localStorage.getItem(SKELETON_DRAFT_KEY);
  if (savedDraft) {
      if (confirm("You have an unsaved master schedule draft. Load it?")) {
          dailySkeleton = JSON.parse(savedDraft);
      } else {
          clearDraftFromLocalStorage();
      }
  }

  container.innerHTML=`
    <div id="scheduler-template-ui" style="padding:15px;background:#f9f9f9;border:1px solid #ddd;border-radius:8px;margin-bottom:20px;"></div>
    <div id="scheduler-palette" style="padding:10px;background:#f4f4f4;border-radius:8px;margin-bottom:15px;display:flex;flex-wrap:wrap;gap:10px;"></div>
    <div id="scheduler-grid" style="overflow-x:auto;border:1px solid #999;"></div>
    <style>.grid-disabled{position:absolute;width:100%;background-color:#80808040;background-image:linear-gradient(-45deg,#0000001a 25%,transparent 25%,transparent 50%,#0000001a 50%,#0000001a 75%,transparent 75%,transparent);background-size:20px 20px;z-index:1;pointer-events:none}.grid-event{z-index:2;position:relative}</style>
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
  
  ui.innerHTML=`
    <div class="template-toolbar" style="display:flex;flex-wrap:wrap;gap:20px;align-items:flex-end;">
      <div class="template-group" id="load-template-group"><label>Load Template</label>
        <select id="template-load-select"><option value="">-- Select template --</option>${loadOptions}</select>
      </div>
      <div class="template-group"><label>Save Current Grid as</label><input type="text" id="template-save-name" placeholder="e.g., Friday Short Day"></div>
      <div class="template-group">
          <label>&nbsp;</label>
          <button id="template-save-btn" style="padding:8px 12px;background:#007bff;color:#fff;border:none;border-radius:5px;">Save</button>
          <button id="template-clear-btn" style="padding:8px 12px;background:#ff9800;color:#fff;border:none;border-radius:5px;margin-left:8px;">New Grid</button>
      </div>
    </div>
    <details id="template-manage-details" style="margin-top:15px;">
      <summary style="cursor:pointer;color:#007bff;font-weight:600;padding:5px;border-radius:5px;background:#f0f6ff;display:inline-block;">Manage Assignments & Delete...</summary>
      <div class="assignments-container" style="margin-top:10px;padding:15px;border:1px solid #eee;background:#fff;border-radius:5px;">
        <h4>Day of Week Assignments</h4>
        <div class="assignments-grid" style="display:flex;flex-wrap:wrap;gap:15px;">
          ${["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Default"].map(day=>`
            <div class="day-assignment" style="display:flex;flex-direction:column;min-width:150px;">
              <label>${day}:</label>
              <select data-day="${day}">${loadOptions}</select>
            </div>`).join('')}
        </div>
        <button id="template-assign-save-btn" style="margin-top:15px;padding:8px 12px;background:#28a745;color:#fff;border:none;border-radius:5px;">Save Assignments</button>
        <div class="delete-section" style="margin-top:15px;padding-top:15px;border-top:1px dashed #ccc;">
          <h4>Delete Template</h4>
          <button id="template-delete-btn" style="padding:8px 12px;background:#c0392b;color:#fff;border:none;border-radius:5px;">Delete Selected Template</button>
        </div>
      </div>
    </details>
  `;

  const loadSel=document.getElementById("template-load-select");
  const saveName=document.getElementById("template-save-name");

  // --- Load draft name and save name on input ---
  const savedDraftName = localStorage.getItem(SKELETON_DRAFT_NAME_KEY);
  if (savedDraftName) {
      saveName.value = savedDraftName;
  }
  saveName.oninput = () => {
      localStorage.setItem(SKELETON_DRAFT_NAME_KEY, saveName.value.trim());
  };

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

  // --- UPDATED: "New Grid" Prompt ---
  document.getElementById("template-clear-btn").onclick=()=>{
    if(dailySkeleton.length > 0) {
        // Use the custom prompt requested
        if(!confirm("Make sure to save your work!\n\nClick OK to continue to generating a new grid.\nPush Cancel to go back and save first.")) {
            return; // User cancelled to save
        }
    }
    
    // Proceed to clear
    dailySkeleton = [];
    saveName.value = ""; 
    loadSel.value = ""; 
    localStorage.removeItem(SKELETON_DRAFT_NAME_KEY); 
    saveDraftToLocalStorage(); 
    renderGrid();

    // --- Visual Effect: Flash the Load Template area ---
    const loadGroup = document.getElementById('load-template-group');
    if(loadGroup) {
        loadGroup.style.transition = "all 0.5s ease";
        loadGroup.style.boxShadow = "0 0 15px #ff9800"; // Orange glow
        loadGroup.style.border = "1px solid #ff9800";
        loadGroup.style.borderRadius = "5px";
        loadGroup.style.padding = "5px"; 
        
        setTimeout(() => {
            loadGroup.style.boxShadow = "";
            loadGroup.style.border = "";
            loadGroup.style.padding = "";
        }, 1500);
    }
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

  const selects=ui.querySelectorAll('.assignments-container select');
  const namesWithNone = (sel,day)=>{
    const noneOpt=document.createElement('option');
    noneOpt.value=""; noneOpt.textContent=(day==="Default")?"-- Use No Default --":"-- Use Default --";
    sel.prepend(noneOpt);
  };
  selects.forEach(sel=>{
    const day=sel.dataset.day;
    namesWithNone(sel,day);
    sel.value=assignments[day]||"";
  });
  document.getElementById("template-assign-save-btn").onclick=()=>{
    const newAssign={};
    selects.forEach(sel=>{ const day=sel.dataset.day; const name=sel.value; if(name) newAssign[day]=name; });
    window.saveSkeletonAssignments?.(newAssign);
    alert("Assignments saved!");
  };
}

function renderPalette(){
  palette.innerHTML='<span style="font-weight:600;align-self:center;">Drag tiles onto the grid:</span>';
  TILES.forEach(tile=>{
    const el=document.createElement('div');
    el.className='grid-tile-draggable';
    el.textContent=tile.name;
    el.style.cssText=tile.style;
    el.style.padding='8px 12px';
    el.style.borderRadius='5px';
    el.style.cursor='grab';
    el.onclick=()=>alert(tile.description);
    el.draggable=true;
    el.ondragstart=(e)=>{ e.dataTransfer.setData('application/json',JSON.stringify(tile)); e.dataTransfer.effectAllowed='copy'; el.style.cursor='grabbing'; };
    el.ondragend=()=>{ el.style.cursor='grab'; };
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

  const latestPinnedEnd=Math.max(
    -Infinity,
    ...dailySkeleton.filter(ev=>ev && ev.type==='pinned').map(ev=>parseTimeToMinutes(ev.endTime)??-Infinity)
  );
  if(Number.isFinite(latestPinnedEnd)) latestMin=Math.max(latestMin, latestPinnedEnd);

  if(latestMin<=earliestMin) latestMin=earliestMin+60;

  const totalMinutes=latestMin-earliestMin;
  const totalHeight=totalMinutes*PIXELS_PER_MINUTE;

  let html=`<div style="display:grid;grid-template-columns:60px repeat(${availableDivisions.length},1fr);position:relative;">`;
  html+=`<div style="grid-row:1;position:sticky;top:0;background:#fff;z-index:10;border-bottom:1px solid #999;padding:8px;">Time</div>`;
  availableDivisions.forEach((divName,i)=>{
    html+=`<div style="grid-row:1;grid-column:${i+2};position:sticky;top:0;background:${divisions[divName]?.color||'#333'};color:#fff;z-index:10;border-bottom:1px solid #999;padding:8px;text-align:center;">${divName}</div>`;
  });

  html+=`<div style="grid-row:2;grid-column:1;height:${totalHeight}px;position:relative;background:#f9f9f9;border-right:1px solid #ccc;">`;
  for(let m=earliestMin;m<latestMin;m+=INCREMENT_MINS){
    const top=(m-earliestMin)*PIXELS_PER_MINUTE;
    html+=`<div style="position:absolute;top:${top}px;left:0;width:100%;height:${INCREMENT_MINS*PIXELS_PER_MINUTE}px;border-bottom:1px dashed #ddd;box-sizing:border-box;font-size:10px;padding:2px;color:#777;">${minutesToTime(m)}</div>`;
  }
  html+=`</div>`;

  availableDivisions.forEach((divName,i)=>{
    const div=divisions[divName];
    const s=parseTimeToMinutes(div?.startTime);
    const e=parseTimeToMinutes(div?.endTime);
    html+=`<div class="grid-cell" data-div="${divName}" data-start-min="${earliestMin}" style="grid-row:2;grid-column:${i+2};position:relative;height:${totalHeight}px;border-right:1px solid #ccc;">`;
    if(s!==null && s>earliestMin){
      const gh=(s-earliestMin)*PIXELS_PER_MINUTE;
      html+=`<div class="grid-disabled" style="top:0;height:${gh}px;"></div>`;
    }
    if(e!==null && e<latestMin){
      const gt=(e-earliestMin)*PIXELS_PER_MINUTE;
      const gh=(latestMin-e)*PIXELS_PER_MINUTE;
      html+=`<div class="grid-disabled" style="top:${gt}px;height:${gh}px;"></div>`;
    }
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
  addDropListeners('.grid-cell');
  addRemoveListeners('.grid-event');
}

function addDropListeners(selector){
  grid.querySelectorAll(selector).forEach(cell=>{
    cell.ondragover=(e)=>{ e.preventDefault(); e.dataTransfer.dropEffect='copy'; cell.style.backgroundColor='#e0ffe0'; };
    cell.ondragleave=()=>{ cell.style.backgroundColor=''; };
    cell.ondrop=(e)=>{
      e.preventDefault();
      cell.style.backgroundColor='';
      const tileData=JSON.parse(e.dataTransfer.getData('application/json'));
      const divName=cell.dataset.div;

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
        if(m===null){ alert("Invalid time. Use '9:00am' etc."); return null; }
        if(divStart!==null && m<divStart){ alert(`Error: ${timeStr} is before ${div.startTime}.`); return null; }
        if(divEnd!==null && (isStart? m>=divEnd : m>divEnd)){ alert(`Error: ${timeStr} is after ${div.endTime}.`); return null; }
        return m;
      };

      if(tileData.type==='split'){
        let st,et,sm,em;
        while(true){ st=prompt(`Enter Start Time for the *full* block:`,defaultStart); if(!st) return; sm=validate(st,true); if(sm!==null) break; }
        while(true){ et=prompt(`Enter End Time for the *full* block:`); if(!et) return; em=validate(et,false); if(em!==null){ if(em<=sm) alert("End must be after start."); else break; } }
        const n1=prompt("Enter FIRST activity (e.g., Swim, Sports):"); if(!n1) return;
        const n2=prompt("Enter SECOND activity (e.g., Activity, Sports):"); if(!n2) return;
        const e1=mapEventNameForOptimizer(n1), e2=mapEventNameForOptimizer(n2);
        newEvent={id:`evt_${Math.random().toString(36).slice(2,9)}`, type:'split', event:`${n1} / ${n2}`, division:divName, startTime:st, endTime:et, subEvents:[e1,e2]};
      
      } else if(['lunch','snacks','custom','dismissal','swim'].includes(tileData.type)){
        eventType='pinned';
        if(tileData.type==='custom'){
          eventName=prompt("Enter the name (e.g., 'Regroup', 'Assembly'):");
          if(!eventName) return;
        } else {
          eventName=tileData.name;
        }
      }

      if(!newEvent){
        let st,et,sm,em;
        while(true){ st=prompt(`Add "${eventName}" for ${divName}?\n\nEnter Start Time:`,defaultStart); if(!st) return; sm=validate(st,true); if(sm!==null) break; }
        while(true){ et=prompt(`Enter End Time:`); if(!et) return; em=validate(et,false); if(em!==null){ if(em<=sm) alert("End must be after start."); else break; } }
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
      const ev=dailySkeleton.find(v=>v.id===id);
      if(confirm(`Remove "${ev?ev.event:'this event'}"?`)){
        dailySkeleton=dailySkeleton.filter(v=>v.id!==id);
        saveDraftToLocalStorage();
        renderGrid();
      }
    };
  });
}

function renderEventTile(event, top, height){
  let tile=TILES.find(t=>t.name===event.event);
  if(!tile){
    if(event.type==='split') tile=TILES.find(t=>t.type==='split');
    else if(event.event==='General Activity Slot') tile=TILES.find(t=>t.type==='activity');
    else if(event.event==='Sports Slot') tile=TILES.find(t=>t.type==='sports');
    else if(event.event==='Special Activity') tile=TILES.find(t=>t.type==='special');
    else if(event.event==='Dismissal') tile=TILES.find(t=>t.type==='dismissal');
    else tile=TILES.find(t=>t.type==='custom');
  }
  const style=tile?tile.style:'background:#eee;border:1px solid #616161;';
  return `
    <div class="grid-event" data-event-id="${event.id}" title="Click to remove this event"
         style="${style};padding:2px 5px;border-radius:4px;text-align:center;margin:0 1px;font-size:.9em;position:absolute;top:${top}px;height:${height}px;width:calc(100% - 4px);box-sizing:border-box;overflow:hidden;cursor:pointer;">
      <strong>${event.event}</strong>
      <div style="font-size:.85em;">${event.startTime} - ${event.endTime}</div>
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
    const s=all[name];
    dailySkeleton=s? JSON.parse(JSON.stringify(s)): [];
  }
  renderGrid();
  saveDraftToLocalStorage();
}

// time helpers
function parseTimeToMinutes(str){
  if(!str||typeof str!=='string') return null;
  let s=str.trim().toLowerCase(), mer=null;
  if(s.endsWith('am')||s.endsWith('pm')){ mer=s.endsWith('am')?'am':'pm'; s=s.replace(/am|pm/g,'').trim(); }
  const m=s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
  if(!m) return null;
  let hh=parseInt(m[1],10), mm=parseInt(m[2],10);
  if(Number.isNaN(hh)||Number.isNaN(mm)||mm<0||mm>59) return null;
  if(mer){ if(hh===12) hh= mer==='am'?0:12; else if(mer==='pm') hh+=12; } else return null;
  return hh*60+mm;
}
function minutesToTime(min){
  const hh=Math.floor(min/60), mm=min%60;
  const h=hh%12===0?12:hh%12, m=String(mm).padStart(2,'0'), ap=hh<12?'am':'pm';
  return `${h}:${m}${ap}`;
}

window.initMasterScheduler=init;

})();
