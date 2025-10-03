// -------------------- State --------------------
let timeTemplates = [];
let fields = [];
let specialActivities = [];
let leagues = {};
let availableDivisions = []; // populated from app1.js when divisions are added

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
  const cont=document.getElementById("timeTemplates"); 
  cont.innerHTML="";
  timeTemplates.forEach((tpl,idx)=>{
    const wrap=document.createElement("div"); wrap.className="fieldWrapper";
    const label=document.createElement("span"); label.textContent=`${tpl.start} - ${tpl.end}`;
    wrap.appendChild(label);

    availableDivisions.forEach(div=>{
      const btn=document.createElement("button");
      btn.textContent=div; btn.className="bunk-button";
      if(tpl.divisions.includes(div)){ btn.style.backgroundColor=divisions.find(d=>d.name===div).color; btn.style.color="#fff"; }
      else { btn.style.backgroundColor="#fff"; btn.style.color="#000"; }
      btn.onclick=()=>{
        if(tpl.divisions.includes(div)) tpl.divisions = tpl.divisions.filter(d=>d!==div);
        else tpl.divisions.push(div);
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
    if(match){ 
      let d = divisions.find(dd=>dd.name===div);
      if(d){ d.start=match.start; d.end=match.end; }
    }
  });
}

// -------------------- Fields --------------------
function addFieldAdvanced(){
  const i=document.getElementById("fieldInput"); 
  const n=i.value.trim();
  if(n){
    fields.push({name:n,activities:[],available:true});
    i.value="";
    renderFieldsAdvanced();
  }
}

function renderFieldsAdvanced(){
  const c=document.getElementById("fieldList"); c.innerHTML="";
  fields.forEach(f=>{
    const w=document.createElement("div"); w.className="fieldWrapper"; if(!f.available)w.classList.add("unavailable");
    const t=document.createElement("span"); t.className="fieldTitle"; t.textContent=f.name;
    makeEditable(t,newName=>{f.name=newName;renderFieldsAdvanced();}); 
    w.appendChild(t);

    const tog=document.createElement("label"); tog.className="switch";
    const cb=document.createElement("input"); cb.type="checkbox"; cb.checked=f.available;
    cb.onchange=()=>{f.available=cb.checked;renderFieldsAdvanced();};
    const sl=document.createElement("span"); sl.className="slider";
    tog.appendChild(cb); tog.appendChild(sl); w.appendChild(tog);

    const bw=document.createElement("div"); bw.style.marginTop="8px";
    commonActivities.forEach(act=>{
      const b=document.createElement("button"); b.textContent=act; b.className="activity-button";
      if(f.activities.includes(act)) b.classList.add("active");
      b.onclick=()=>{ 
        if(f.activities.includes(act)) f.activities=f.activities.filter(a=>a!==act); 
        else f.activities.push(act); 
        renderFieldsAdvanced(); 
      };
      bw.appendChild(b);
    });
    w.appendChild(bw);

    const other=document.createElement("input"); other.placeholder="Other activity";
    other.onkeyup=e=>{
      if(e.key==="Enter" && other.value.trim()){
        const v=other.value.trim(); 
        if(!f.activities.includes(v)) f.activities.push(v);
        other.value=""; 
        renderFieldsAdvanced();
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

// -------------------- Specials --------------------
function addSpecial(){
  const i=document.getElementById("specialInput"); 
  const n=i.value.trim();
  if(n){
    specialActivities.push({name:n,available:true}); 
    i.value=""; 
    renderSpecials();
  }
}

function renderSpecials(){
  const c=document.getElementById("specialList"); c.innerHTML="";
  specialActivities.forEach(s=>{
    const w=document.createElement("div"); w.className="fieldWrapper"; if(!s.available)w.classList.add("unavailable");
    const t=document.createElement("span"); t.className="fieldTitle"; t.textContent=s.name;
    makeEditable(t,newName=>{s.name=newName;renderSpecials();}); 
    w.appendChild(t);

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

// -------------------- Init --------------------
window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("addTimeTemplateBtn")?.addEventListener("click", addTimeTemplate);

  document.getElementById("addFieldBtn").onclick = addFieldAdvanced;
  document.getElementById("fieldInput").addEventListener("keyup", e=>{if(e.key==="Enter") addFieldAdvanced();});

  document.getElementById("addSpecialBtn").onclick = addSpecial;
  document.getElementById("specialInput").addEventListener("keyup", e=>{if(e.key==="Enter") addSpecial();});
});
