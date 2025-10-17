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
let colorIndex = 0;
const commonActivities = ["Basketball","Baseball","Hockey","Football","Soccer","Volleyball","Lacrosse"];
const leagueSports = ["Basketball","Hockey","Volleyball","Soccer","Kickball","Punchball","Baseball"];

document.getElementById("activityDuration").onchange = function() {
  activityDuration = parseInt(this.value);
};

// -------------------- Helpers --------------------
function makeEditable(el, save) {
  el.ondblclick = e => {
    e.stopPropagation();
    const old = el.textContent;
    const input = document.createElement("input");
    input.type = "text"; input.value = old;
    el.replaceWith(input); input.focus();
    function done() {
      const val = input.value.trim();
      if (val && val !== old) save(val);
      el.textContent = val || old; input.replaceWith(el);
    }
    input.onblur = done; input.onkeyup = e => { if (e.key === "Enter") done(); };
  };
}

function parseTime(str) {
  if (!str) return null;
  const m = str.match(/^(\d{1,2}):(\d{2})(\s*)?(AM|PM)$/i);
  if (!m) return null;
  let h = parseInt(m[1],10), min = parseInt(m[2],10), ap = m[4].toUpperCase();
  if (ap === "PM" && h !== 12) h += 12; if (ap === "AM" && h === 12) h = 0;
  return new Date(0,0,0,h,min);
}

function fmtTime(d) {
  let h = d.getHours(), m = d.getMinutes().toString().padStart(2,"0"), ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}

// -------------------- Tabs --------------------
function showTab(id) {
  document.querySelectorAll('.tab-button').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  document.querySelector(`.tab-button[onclick="showTab('${id}')"]`).classList.add('active');
  if (id === 'schedule') updateTable();
  if (id === 'leagues') renderLeagues();
}

// -------------------- Bunks --------------------
function addBunk() {
  const i = document.getElementById("bunkInput");
  const name = i.value.trim();
  if (!name) return;

  // Prevent duplicates (case-insensitive)
  const exists = bunks.some(b => b.toLowerCase() === name.toLowerCase());
  if (exists) {
    alert("That bunk already exists!");
    i.value = "";
    return;
  }

  bunks.push(name);
  saveData();
  i.value = "";
  updateUnassigned();
  updateTable();
}
document.getElementById("addBunkBtn").onclick = addBunk;
document.getElementById("bunkInput").addEventListener("keyup", e => { if (e.key === "Enter") addBunk(); });

function updateUnassigned() {
  const c = document.getElementById("unassignedBunks");
  c.innerHTML = "";
  bunks.forEach(b => {
    const span = document.createElement("span");
    span.textContent = b;
    span.className = "bunk-button";
    let assigned = null;
    for (const d in divisions) { if (divisions[d].bunks.includes(b)) assigned = d; }
    if (assigned) { span.style.backgroundColor = divisions[assigned].color; span.style.color = "#fff"; }
    span.onclick = () => {
      if (selectedDivision && (!assigned || assigned !== selectedDivision)) {
        for (const d in divisions) {
          const i = divisions[d].bunks.indexOf(b);
          if (i !== -1) divisions[d].bunks.splice(i, 1);
        }
        divisions[selectedDivision].bunks.push(b);
        saveData();
        updateUnassigned();
        updateTable();
      } else if (!selectedDivision) {
        alert("Select a division first!");
      }
    };
    makeEditable(span, newName => {
      if (!newName.trim()) return;
      const idx = bunks.indexOf(b);
      if (idx !== -1) bunks[idx] = newName;
      for (const d of Object.values(divisions)) {
        const i = d.bunks.indexOf(b);
        if (i !== -1) d.bunks[i] = newName;
      }
      if (scheduleAssignments[b]) {
        scheduleAssignments[newName] = scheduleAssignments[b];
        delete scheduleAssignments[b];
      }
      saveData();
      updateUnassigned();
      updateTable();
    });
    c.appendChild(span);
  });
}

// -------------------- Divisions --------------------
function addDivision() {
  const i = document.getElementById("divisionInput");
  if (i.value.trim() === "") return;
  const name = i.value.trim();
  if (!availableDivisions.includes(name)) {
    const color = defaultColors[colorIndex % defaultColors.length]; colorIndex++;
    availableDivisions.push(name);
    divisions[name] = { bunks: [], color, start: null, end: null };
    leagues[name] = { enabled: false, sports: [] };
    i.value = "";
    saveData();
    setupDivisionButtons(); renderLeagues(); updateTable();
    renderTimeTemplates();
  }
}
document.getElementById("addDivisionBtn").onclick = addDivision;
document.getElementById("divisionInput").addEventListener("keyup", e => { if (e.key === "Enter") addDivision(); });

function setupDivisionButtons() {
  const cont = document.getElementById("divisionButtons"); cont.innerHTML = "";
  const colorEnabled = document.getElementById("enableColor").checked;
  availableDivisions.forEach(name => {
    const obj = divisions[name];
    const wrap = document.createElement("div"); wrap.className = "divisionWrapper";
    const span = document.createElement("span"); span.textContent = name; span.className = "bunk-button";
    span.style.backgroundColor = colorEnabled ? obj.color : "transparent";
    span.style.color = colorEnabled ? "#fff" : "inherit";
    span.onclick = () => { selectedDivision = name; cont.querySelectorAll('span.bunk-button').forEach(el => el.classList.remove("selected")); span.classList.add("selected"); saveData(); };
    makeEditable(span, newName => {
      divisions[newName] = divisions[name]; delete divisions[name];
      leagues[newName] = leagues[name] || { enabled: false, sports: [] }; delete leagues[name];
      availableDivisions[availableDivisions.indexOf(name)] = newName;
      if (selectedDivision === name) selectedDivision = newName;
      saveData();
      setupDivisionButtons(); renderLeagues(); renderTimeTemplates(); updateTable();
    });
    wrap.appendChild(span);
    const col = document.createElement("input"); col.type = "color"; col.value = obj.color; col.className = "colorPicker";
    col.oninput = e => { obj.color = e.target.value; if (colorEnabled) { span.style.backgroundColor = e.target.value; span.style.color = "#fff"; } saveData(); updateTable(); renderTimeTemplates(); };
    wrap.appendChild(col);
    cont.appendChild(wrap);
  });
}
document.getElementById("enableColor").addEventListener("change", setupDivisionButtons);

// -------------------- Time Templates --------------------
function addTimeTemplate() {
  const start = document.getElementById("timeStartInput").value.trim();
  const end = document.getElementById("timeEndInput").value.trim();
  if (!start || !end) return;
  timeTemplates.push({ start, end, divisions: [] });
  document.getElementById("timeStartInput").value = "";
  document.getElementById("timeEndInput").value = "";
  saveData();
  renderTimeTemplates();
}

function renderTimeTemplates() {
  const cont = document.getElementById("timeTemplates"); cont.innerHTML = "";
  timeTemplates.forEach((tpl, idx) => {
    const wrap = document.createElement("div"); wrap.className = "fieldWrapper";
    const label = document.createElement("span"); label.textContent = `${tpl.start} - ${tpl.end}`;
    wrap.appendChild(label);
    availableDivisions.forEach(div => {
      const btn = document.createElement("button");
      btn.textContent = div; btn.className = "bunk-button";
      if (tpl.divisions.includes(div)) { btn.style.backgroundColor = divisions[div].color; btn.style.color = "#fff"; }
      else { btn.style.backgroundColor = "#fff"; btn.style.color = "#000"; }
      btn.onclick = () => {
        if (tpl.divisions.includes(div)) {
          tpl.divisions = tpl.divisions.filter(d => d !== div);
        } else {
          tpl.divisions.push(div);
        }
        saveData();
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
  availableDivisions.forEach(div => {
    let match = null;
    for (let i = timeTemplates.length - 1; i >= 0; i--) {
      if (timeTemplates[i].divisions.includes(div)) { match = timeTemplates[i]; break; }
    }
    if (match) { divisions[div].start = match.start; divisions[div].end = match.end; }
  });
}

// -------------------- Fields / Specials / Leagues --------------------
// Keep your existing renderFields(), renderSpecials(), renderLeagues() sections unchanged from before.

// -------------------- Generate Times --------------------
function generateTimes() {
  const inc = parseInt(document.getElementById("increment").value);
  applyTemplatesToDivisions();
  const starts = availableDivisions.map(d => parseTime(divisions[d].start)).filter(Boolean);
  const ends   = availableDivisions.map(d => parseTime(divisions[d].end)).filter(Boolean);
  if (starts.length===0 || ends.length===0) { alert("Please set time templates for divisions first."); return; }

  const earliest = new Date(Math.min(...starts.map(d=>d.getTime())));
  const latest   = new Date(Math.max(...ends.map(d=>d.getTime())));
  unifiedTimes = [];
  let cur = new Date(earliest);
  while (cur < latest) {
    let nxt = new Date(cur.getTime() + inc*60000);
    if (nxt > latest) nxt = latest;
    unifiedTimes.push({ start:new Date(cur), end:new Date(nxt), label:`${fmtTime(cur)} - ${fmtTime(nxt)}` });
    cur = nxt;
  }
  divisionActiveRows = {};
  availableDivisions.forEach(div => {
    const s = parseTime(divisions[div].start), e = parseTime(divisions[div].end);
    const rows = new Set();
    unifiedTimes.forEach((t,idx) => {
      if (s && e && t.start >= s && t.start < e) rows.add(idx);
    });
    divisionActiveRows[div] = rows;
  });

  assignFieldsToBunks(); // from app2.js
  initScheduleSystem();  // initialize scheduling once
  updateTable();
}

// -------------------- Local Storage --------------------
function saveData() {
  const data = { bunks, divisions, availableDivisions, selectedDivision, fields, specialActivities, leagues, timeTemplates };
  localStorage.setItem("campSchedulerData", JSON.stringify(data));
}

function loadData() {
  const stored = localStorage.getItem("campSchedulerData");
  if (!stored) return;
  try {
    const data = JSON.parse(stored);
    bunks = data.bunks || [];
    divisions = data.divisions || {};
    availableDivisions = data.availableDivisions || [];
    selectedDivision = data.selectedDivision || null;
    fields = data.fields || [];
    specialActivities = data.specialActivities || [];
    leagues = data.leagues || {};
    timeTemplates = data.timeTemplates || [];
  } catch (e) { console.error("Error loading data:", e); }
}

document.getElementById("eraseAllBtn")?.addEventListener("click", () => {
  if (confirm("Erase all camp data?")) {
    localStorage.removeItem("campSchedulerData");
    bunks = []; divisions = {}; availableDivisions = []; selectedDivision = null;
    fields = []; specialActivities = []; leagues = {}; timeTemplates = [];
    updateUnassigned(); setupDivisionButtons(); renderFields(); renderSpecials(); renderLeagues(); renderTimeTemplates(); updateTable();
  }
});

// -------------------- Init --------------------
window.addEventListener("DOMContentLoaded", () => {
  loadData();
  updateUnassigned();
  setupDivisionButtons();
  renderFields();
  renderSpecials();
  renderLeagues();
  renderTimeTemplates();
});
