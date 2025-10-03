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
    
    // Safe rename logic
    makeEditable(span,newName=>{
      if (!newName || newName === name) return;

      if (divisions[name]) {
        divisions[newName] = divisions[name];
        delete divisions[name];
      }
      if (leagues[name]) {
        leagues[newName] = leagues[name];
        delete leagues[name];
      }
      const idx = availableDivisions.indexOf(name);
      if (idx !== -1) {
        availableDivisions[idx] = newName;
      }
      if (selectedDivision === name) {
        selectedDivision = newName;
      }

      setupDivisionButtons();
      renderLeagues();
      renderTimeTemplates();
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
    unifiedTimes.forEach((t,idx)=>{
      if (s && e && t.start >= s && t.start < e) rows.add(idx);
    });
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
  availableDivisions.for
