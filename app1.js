// -------------------- State --------------------
let bunks = [];
let divisions = {};  // { divName:{ bunks:[], color, start, end } }
let availableDivisions = [];
let selectedDivision = null;

let fields = [], specialActivities = [];
let leagues = {};    // { divName:{enabled:boolean, sports:string[]} }

let timeTemplates = []; // [{start,end,divisions:[]}]
let activityDuration = 30;
let scheduleAssignments = {}; // { bunkName: [ per unified row index: {...} ] }
let unifiedTimes = []; // [{start:Date,end:Date,label:string}]
let divisionActiveRows = {}; // { divName: Set(rowIndices) }

const defaultColors = ['#4CAF50','#2196F3','#E91E63','#FF9800','#9C27B0','#00BCD4','#FFC107','#F44336','#8BC34A','#3F51B5'];
let colorIndex=0;
const commonActivities=["Basketball","Baseball","Hockey","Football","Soccer","Volleyball","Lacrosse"];
const leagueSports=["Basketball","Hockey","Volleyball","Soccer","Kickball","Punchball","Baseball"];

document.getElementById("activityDuration").onchange=function(){activityDuration=parseInt(this.value);};

// -------------------- Helpers --------------------
function makeEditable(el, save) {
  el.ondblclick = e => {
    e.stopPropagation();
    const old = el.textContent;
    const input = document.createElement("input");
    input.type = "text";
    input.value = old;
    input.style.minWidth = "80px";
    el.replaceWith(input);
    input.focus();
    input.select();

    function done(commit = true) {
      const val = input.value.trim();
      if (commit && val && val !== old) {
        save(val);
        el.textContent = val;
      } else {
        el.textContent = old; // revert if nothing entered
      }
      input.replaceWith(el);
    }

    input.addEventListener("blur", () => done(true));
    input.addEventListener("keyup", e => {
      if (e.key === "Enter") done(true);
      if (e.key === "Escape") done(false);
    });
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
  const c=document.getElementById("unassignedBunks");
  c.innerHTML="";

  bunks.forEach(b=>{
    const span=document.createElement("span");
    span.textContent=b;
    span.className="bunk-button";

    // Check if assigned for color only
    let assignedDivision=null;
    for(const d in divisions){ 
      if(divisions[d].bunks.includes(b)) assignedDivision=d; 
    }
    if(assignedDivision){
      span.style.backgroundColor=divisions[assignedDivision].color;
      span.style.color="#fff";
    }

    // Single click → assign to selected division
    span.addEventListener("click", e => {
      if (e.detail === 1) {  // only on single click
        if(selectedDivision && (!assignedDivision || assignedDivision!==selectedDivision)){
          // remove from any previous division
          for(const d in divisions){
            const i=divisions[d].bunks.indexOf(b);
            if(i!==-1) divisions[d].bunks.splice(i,1);
          }
          // add to new division
          divisions[selectedDivision].bunks.push(b);
          updateUnassigned();
          updateTable();
        } else if(!selectedDivision){
          alert("Select a division first!");
        }
      }
    });

    // Double click → edit name (always allowed, even unassigned)
    makeEditable(span,newName=>{
      const idx=bunks.indexOf(b);
      if(idx!==-1) bunks[idx]=newName;

      // Update inside divisions
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
      updateTable();
    });

    c.appendChild(span);
  });
}
