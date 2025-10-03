// -------------------- Defaults --------------------
const commonActivities = ["Basketball","Baseball","Hockey","Football","Soccer","Volleyball","Lacrosse"];
const leagueSports     = ["Basketball","Hockey","Volleyball","Soccer","Kickball","Punchball","Baseball"];

// -------------------- State --------------------
let timeTemplates = [];         // [{start,end,divisions:[name,...]}]
let fields = [];                // [{name,activities:[],available:true}]
let specialActivities = [];     // [{name,available:true}]
let leagues = {};               // { [divisionName]: {enabled:boolean, sports:[]}}
let availableDivisions = [];    // names; synced from app1.js

// -------------------- Division Sync (called by app1.js) --------------------
function onDivisionsChanged() {
  // divisions[] comes from app1.js
  availableDivisions = divisions.map(d => d.name);
  // Ensure leagues map has keys
  availableDivisions.forEach(n => { if (!leagues[n]) leagues[n] = {enabled:false, sports:[]}; });
  renderLeagues();
  renderTimeTemplates();
}

// -------------------- Time Helpers --------------------
function parseTime(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (!m) return null;
  let h = parseInt(m[1],10), min = parseInt(m[2],10);
  const ampm = m[3].toLowerCase();
  if (ampm === "pm" && h !== 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  const d = new Date(); d.setHours(h, min, 0, 0); return d;
}
function fmtTime(d) {
  let h = d.getHours(), m = d.getMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2,"0")}${ampm}`;
}

// -------------------- Time Templates --------------------
function addTimeTemplate() {
  const start = document.getElementById("timeStartInput").value.trim();
  const end   = document.getElementById("timeEndInput").value.trim();
  if (!start || !end) return;
  timeTemplates.push({start, end, divisions:[]});
  document.getElementById("timeStartInput").value="";
  document.getElementById("timeEndInput").value="";
  renderTimeTemplates();
}

function renderTimeTemplates() {
  const cont = document.getElementById("timeTemplates");
  if (!cont) return;
  cont.innerHTML = "";
  timeTemplates.forEach((tpl) => {
    const wrap=document.createElement("div"); wrap.className="fieldWrapper";
    const label=document.createElement("span"); label.textContent=`${tpl.start} - ${tpl.end}`;
    wrap.appendChild(label);

    availableDivisions.forEach(divName=>{
      const btn=document.createElement("button"); btn.textContent=divName; btn.className="bunk-button";
      const divObj = divisions.find(d => d.name === divName);
      const selected = tpl.divisions.includes(divName);
      btn.style.backgroundColor = selected ? (divObj?.color || "#333") : "#fff";
      btn.style.color = selected ? "#fff" : "#000";
      btn.onclick = () => {
        if (selected) tpl.divisions = tpl.divisions.filter(d => d !== divName);
        else tpl.divisions.push(divName);
        applyTemplatesToDivisions();
        renderTimeTemplates();
      };
      wrap.appendChild(btn);
    });
    cont.appendChild(wrap);
  });
  applyTemplatesToDivisions();
}

function applyTemplatesToDivisions() {
  availableDivisions.forEach(divName => {
    let match = null;
    for (let i = timeTemplates.length - 1; i >= 0; i--) {
      if (timeTemplates[i].divisions.includes(divName)) { match = timeTemplates[i]; break; }
    }
    if (match) {
      const d = divisions.find(dd => dd.name === divName);
      if (d) { d.start = match.start; d.end = match.end; }
    }
  });
}

// -------------------- Fields --------------------
function addFieldAdvanced() {
  const i = document.getElementById("fieldInput"); if (!i) return;
  const n = i.value.trim(); if (!n) return;
  fields.push({name:n, activities:[], available:true});
  i.value = "";
  renderFieldsAdvanced();
}
function renderFieldsAdvanced() {
  const c = document.getElementById("fieldList"); if (!c) return;
  c.innerHTML = "";
  fields.forEach((f, idx) => {
    const w=document.createElement("div"); w.className="fieldWrapper"; if(!f.available) w.classList.add("unavailable");
    const t=document.createElement("span"); t.className="fieldTitle"; t.textContent=f.name;
    if (typeof makeEditable === "function") makeEditable(t, newName => { f.name = newName; renderFieldsAdvanced(); });
    w.appendChild(t);

    const tog=document.createElement("label"); tog.className="switch";
    const cb=document.createElement("input"); cb.type="checkbox"; cb.checked=f.available;
    cb.onchange=()=>{ f.available = cb.checked; renderFieldsAdvanced(); };
    const sl=document.createElement("span"); sl.className="slider";
    tog.appendChild(cb); tog.appendChild(sl); w.appendChild(tog);

    const bw=document.createElement("div"); bw.style.marginTop="8px";
    commonActivities.forEach(act=>{
      const b=document.createElement("button"); b.textContent=act; b.className="activity-button";
      if(f.activities.includes(act)) b.classList.add("active");
      b.onclick=()=>{ 
        if(f.activities.includes(act)) f.activities = f.activities.filter(a=>a!==act);
        else f.activities.push(act);
        renderFieldsAdvanced();
      };
      bw.appendChild(b);
    });
    w.appendChild(bw);

    const other=document.createElement("input"); other.placeholder="Other activity";
    other.onkeyup=e=>{
      if(e.key==="Enter" && other.value.trim()){
        const v=other.value.trim(); if(!f.activities.includes(v)) f.activities.push(v);
        other.value=""; renderFieldsAdvanced();
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
function addSpecial() {
  const i = document.getElementById("specialInput"); if (!i) return;
  const n = i.value.trim(); if (!n) return;
  specialActivities.push({name:n, available:true});
  i.value = "";
  renderSpecials();
}
function renderSpecials() {
  const c = document.getElementById("specialList"); if (!c) return;
  c.innerHTML = "";
  specialActivities.forEach(s => {
    const w=document.createElement("div"); w.className="fieldWrapper"; if(!s.available) w.classList.add("unavailable");
    const t=document.createElement("span"); t.className="fieldTitle"; t.textContent=s.name;
    if (typeof makeEditable === "function") makeEditable(t, newName => { s.name = newName; renderSpecials(); });
    w.appendChild(t);

    const tog=document.createElement("label"); tog.className="switch";
    const cb=document.createElement("input"); cb.type="checkbox"; cb.checked=s.available;
    cb.onchange=()=>{ s.available = cb.checked; renderSpecials(); };
    const sl=document.createElement("span"); sl.className="slider";
    tog.appendChild(cb); tog.appendChild(sl); w.appendChild(tog);

    c.appendChild(w);
  });
}

// -------------------- Leagues --------------------
function renderLeagues() {
  const container = document.getElementById("leaguesContainer"); if (!container) return;
  container.innerHTML = "";
  availableDivisions.forEach(divName=>{
    if(!leagues[divName]) leagues[divName] = {enabled:false, sports:[]};
    const wrap=document.createElement("div"); wrap.className="fieldWrapper";

    const title=document.createElement("span"); title.className="fieldTitle"; title.textContent=divName;
    wrap.appendChild(title);

    const toggle=document.createElement("label"); toggle.className="switch";
    const cb=document.createElement("input"); cb.type="checkbox"; cb.checked=leagues[divName].enabled;
    cb.onchange=()=>{ leagues[divName].enabled = cb.checked; renderLeagues(); };
    const slider=document.createElement("span"); slider.className="slider";
    toggle.appendChild(cb); toggle.appendChild(slider); wrap.appendChild(toggle);

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

// -------------------- Generate Times (builds unifiedTimes + divisionActiveRows) --------------------
function generateTimes(){
  // uses globals from app3.js via window.*
  const inc = parseInt(document.getElementById("increment").value) || 30;

  // make sure division start/end are applied from templates first
  applyTemplatesToDivisions();

  const starts = availableDivisions.map(n => parseTime((divisions.find(d=>d.name===n)||{}).start)).filter(Boolean);
  const ends   = availableDivisions.map(n => parseTime((divisions.find(d=>d.name===n)||{}).end)).filter(Boolean);
  if (starts.length===0 || ends.length===0) { alert("Please set time templates for divisions first."); return; }

  const earliest = new Date(Math.min(...starts.map(d=>d.getTime())));
  const latest   = new Date(Math.max(...ends.map(d=>d.getTime())));

  window.unifiedTimes = [];
  let cur = new Date(earliest);
  while (cur < latest) {
    let nxt = new Date(cur.getTime() + inc*60000);
    if (nxt > latest) nxt = latest;
    unifiedTimes.push({ start:new Date(cur), end:new Date(nxt), label:`${fmtTime(cur)} - ${fmtTime(nxt)}` });
    cur = nxt;
  }

  window.divisionActiveRows = {};
  availableDivisions.forEach(divName=>{
    const d = divisions.find(dd=>dd.name===divName);
    const s = parseTime(d?.start), e = parseTime(d?.end);
    const rows = new Set();
    unifiedTimes.forEach((t,idx)=>{
      if (s && e && t.start >= s && t.start < e) rows.add(idx);
    });
    divisionActiveRows[divName] = rows;
  });

  if (typeof assignFieldsToBunks === "function") assignFieldsToBunks();
  if (typeof updateTable === "function") updateTable();
}

// -------------------- Init --------------------
window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("addTimeTemplateBtn")?.addEventListener("click", addTimeTemplate);

  document.getElementById("addFieldBtn")?.addEventListener("click", addFieldAdvanced);
  document.getElementById("fieldInput")?.addEventListener("keyup", e=>{ if(e.key==="Enter") addFieldAdvanced(); });

  document.getElementById("addSpecialBtn")?.addEventListener("click", addSpecial);
  document.getElementById("specialInput")?.addEventListener("keyup", e=>{ if(e.key==="Enter") addSpecial(); });

  // First paint so the sections aren't empty
  renderFieldsAdvanced(); renderSpecials(); renderLeagues(); renderTimeTemplates();
});

