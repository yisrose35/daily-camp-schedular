// -------------------- State --------------------
var bunks = [];
var divisions = {}; // { divName:{ bunks:[], color, start, end } }
// availableDivisions will be exposed globally as window.availableDivisions
var availableDivisions = [];
var selectedDivision = null;
 
var fields = [], specialActivities = [];
 
var timeTemplates = []; // [{start,end,divisions:[]}]
var activityDuration = 30;
// NOTE: Scheduling state (scheduleAssignments, unifiedTimes, divisionActiveRows) 
// is now primarily managed by app2.js, but these arrays are
// retained for utility functions.
var unifiedTimes = []; // [{start:Date,end:Date,label:string}]
var divisionActiveRows = {}; // { divName: Set(rowIndices) }
 
 
const defaultColors = ['#4CAF50','#2196F3','#E91E63','#FF9800','#9C27B0','#00BCD4','#FFC107','#F44336','#8BC34A','#3F51B5'];
let colorIndex = 0;
const commonActivities = ["Basketball","Baseball","Hockey","Football","Soccer","Volleyball","Lacrosse"];
 
// Expose internal variable to the window for use by other modules (league.js, daily_activities.js)
window.divisions = divisions;
window.availableDivisions = availableDivisions;
window.fields = fields;
window.specialActivities = specialActivities;
window.timeTemplates = timeTemplates;
 
 
// keep in sync with <select id="activityDuration">
document.getElementById("activityDuration").onchange = function() {
  activityDuration = parseInt(this.value, 10);
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
// This function is now defined in index.html in the <script> tag
// window.showTab = showTab; 
 
 
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
 window.updateTable?.();
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
       window.updateTable?.();
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
      
      if (window.scheduleAssignments && window.scheduleAssignments[b]) {
       window.scheduleAssignments[newName] = window.scheduleAssignments[b];
        delete window.scheduleAssignments[b];
        window.saveCurrentDailyData?.("scheduleAssignments", window.scheduleAssignments);
      }
      saveData();
     updateUnassigned();
     window.updateTable?.();
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
    window.availableDivisions = availableDivisions; // Update global
 
    divisions[name] = { bunks: [], color, start: null, end: null };
    
    i.value = "";
    saveData();
   setupDivisionButtons(); 
   window.initLeaguesTab?.(); // Notify league.js
   window.DailyActivities?.onDivisionsChanged?.(); // Notify fixed activities
   window.updateTable?.();
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
    span.onclick = () => { 
        selectedDivision = name; 
        cont.querySelectorAll('span.bunk-button').forEach(el => el.classList.remove("selected"));
        span.classList.add("selected"); 
        saveData(); // Save selectedDivision
    };
    // Re-select if it was selected
    if (selectedDivision === name) span.classList.add("selected");
    
    makeEditable(span, newName => {
     divisions[newName] = divisions[name]; delete divisions[name];
      availableDivisions[availableDivisions.indexOf(name)] = newName;
      window.availableDivisions = availableDivisions; // Update global
      
      if (selectedDivision === name) selectedDivision = newName;
      
      saveData();
     setupDivisionButtons(); 
     window.initLeaguesTab?.(); 
     window.DailyActivities?.onDivisionsChanged?.(); 
     renderTimeTemplates(); 
     window.updateTable?.();
    });
   wrap.appendChild(span);
    const col = document.createElement("input"); col.type = "color";
    col.value = obj.color; col.className = "colorPicker";
    col.oninput = e => { 
      obj.color = e.target.value; 
      if (colorEnabled) { span.style.backgroundColor = e.target.value; span.style.color = "#fff"; } 
      saveData(); 
     window.updateTable?.(); 
     renderTimeTemplates(); 
     window.DailyActivities?.onDivisionsChanged?.(); 
    };
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
  timeTemplates.forEach((tpl) => {
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
 
// -------------------- Fields / Specials --------------------
function addField() {
  const i = document.getElementById("fieldInput");
  const n = i.value.trim();
  if (n) {
    fields.push({ name: n, activities: [], available: true });
    i.value = "";
    saveData();
    renderFields();
  }
}
document.getElementById("addFieldBtn").onclick = addField;
document.getElementById("fieldInput").addEventListener("keyup", e => { if (e.key === "Enter") addField(); });
 
function renderFields() {
  const c = document.getElementById("fieldList"); c.innerHTML = "";
  fields.forEach(f => {
    const w = document.createElement("div"); w.className = "fieldWrapper"; if (!f.available) w.classList.add("unavailable");
    const t = document.createElement("span"); t.className = "fieldTitle"; t.textContent = f.name;
    makeEditable(t, newName => { f.name = newName; saveData(); renderFields(); });
    w.appendChild(t);
    const tog = document.createElement("label"); tog.className = "switch";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = f.available;
    cb.onchange = () => { f.available = cb.checked; saveData(); renderFields(); };
    const sl = document.createElement("span"); sl.className = "slider";
    tog.appendChild(cb); tog.appendChild(sl); w.appendChild(tog);
    const bw = document.createElement("div"); bw.style.marginTop = "8px";
    commonActivities.forEach(act => {
      const b = document.createElement("button"); b.textContent = act; b.className = "activity-button";
      if (f.activities.includes(act)) b.classList.add("active");
      b.onclick = () => { 
        if (f.activities.includes(act)) f.activities = f.activities.filter(a => a !== act); 
        else f.activities.push(act); 
        saveData(); renderFields(); 
      };
      bw.appendChild(b);
    });
    w.appendChild(bw);
    const other = document.createElement("input"); other.placeholder = "Other activity";
    other.onkeyup = e => {
      if (e.key === "Enter" && other.value.trim()) {
        const v = other.value.trim(); 
        if (!f.activities.includes(v)) f.activities.push(v);
        other.value = ""; saveData(); renderFields();
      }
    };
    w.appendChild(other);
    if (f.activities.length > 0) {
      const p = document.createElement("p"); p.style.marginTop = "6px"; p.textContent = "Activities: " + f.activities.join(", ");
      w.appendChild(p);
    }
    c.appendChild(w);
  });
}
 
function addSpecial() {
  const i = document.getElementById("specialInput");
  const n = i.value.trim();
  if (n) {
    specialActivities.push({ name: n, available: true });
    i.value = "";
    saveData();
    renderSpecials();
  }
}
document.getElementById("addSpecialBtn").onclick = addSpecial;
document.getElementById("specialInput").addEventListener("keyup", e => { if (e.key === "Enter") addSpecial(); });
 
function renderSpecials() {
  const c = document.getElementById("specialList"); c.innerHTML = "";
  specialActivities.forEach(s => {
    const w = document.createElement("div"); w.className = "fieldWrapper"; if (!s.available) w.classList.add("unavailable");
    const t = document.createElement("span"); t.className = "fieldTitle"; t.textContent = s.name;
    makeEditable(t, newName => { s.name = newName; saveData(); renderSpecials(); });
    w.appendChild(t);
    const tog = document.createElement("label"); tog.className = "switch";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = s.available;
    cb.onchange = () => { s.available = cb.checked; saveData(); renderSpecials(); };
    const sl = document.createElement("span"); sl.className = "slider";
    tog.appendChild(cb); tog.appendChild(sl); w.appendChild(tog);
    c.appendChild(w);
  });
}
 
// -------------------- Generate Times --------------------
function generateTimes() {
  const inc = parseInt(document.getElementById("increment").value, 10);
  applyTemplatesToDivisions();
 
  const starts = availableDivisions.map(d => parseTime(divisions[d].start)).filter(Boolean);
  const ends   = availableDivisions.map(d => parseTime(divisions[d].end)).filter(Boolean);
  if (starts.length === 0 || ends.length === 0) { alert("Please set time templates for divisions first."); return; }
 
  const earliest = new Date(Math.min(...starts.map(d => d.getTime())));
  const latest   = new Date(Math.max(...ends.map(d => d.getTime())));
 
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
    unifiedTimes.forEach((t, idx) => {
      if (s && e && t.start >= s && t.start < e) rows.add(idx);
    });
    divisionActiveRows[div] = rows;
  });
  
  // Expose the schedule times globally for app2.js
  window.unifiedTimes = unifiedTimes;
  window.divisionActiveRows = divisionActiveRows;
 
  // handoff to scheduling
  window.assignFieldsToBunks?.();
}
 
// -------------------- Local Storage (UPDATED) --------------------
function saveData() {
// This now saves to the *Global Settings* object
  const data = { bunks, divisions, availableDivisions, selectedDivision, fields, specialActivities, timeTemplates };
  // Use the new save function from calendar.js
  window.saveGlobalSettings?.("app1", data);
}
 
function loadData() {
  // This now loads from the *Global Settings* object
  // It relies on calendar.js's migration logic to pull in old data once
  const data = window.loadGlobalSettings?.().app1 || {};
  
  try {
    bunks = data.bunks || [];
    divisions = data.divisions || {};
    
    // Ensure availableDivisions is derived from divisions data
    availableDivisions = Object.keys(divisions);
    window.availableDivisions = availableDivisions;
    // Load saved order if it exists
    if (data.availableDivisions) availableDivisions = data.availableDivisions; 

    selectedDivision = data.selectedDivision || null;
    fields = data.fields || [];
    specialActivities = data.specialActivities || [];
    timeTemplates = data.timeTemplates || [];
  } catch (e) { console.error("Error loading data:", e); }
}
 
// "eraseAllBtn" is now handled by calendar.js
 
// -------------------- Init --------------------
window.addEventListener("DOMContentLoaded", () => {
  // calendar.js must run its load/migration *first*
  // This loadData() will now pull from the populated global settings
  loadData();
  updateUnassigned();
  setupDivisionButtons();
  renderFields();
  renderSpecials();
  renderTimeTemplates();
  
  // NEW: Add listener for the erase day button
  const eraseBtn = document.getElementById("eraseDayBtn");
  if (eraseBtn) {
    eraseBtn.onclick = () => {
      if (confirm("Are you sure you want to erase all schedule data for " + window.currentScheduleDate + "?\n\nThis cannot be undone.")) {
        window.eraseCurrentDailyData?.();
      }
    };
  }
  
  // NEW: Add listener for the erase ALL schedules button
  const eraseAllSchedulesBtn = document.getElementById("eraseAllSchedulesBtn");
  if (eraseAllSchedulesBtn) {
    eraseAllSchedulesBtn.onclick = () => {
        if (confirm("Are you sure you want to delete ALL schedules for ALL days?\n\nThis will NOT delete your bunks, fields, or league settings.")) {
            window.eraseAllDailyData?.();
        }
    };
  }
});
 
// Expose internal objects for other modules to use (Data Source for the whole app)
window.getDivisions = () => divisions; 
window.getFields = () => fields;
window.getSpecials = () => specialActivities;
