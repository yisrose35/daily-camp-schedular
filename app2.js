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
    
    // ✅ Fixed rename logic
    makeEditable(span,newName=>{
      if (!newName || newName === name) return;

      // copy old division data safely
      if (divisions[name]) {
        const oldData = divisions[name];
        divisions[newName] = { ...oldData };
        delete divisions[name];
      }

      // copy league data safely
      if (leagues[name]) {
        leagues[newName] = { ...leagues[name] };
        delete leagues[name];
      }

      // update availableDivisions
      const idx = availableDivisions.indexOf(name);
      if (idx !== -1) {
        availableDivisions[idx] = newName;
      }

      // update selected division if needed
      if (selectedDivision === name) {
        selectedDivision = newName;
      }

      // re-render
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

