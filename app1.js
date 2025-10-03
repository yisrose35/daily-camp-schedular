// -------------------- State --------------------
let bunks = [];
let availableDivisions = [];
let divisions = {};
let fields = [];
let specialActivities = [];
let leagues = {};
let timeTemplates = [];
let unifiedTimes = [];
let divisionActiveRows = {};
let scheduleAssignments = {};

let selectedDivision = null;
let colorIndex = 0;
const defaultColors = [
  "#007BFF","#28A745","#DC3545","#FFC107","#17A2B8",
  "#6F42C1","#FD7E14","#20C997","#6610F2","#E83E8C"
];

const commonActivities = [
  "Basketball","Baseball","Hockey","Football","Soccer","Volleyball","Lacrosse"
];

const leagueSports = [
  "Basketball","Hockey","Volleyball","Soccer","Kickball","Punchball","Baseball"
];

let activityDuration = 30; // default minutes per activity

// -------------------- Helpers --------------------
function parseTime(str){
  if(!str) return null;
  const m = str.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if(!m) return null;
  let h = parseInt(m[1]), min = parseInt(m[2]), ap = m[3].toLowerCase();
  if(ap==="pm" && h<12) h+=12;
  if(ap==="am" && h===12) h=0;
  const d = new Date(); d.setHours(h,min,0,0);
  return d;
}

function fmtTime(d){
  let h=d.getHours(), m=d.getMinutes();
  let ap="AM";
  if(h>=12){ap="PM"; if(h>12) h-=12;}
  if(h===0) h=12;
  return `${h}:${m.toString().padStart(2,"0")}${ap.toLowerCase()}`;
}

// -------------------- Editable Text --------------------
function makeEditable(el, callback){
  el.ondblclick = ()=>{
    const old = el.textContent;
    const input = document.createElement("input");
    input.type = "text"; input.value = old;
    input.style.minWidth = "60px";
    el.replaceWith(input);
    input.focus();

    input.onblur = ()=>{
      const val = input.value.trim();
      if(val && val !== old){
        callback(val);
      }
      input.replaceWith(el);
      el.textContent = val || old;
    };

    input.onkeyup = e=>{
      if(e.key==="Enter"){ input.blur(); }
      if(e.key==="Escape"){ input.value=old; input.blur(); }
    };
  };
}

// -------------------- Tabs --------------------
document.querySelectorAll(".tab-button").forEach(btn=>{
  btn.addEventListener("click",()=>{
    document.querySelectorAll(".tab-button").forEach(b=>b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c=>c.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
  });
});

// -------------------- Bunks --------------------
function addBunk(){
  const i=document.getElementById("bunkInput");
  const n=i.value.trim();
  if(!n) return;
  if(!bunks.includes(n)){
    bunks.push(n);
    renderBunks();
  }
  i.value="";
}
document.getElementById("addBunkBtn").onclick=addBunk;
document.getElementById("bunkInput").addEventListener("keyup",e=>{if(e.key==="Enter")addBunk();});

function renderBunks(){
  const cont=document.getElementById("bunkList"); 
  cont.innerHTML="";

  bunks.forEach(b=>{
    const wrap=document.createElement("div"); 
    wrap.className="bunkWrapper";

    const span=document.createElement("span"); 
    span.textContent=b; 
    span.className="bunk-button";

    // Make editable
    makeEditable(span,newName=>{
      const idx=bunks.indexOf(b);
      if(idx!==-1) bunks[idx]=newName;

      for(const div of Object.values(divisions)){
        const j=div.bunks.indexOf(b);
        if(j!==-1) div.bunks[j]=newName;
      }

      renderBunks();
      updateTable();
    });

    wrap.appendChild(span);

    // Assign to division buttons
    availableDivisions.forEach(div=>{
      const btn=document.createElement("button"); 
      btn.textContent=div; 
      btn.className="bunk-button";

      if(divisions[div].bunks.includes(b)){
        btn.style.backgroundColor=divisions[div].color; 
        btn.style.color="#fff";
      }

      btn.onclick=()=>{
        if(!divisions[div].bunks.includes(b)){
          divisions[div].bunks.push(b);
        } else {
          divisions[div].bunks = divisions[div].bunks.filter(x=>x!==b);
        }
        renderBunks(); 
        updateTable();
      };

      wrap.appendChild(btn);
    });

    cont.appendChild(wrap);
  });
}
