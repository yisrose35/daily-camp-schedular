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

      const idx=bunks.indexOf(b);
      if(idx!==-1) bunks[idx]=newName;
      for(const d of Object.values(divisions)){
        const i=d.bunks.indexOf(b);
        if(i!==-1) d.bunks[i]=newName;
      }
      if(scheduleAssignments[b]){
        scheduleAssignments[newName]=scheduleAssignments[b];
        delete scheduleAssignments[b];
      }

      // ✅ Only refresh what’s needed (don’t wipe division colors)
      updateUnassigned();
      updateTable();
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

      // ✅ Preserve bunks & color reference
      divisions[newName] = divisions[name];
      delete divisions[name];

      // Preserve leagues data
      leagues[newName] = leagues[name];
      delete leagues[name];

      // Update division name in availableDivisions
      const idx = availableDivisions.indexOf(name);
      if (idx !== -1) availableDivisions[idx] = newName;

      // Update selectedDivision if needed
      if (selectedDivision === name) selectedDivision = newName;

      // ✅ Refresh but keep state
      setupDivisionButtons();
      renderLeagues();
      renderTimeTemplates();
      updateUnassigned();
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

// -------------------- Init --------------------
window.addEventListener("DOMContentLoaded", () => {
  updateUnassigned();
  setupDivisionButtons();
});
