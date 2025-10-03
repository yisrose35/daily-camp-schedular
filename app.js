// -------------------- State --------------------
let bunks = [];
let divisions = {};  // { divName:{ bunks:[], color, start, end } }
let availableDivisions = [];
let selectedDivision = null;

let fields = [], specialActivities = [];
let leagues = {};    // { divName:{enabled:boolean, sports:string[]} }

let timeTemplates = []; // [{start,end,divisions:[]}]
let activityDuration = 30;
let scheduleAssignments = {}; // { bunkName: [ per unified row index: {field,sport,continuation,isLeague,_skip} ] }
let unifiedTimes = []; // [{start:Date,end:Date,label:string}]
let divisionActiveRows = {}; // { divName: Set(rowIndices) }

const defaultColors = ['#4CAF50','#2196F3','#E91E63','#FF9800','#9C27B0','#00BCD4','#FFC107','#F44336','#8BC34A','#3F51B5'];
let colorIndex=0;
const commonActivities=["Basketball","Baseball","Hockey","Football","Soccer","Volleyball","Lacrosse"];
const leagueSports=["Basketball","Hockey","Volleyball","Soccer","Kickball","Punchball","Baseball"];

document.getElementById("activityDuration").onchange=function(){activityDuration=parseInt(this.value);};

// -------------------- Helpers --------------------
function makeEditable(el, save){
  el.ondblclick=e=>{
    e.stopPropagation();
    const old=el.textContent;
    const input=document.createElement("input");
    input.type="text"; input.value=old;
    el.replaceWith(input); input.focus();
    function done(){
      const val=input.value.trim();
      if(val&&val!==old) save(val);
      el.textContent=val||old; input.replaceWith(el);
    }
    input.onblur=done; input.onkeyup=e=>{if(e.key==="Enter")done();};
  };
}
function parseTime(str){
  if(!str) return null;
  const m=str.match(/^(\d{1,2}):(\d{2})(\s*)?(AM|PM)$/i);
  if(!m) return null;
  let h=parseInt(m[1],10), min=parseInt(m[2],10), ap=m[4].toUpperCase();
  if(ap==="PM"&&h!==12)h+=12; if(ap==="AM"&&h===12)h=0;
  return new Date(0,0,0,h,min);
}
function fmtTime(d){
  let h=d.getHours(),m=d.getMinutes().toString().padStart(2,"0"),ap=h>=12?"PM":"AM";h=h%12||12;
  return `${h}:${m} ${ap}`;
}

// -------------------- Tabs --------------------
function showTab(id){
  document.querySelectorAll('.tab-button').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c=>c.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  document.querySelector(`.tab-button[onclick="showTab('${id}')"]`).classList.add('active');
  if(id==='schedule') updateTable();
  if(id==='leagues') renderLeagues();
}

// -------------------- Bunks --------------------
function addBunk(){
  const i=document.getElementById("bunkInput");
  if(i.value.trim()!==""){
    bunks.push(i.value.trim());
    i.value="";
    updateUnassigned(); updateTable();
  }
}
document.getElementById("addBunkBtn").onclick=addBunk;
document.getElementById("bunkInput").addEventListener("keyup",e=>{if(e.key==="Enter")addBunk();});

function updateUnassigned(){
  const c=document.getElementById("unassignedBunks");c.innerHTML="";
  bunks.forEach(b=>{
    const span=document.createElement("span");
    span.textContent=b;span.className="bunk-button";
    let assigned=null;
    for(const d in divisions){ if(divisions[d].bunks.includes(b)) assigned=d; }
    if(assigned){span.style.backgroundColor=divisions[assigned].color;span.style.color="#fff";}
    span.onclick=()=>{
      if(selectedDivision && (!assigned||assigned!==selectedDivision)){
        for(const d in divisions){const i=divisions[d].bunks.indexOf(b);if(i!==-1)divisions[d].bunks.splice(i,1);}
        divisions[selectedDivision].bunks.push(b);updateUnassigned();updateTable();
      }else if(!selectedDivision){ alert("Select a division first!"); }
    };
   makeEditable(span,newName=>{
  if (!newName || newName === b) return;

  // Update global bunks list
  const idx=bunks.indexOf(b);
  if(idx!==-1) bunks[idx]=newName;

  // Update divisions that contain this bunk
  for(const d of Object.values(divisions)){
    const i=d.bunks.indexOf(b);
    if(i!==-1) d.bunks[i]=newName;
  }

  // Update schedule assignments
  if(scheduleAssignments[b]){
    scheduleAssignments[newName]=scheduleAssignments[b];
    delete scheduleAssignments[b];
  }

  updateUnassigned();
  setupDivisionButtons(); // refresh division buttons after rename
  updateTable();
});

}

// -------------------- Divisions --------------------
function addDivision(){
  const i=document.getElementById("divisionInput");
  if(i.value.trim()==="")return;
  const name=i.value.trim();
  if(!availableDivisions.includes(name)){
    const color=defaultColors[colorIndex%defaultColors.length]; colorIndex++;
    availableDivisions.push(name);
    divisions[name]={bunks:[],color,start:null,end:null};
    leagues[name]={enabled:false,sports:[]};
    i.value="";
    setupDivisionButtons(); renderLeagues(); updateTable();
    renderTimeTemplates();
  }
}
document.getElementById("addDivisionBtn").onclick=addDivision;
document.getElementById("divisionInput").addEventListener("keyup",e=>{if(e.key==="Enter")addDivision();});

function setupDivisionButtons(){
  const cont=document.getElementById("divisionButtons"); cont.innerHTML="";
  const colorEnabled=document.getElementById("enableColor").checked;
  availableDivisions.forEach(name=>{
    const obj=divisions[name];
    const wrap=document.createElement("div"); wrap.className="divisionWrapper";
    const span=document.createElement("span"); span.textContent=name; span.className="bunk-button";
    span.style.backgroundColor=colorEnabled?obj.color:"transparent";
    span.style.color=colorEnabled?"#fff":"inherit";
    span.onclick=()=>{selectedDivision=name; cont.querySelectorAll('span.bunk-button').forEach(el=>el.classList.remove("selected")); span.classList.add("selected");};
    makeEditable(span,newName=>{
  if (!newName || newName === name) return;

  // Move division object
  divisions[newName] = {...divisions[name]};
  delete divisions[name];

  // Move league settings
  leagues[newName] = leagues[name] || {enabled:false,sports:[]};
  delete leagues[name];

  // Update availableDivisions array
  const idx = availableDivisions.indexOf(name);
  if (idx !== -1) availableDivisions[idx] = newName;

  // Update selectedDivision if needed
  if (selectedDivision === name) selectedDivision = newName;

  setupDivisionButtons();
  renderLeagues();
  renderTimeTemplates();
  updateUnassigned(); // refresh bunk assignments to display properly
  updateTable();
});

    wrap.appendChild(span);
    const col=document.createElement("input"); col.type="color"; col.value=obj.color; col.className="colorPicker";
    col.oninput=e=>{obj.color=e.target.value; if(colorEnabled){span.style.backgroundColor=e.target.value; span.style.color="#fff";} updateTable(); renderTimeTemplates();};
    wrap.appendChild(col);
    cont.appendChild(wrap);
  });
}
document.getElementById("enableColor").addEventListener("change", setupDivisionButtons);

// -------------------- Time Templates --------------------
function addTimeTemplate(){
  const start=document.getElementById("timeStartInput").value.trim();
  const end=document.getElementById("timeEndInput").value.trim();
  if(!start||!end) return;
  timeTemplates.push({start,end,divisions:[]});
  document.getElementById("timeStartInput").value="";
  document.getElementById("timeEndInput").value="";
  renderTimeTemplates();
}

function renderTimeTemplates(){
  const cont=document.getElementById("timeTemplates"); cont.innerHTML="";
  timeTemplates.forEach((tpl,idx)=>{
    const wrap=document.createElement("div"); wrap.className="fieldWrapper";
    const label=document.createElement("span"); label.textContent=`${tpl.start} - ${tpl.end}`;
    wrap.appendChild(label);

    availableDivisions.forEach(div=>{
      const btn=document.createElement("button");
      btn.textContent=div; btn.className="bunk-button";
      if(tpl.divisions.includes(div)){ btn.style.backgroundColor=divisions[div].color; btn.style.color="#fff"; }
      else { btn.style.backgroundColor="#fff"; btn.style.color="#000"; }
      btn.onclick=()=>{
        if(tpl.divisions.includes(div)){
          tpl.divisions = tpl.divisions.filter(d=>d!==div);
        } else {
          tpl.divisions.push(div);
        }
        applyTemplatesToDivisions();
        renderTimeTemplates();
      };
      wrap.appendChild(btn);
    });

    cont.appendChild(wrap);
  });
  applyTemplatesToDivisions();
}

function applyTemplatesToDivisions(){
  availableDivisions.forEach(div=>{
    let match = null;
    for(let i=timeTemplates.length-1;i>=0;i--){
      if(timeTemplates[i].divisions.includes(div)){ match=timeTemplates[i]; break; }
    }
    if(match){ divisions[div].start=match.start; divisions[div].end=match.end; }
  });
}

// -------------------- Generate Times --------------------
function generateTimes(){
  const inc = parseInt(document.getElementById("increment").value);
  applyTemplatesToDivisions();
  const starts = availableDivisions.map(d=>parseTime(divisions[d].start)).filter(Boolean);
  const ends   = availableDivisions.map(d=>parseTime(divisions[d].end)).filter(Boolean);
  if(starts.length===0 || ends.length===0){ alert("Please set time templates for divisions first."); return; }
  const earliest = new Date(Math.min(...starts.map(d=>d.getTime())));
  const latest   = new Date(Math.max(...ends.map(d=>d.getTime())));
  unifiedTimes = [];
  let cur = new Date(earliest);
  while(cur < latest){
    let nxt = new Date(cur.getTime() + inc*60000);
    if(nxt > latest) nxt = latest;
    unifiedTimes.push({ start:new Date(cur), end:new Date(nxt), label:`${fmtTime(cur)} - ${fmtTime(nxt)}` });
    cur = nxt;
  }
  divisionActiveRows = {};
  availableDivisions.forEach(div=>{
    const s=parseTime(divisions[div].start), e=parseTime(divisions[div].end);
    const rows = new Set();
    unifiedTimes.forEach((t,idx)=>{ if (s && e && t.start >= s && t.start < e) rows.add(idx); });
    divisionActiveRows[div] = rows;
  });
  assignFieldsToBunks();
  updateTable();
}

// -------------------- Fields / Specials --------------------
function addField(){
  const i=document.getElementById("fieldInput"); const n=i.value.trim();
  if(n){fields.push({name:n,activities:[],available:true});i.value="";renderFields();}
}
document.getElementById("addFieldBtn").onclick=addField;
document.getElementById("fieldInput").addEventListener("keyup",e=>{if(e.key==="Enter")addField();});

function renderFields(){
  const c=document.getElementById("fieldList"); c.innerHTML="";
  fields.forEach(f=>{
    const w=document.createElement("div"); w.className="fieldWrapper"; if(!f.available)w.classList.add("unavailable");
    const t=document.createElement("span"); t.className="fieldTitle"; t.textContent=f.name;
    makeEditable(t,newName=>{f.name=newName;renderFields();}); w.appendChild(t);

    const tog=document.createElement("label"); tog.className="switch";
    const cb=document.createElement("input"); cb.type="checkbox"; cb.checked=f.available;
    cb.onchange=()=>{f.available=cb.checked;renderFields();};
    const sl=document.createElement("span"); sl.className="slider";
    tog.appendChild(cb); tog.appendChild(sl); w.appendChild(tog);

    const bw=document.createElement("div"); bw.style.marginTop="8px";
    commonActivities.forEach(act=>{
      const b=document.createElement("button"); b.textContent=act; b.className="activity-button";
      if(f.activities.includes(act)) b.classList.add("active");
      b.onclick=()=>{ if(f.activities.includes(act)) f.activities=f.activities.filter(a=>a!==act); else f.activities.push(act); renderFields(); };
      bw.appendChild(b);
    });
    w.appendChild(bw);

    const other=document.createElement("input"); other.placeholder="Other activity";
    other.onkeyup=e=>{
      if(e.key==="Enter" && other.value.trim()){
        const v=other.value.trim(); if(!f.activities.includes(v)) f.activities.push(v);
        other.value=""; renderFields();
      }
    };
    w.appendChild(other);

    if(f.activities.length>0){
      const p=document.createElement("p"); p.style.marginTop="6px"; p.textContent="Activities: "+f.activities.join(", ");
      w.appendChild(p);
    }
    c.appendChild(w);
  });
}

function addSpecial(){
  const i=document.getElementById("specialInput"); const n=i.value.trim();
  if(n){specialActivities.push({name:n,available:true}); i.value=""; renderSpecials();}
}
document.getElementById("addSpecialBtn").onclick=addSpecial;
document.getElementById("specialInput").addEventListener("keyup",e=>{if(e.key==="Enter")addSpecial();});

function renderSpecials(){
  const c=document.getElementById("specialList"); c.innerHTML="";
  specialActivities.forEach(s=>{
    const w=document.createElement("div"); w.className="fieldWrapper"; if(!s.available)w.classList.add("unavailable");
    const t=document.createElement("span"); t.className="fieldTitle"; t.textContent=s.name;
    makeEditable(t,newName=>{s.name=newName;renderSpecials();}); w.appendChild(t);

    const tog=document.createElement("label"); tog.className="switch";
    const cb=document.createElement("input"); cb.type="checkbox"; cb.checked=s.available;
    cb.onchange=()=>{s.available=cb.checked;renderSpecials();};
    const sl=document.createElement("span"); sl.className="slider";
    tog.appendChild(cb); tog.appendChild(sl); w.appendChild(tog);

    c.appendChild(w);
  });
}

// -------------------- Leagues --------------------
function renderLeagues(){
  const container=document.getElementById("leaguesContainer");
  container.innerHTML="";
  availableDivisions.forEach(divName=>{
    if(!leagues[divName]) leagues[divName]={enabled:false,sports:[]};
    const wrap=document.createElement("div"); wrap.className="fieldWrapper";

    const title=document.createElement("span"); title.className="fieldTitle"; title.textContent=divName;
    wrap.appendChild(title);

    const toggle=document.createElement("label"); toggle.className="switch";
    const cb=document.createElement("input"); cb.type="checkbox"; cb.checked=leagues[divName].enabled;
    cb.onchange=()=>{leagues[divName].enabled=cb.checked; renderLeagues();};
    const slider=document.createElement("span"); slider.className="slider";
    toggle.appendChild(cb); toggle.appendChild(slider);
    wrap.appendChild(toggle);

    const btnWrap=document.createElement("div"); btnWrap.style.marginTop="8px";
    leagueSports.forEach(sport=>{
      const btn=document.createElement("button"); btn.textContent=sport; btn.className="activity-button";
      if(leagues[divName].sports.includes(sport)) btn.classList.add("active");
      btn.onclick=()=>{
        if(leagues[divName].sports.includes(sport)){
          leagues[divName].sports = leagues[divName].sports.filter(s=>s!==sport);
        } else {
          leagues[divName].sports.push(sport);
        }
        renderLeagues();
      };
      btnWrap.appendChild(btn);
    });
    wrap.appendChild(btnWrap);

    const other=document.createElement("input"); other.placeholder="Other sport";
    other.onkeyup=e=>{
      if(e.key==="Enter" && other.value.trim()){
        const val=other.value.trim();
        if(!leagues[divName].sports.includes(val)) leagues[divName].sports.push(val);
        other.value=""; renderLeagues();
      }
    };
    wrap.appendChild(other);

    if(leagues[divName].sports.length>0){
      const chosen=document.createElement("p"); chosen.style.marginTop="6px";
      chosen.textContent="Sports: "+leagues[divName].sports.join(", ");
      wrap.appendChild(chosen);
    }
    container.appendChild(wrap);
  });
}

// -------------------- Scheduling Core --------------------
function assignFieldsToBunks() {
  const availFields = fields.filter(f => f.available && f.activities.length>0);
  const availSpecials = specialActivities.filter(s => s.available);

  const allActivities = [
    ...availFields.flatMap(f => f.activities.map(act => ({type:"field", field:f, sport:act}))),
    ...availSpecials.map(sa => ({type:"special", field:{name:sa.name}, sport:null}))
  ];
  if (allActivities.length === 0) { alert("No activities available."); scheduleAssignments={}; return; }

  scheduleAssignments = {};
  availableDivisions.forEach(div=>{
    divisions[div].bunks.forEach(b=>{ scheduleAssignments[b]=new Array(unifiedTimes.length); });
  });

  const inc = parseInt(document.getElementById("increment").value);
  const spanLen = Math.max(1, Math.ceil(activityDuration / inc));

  const leagueSlotByDiv = {};
  availableDivisions.forEach(div=>{
    if (leagues[div] && leagues[div].enabled) {
      const active = Array.from(divisionActiveRows[div] || []);
      if (active.length>0) {
        leagueSlotByDiv[div] = active[Math.floor(Math.random()*active.length)];
      }
    }
  });

  for (let s=0; s<unifiedTimes.length; s++){
    const usedFieldsByDiv = {};
    availableDivisions.forEach(div=>{
      usedFieldsByDiv[div] = new Set();
      divisions[div].bunks.forEach(bunk=>{
        const entry = scheduleAssignments[bunk][s];
        if (entry && entry.continuation) usedFieldsByDiv[div].add(entry.field);
      });
    });

    for (let div of availableDivisions) {
      const isActiveRow = divisionActiveRows[div] && divisionActiveRows[div].has(s);
      if (!isActiveRow) continue;

      for (let bunk of divisions[div].bunks) {
        if (scheduleAssignments[bunk][s] && scheduleAssignments[bunk][s].continuation) continue;

        let lastIdx = s-1, lastEntry = null;
        while (lastIdx>=0 && !scheduleAssignments[bunk][lastIdx]) lastIdx--;
        if (lastIdx>=0) lastEntry = scheduleAssignments[bunk][lastIdx];

        if (leagueSlotByDiv[div] === s && leagues[div] && leagues[div].enabled) {
          if (lastEntry && lastEntry.isLeague) {
            let next = s+1;
            while (next<unifiedTimes.length && (!divisionActiveRows[div].has(next))) next++;
            leagueSlotByDiv[div] = Math.min(next, unifiedTimes.length-1);
          }
          if (leagueSlotByDiv[div] === s) {
            scheduleAssignments[bunk][s] = { field:"Leagues", sport:null, continuation:false, isLeague:true };
            let placed = 1, k = 1;
            while (placed < spanLen && (s+k)<unifiedTimes.length && divisionActiveRows[div].has(s+k)) {
              scheduleAssignments[bunk][s+k] = { field:"Leagues", sport:null, continuation:true, isLeague:true };
              placed++; k++;
            }
            usedFieldsByDiv[div].add("Leagues");
            continue;
          }
        }

        if (lastEntry && !lastEntry.continuation) {
          let countDone = 1;
          let t = lastIdx+1;
          while (t<s && scheduleAssignments[bunk][t] && scheduleAssignments[bunk][t].continuation) { countDone++; t++; }
          if (countDone < spanLen) {
            scheduleAssignments[bunk][s] = { field:lastEntry.field, sport:lastEntry.sport, continuation:true, isLeague:lastEntry.isLeague||false };
            usedFieldsByDiv[div].add(lastEntry.field);
            continue;
          }
        }

        let candidates = allActivities.filter(c => {
  // Exclude if already in use this row
  if (usedFieldsByDiv[div].has(c.field.name)) return false;

  // Exclude if this activity would overlap with an existing assignment in later rows
  for (let k = 0; k < spanLen; k++) {
    const futureRow = s + k;
    if (futureRow >= unifiedTimes.length) break;

    // Check every bunk in this division
    for (let otherBunk of divisions[div].bunks) {
      if (otherBunk === bunk) continue;
      const e = scheduleAssignments[otherBunk][futureRow];
      if (e && e.field === c.field.name) {
        return false; // overlap conflict
      }
    }
  }
  return true;
});


        scheduleAssignments.__done = scheduleAssignments.__done || {};
        scheduleAssignments.__done[bunk] = scheduleAssignments.__done[bunk] || new Set();
        const doneSet = scheduleAssignments.__done[bunk];
        const preferred = candidates.filter(c => !doneSet.has(c.type==="field" ? c.sport : c.field.name));
        let chosen = (preferred.length>0 ? preferred : candidates)[Math.floor(Math.random()*(preferred.length>0 ? preferred.length : candidates.length) )];

        if (!chosen && allActivities.length>0) {
          let tries = allActivities.slice();
          do {
            chosen = tries.splice(Math.floor(Math.random()*tries.length),1)[0];
          } while (chosen && lastEntry && (chosen.field.name===lastEntry.field || chosen.sport===lastEntry.sport) && tries.length>0);
        }
        if (!chosen) continue;

        scheduleAssignments[bunk][s] = { field:chosen.field.name, sport:chosen.sport, continuation:false, isLeague:false };
        usedFieldsByDiv[div].add(chosen.field.name);
        doneSet.add(chosen.type==="field" ? chosen.sport : chosen.field.name);

        let placed = 1, k=1;
        while (placed < spanLen && (s+k) < unifiedTimes.length && divisionActiveRows[div].has(s+k)) {
          scheduleAssignments[bunk][s+k] = { field:chosen.field.name, sport:chosen.sport, continuation:true, isLeague:false };
          placed++; k++;
        }
      }
    }
  }
}

// -------------------- Rendering --------------------
function updateTable(){
  const scheduleTab = document.getElementById("schedule");
  scheduleTab.innerHTML = "";

  if (unifiedTimes.length === 0) return;

  Object.keys(scheduleAssignments).forEach(b=>{
    if (Array.isArray(scheduleAssignments[b])) {
      scheduleAssignments[b].forEach(e=>{ if(e) delete e._skip; });
    }
  });

  const table=document.createElement("table");
  table.className="division-schedule";

  const thead=document.createElement("thead");
  const row1=document.createElement("tr");
  const thTime=document.createElement("th"); thTime.textContent="Time"; row1.appendChild(thTime);
  availableDivisions.forEach(div=>{
    const th=document.createElement("th");
    th.colSpan = divisions[div].bunks.length || 1;
    th.textContent=div;
    th.style.background=divisions[div].color; th.style.color="#fff";
    row1.appendChild(th);
  });
  thead.appendChild(row1);

  const row2=document.createElement("tr");
  const thBunkLabel=document.createElement("th"); thBunkLabel.textContent="Bunk"; row2.appendChild(thBunkLabel);
  availableDivisions.forEach(div=>{
    divisions[div].bunks.forEach(b=>{
      const th=document.createElement("th"); th.textContent=b; row2.appendChild(th);
    });
  });
  thead.appendChild(row2);
  table.appendChild(thead);

  const tbody=document.createElement("tbody");
  for (let s=0; s<unifiedTimes.length; s++){
    const tr=document.createElement("tr");
    const tdTime=document.createElement("td"); tdTime.textContent=unifiedTimes[s].label; tr.appendChild(tdTime);

    availableDivisions.forEach(div=>{
      const activeSet = divisionActiveRows[div] || new Set();
      divisions[div].bunks.forEach(bunk=>{
        if (scheduleAssignments[bunk] && scheduleAssignments[bunk][s] && scheduleAssignments[bunk][s]._skip) return;
        const td=document.createElement("td");
        const isActive = activeSet.has(s);
        if (!isActive) {
          td.className="grey-cell";
          tr.appendChild(td);
          return;
        }
        const entry = scheduleAssignments[bunk] ? scheduleAssignments[bunk][s] : null;
        if (entry && !entry.continuation) {
          let span=1;
          for (let k=s+1; k<unifiedTimes.length; k++){
            const e2 = scheduleAssignments[bunk][k];
            if (!e2 || !e2.continuation || e2.field!==entry.field || e2.sport!==entry.sport || e2.isLeague!==entry.isLeague) break;
            span++;
            scheduleAssignments[bunk][k]._skip = true;
          }
          td.rowSpan = span;
          if (entry.isLeague) {
            td.innerHTML = `<span class="league-pill">Leagues</span>`;
          } else {
            td.textContent = entry.sport ? `${entry.field} – ${entry.sport}` : entry.field;
          }
        } else if (!entry) {
          td.textContent = "";
        }
        tr.appendChild(td);
      });
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  scheduleTab.appendChild(table);
}

// -------------------- Init --------------------
document.getElementById("addFieldBtn").disabled = false;
