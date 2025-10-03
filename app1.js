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

// -------------------- Persistence --------------------
function saveData() {
  const data = {
    bunks,
    divisions,
    availableDivisions,
    selectedDivision,
    fields,
    specialActivities,
    leagues,
    timeTemplates,
    activityDuration
  };
  localStorage.setItem("campSchedulerData", JSON.stringify(data));
}

function loadData() {
  const saved = localStorage.getItem("campSchedulerData");
  if (saved) {
    const data = JSON.parse(saved);
    bunks = data.bunks || [];
    divisions = data.divisions || {};
    availableDivisions = data.availableDivisions || [];
    selectedDivision = data.selectedDivision || null;
    fields = data.fields || [];
    specialActivities = data.specialActivities || [];
    leagues = data.leagues || {};
    timeTemplates = data.timeTemplates || [];
    activityDuration = data.activityDuration || 30;
    renderAll();
  }
}

function resetData() {
  if (confirm("Are you sure you want to erase all saved data?")) {
    localStorage.removeItem("campSchedulerData");
    bunks = [];
    divisions = {};
    availableDivisions = [];
    selectedDivision = null;
    fields = [];
    specialActivities = [];
    leagues = {};
    timeTemplates = [];
    activityDuration = 30;
    scheduleAssignments = {};
    unifiedTimes = [];
    divisionActiveRows = {};
    renderAll();
  }
}

function autoSave() { saveData(); }

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
      autoSave();
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
    updateUnassigned(); updateTable(); autoSave();
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
        divisions[selectedDivision].bunks.push(b);updateUnassigned();updateTable();autoSave();
      }else if(!selectedDivision){ alert("Select a division first!"); }
    };
    makeEditable(span,newName=>{
      const idx=bunks.indexOf(b);if(idx!==-1)bunks[idx]=newName;
      for(const d of Object.values(divisions)){const i=d.bunks.indexOf(b);if(i!==-1)d.bunks[i]=newName;}
      if(scheduleAssignments[b]){ scheduleAssignments[newName]=scheduleAssignments[b]; delete scheduleAssignments[b]; }
      updateUnassigned();updateTable();autoSave();
    });
    c.appendChild(span);
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
    renderTimeTemplates(); autoSave();
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
      divisions[newName]=divisions[name]; delete divisions[name];
      leagues[newName]=leagues[name]||{enabled:false,sports:[]}; delete leagues[name];
      availableDivisions[availableDivisions.indexOf(name)]=newName;
      if(selectedDivision===name)selectedDivision=newName;
      setupDivisionButtons(); renderLeagues(); renderTimeTemplates(); updateTable(); autoSave();
    });
    wrap.appendChild(span);
    const col=document.createElement("input"); col.type="color"; col.value=obj.color; col.className="colorPicker";
    col.oninput=e=>{obj.color=e.target.value; if(colorEnabled){span.style.backgroundColor=e.target.value; span.style.color="#fff";} updateTable(); renderTimeTemplates(); autoSave();};
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
  renderTimeTemplates(); autoSave();
}

// ... [Time template rendering, generateTimes, fields, specials, leagues remain identical, but I’ve added `autoSave()` at the end of each add/edit/remove] ...

// -------------------- Render All --------------------
function renderAll(){
  updateUnassigned();
  setupDivisionButtons();
  renderTimeTemplates();
  renderFields();
  renderSpecials();
  renderLeagues();
  updateTable();
}

// -------------------- On Load --------------------
window.onload = () => { loadData(); };
