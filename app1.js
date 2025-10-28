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

// NEW: Fixed Daily Activities (persisted)
let fixedDailyActivities = []; // [{ id, name, start:"HH:MM", end:"HH:MM", divisions:string[] }]

const defaultColors = ['#4CAF50','#2196F3','#E91E63','#FF9800','#9C27B0','#00BCD4','#FFC107','#F44336','#8BC34A','#3F51B5'];
let colorIndex = 0;
const commonActivities = ["Basketball","Baseball","Hockey","Football","Soccer","Volleyball","Lacrosse"];
const leagueSports = ["Basketball","Hockey","Volleyball","Soccer","Kickball","Punchball","Baseball"];

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

// NEW: "HH:MM" -> minutes helper for Daily Activities
function timeStrToMinutes(t) {
  if (!t) return 0;
  const [h, m] = t.split(":").map(Number);
  return (h * 60) + (m || 0);
}

// -------------------- Tabs --------------------
function showTab(id) {
  document.querySelectorAll('.tab-button').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  const tabBtn = document.querySelector(`.tab-button[onclick="showTab('${id}')"]`);
  if (tabBtn) tabBtn.classList.add('active');
  if (id === 'schedule') updateTable?.();
  if (id === 'leagues') renderLeagues();
  // NEW: ensure Daily Activities panel is wired when opened
  if (id === 'daily') hookFixedUI?.();
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
  updateTable?.();
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
        updateTable?.();
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
      updateTable?.();
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
    setupDivisionButtons(); renderLeagues(); updateTable?.();
    renderTimeTemplates();
    // NEW: let Daily Activities chips know divisions changed
    notifyDivisionsChanged();
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
      setupDivisionButtons(); renderLeagues(); renderTimeTemplates(); updateTable?.();
      // NEW: refresh chips after rename
      notifyDivisionsChanged();
    });
    wrap.appendChild(span);
    const col = document.createElement("input"); col.type = "color"; col.value = obj.color; col.className = "colorPicker";
    col.oninput = e => { obj.color = e.target.value; if (colorEnabled) { span.style.backgroundColor = e.target.value; span.style.color = "#fff"; } saveData(); updateTable?.(); renderTimeTemplates(); };
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

// -------------------- Fields / Specials / Leagues --------------------
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
    makeEditable(t, newName => { f.name = newName; saveData(); renderFields(); }); w.appendChild(t);
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
    makeEditable(t, newName => { s.name = newName; saveData(); renderSpecials(); }); w.appendChild(t);
    const tog = document.createElement("label"); tog.className = "switch";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = s.available;
    cb.onchange = () => { s.available = cb.checked; saveData(); renderSpecials(); };
    const sl = document.createElement("span"); sl.className = "slider";
    tog.appendChild(cb); tog.appendChild(sl); w.appendChild(tog);
    c.appendChild(w);
  });
}

function renderLeagues() {
  const container = document.getElementById("leaguesContainer");
  container.innerHTML = "";
  availableDivisions.forEach(divName => {
    if (!leagues[divName]) leagues[divName] = { enabled: false, sports: [] };
    const wrap = document.createElement("div"); wrap.className = "fieldWrapper";
    const title = document.createElement("span"); title.className = "fieldTitle"; title.textContent = divName;
    wrap.appendChild(title);
    const toggle = document.createElement("label"); toggle.className = "switch";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = leagues[divName].enabled;
    cb.onchange = () => { leagues[divName].enabled = cb.checked; saveData(); renderLeagues(); };
    const slider = document.createElement("span"); slider.className = "slider";
    toggle.appendChild(cb); toggle.appendChild(slider);
    wrap.appendChild(toggle);
    const btnWrap = document.createElement("div"); btnWrap.style.marginTop = "8px";
    leagueSports.forEach(sport => {
      const btn = document.createElement("button"); btn.textContent = sport; btn.className = "activity-button";
      if (leagues[divName].sports.includes(sport)) btn.classList.add("active");
      btn.onclick = () => {
        if (leagues[divName].sports.includes(sport)) leagues[divName].sports = leagues[divName].sports.filter(s => s !== sport);
        else leagues[divName].sports.push(sport);
        saveData(); renderLeagues();
      };
      btnWrap.appendChild(btn);
    });
    wrap.appendChild(btnWrap);
    const other = document.createElement("input"); other.placeholder = "Other sport";
    other.onkeyup = e => {
      if (e.key === "Enter" && other.value.trim()) {
        const val = e.target.value.trim();
        if (!leagues[divName].sports.includes(val)) leagues[divName].sports.push(val);
        e.target.value = ""; saveData(); renderLeagues();
      }
    };
    wrap.appendChild(other);
    if (leagues[divName].sports.length > 0) {
      const chosen = document.createElement("p"); chosen.style.marginTop = "6px";
      chosen.textContent = "Sports: " + leagues[divName].sports.join(", ");
      wrap.appendChild(chosen);
    }
    container.appendChild(wrap);
  });
}

// -------------------- Generate Times --------------------
function generateTimes() {
  const inc = parseInt(document.getElementById("increment").value, 10);
  applyTemplatesToDivisions();

  const starts = availableDivisions.map(d => parseTime(divisions[d].start)).filter(Boolean);
  const ends   = availableDivisions.map(d => parseTime(divisions[d].end)).filter(Boolean);
  if (starts.length === 0 || ends.length === 0) { alert("Please set time templates for divisions first."); return; }

  const earliest = new Date(Math.min(...starts.map(d => d.getTime())));
  const latest   = new Date(Math.max(...ends.map(d => d.getTime())));

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

  // handoff to scheduling (app2.js functions must be loaded)
  assignFieldsToBunks?.();
  initScheduleSystem?.();
  updateTable?.();
}

// -------------------- Daily Activities (Fixed) UI --------------------
// Build list of current divisions (from Setup)
function _currentDivisionList() {
  if (Array.isArray(availableDivisions) && availableDivisions.length) return [...availableDivisions];
  if (divisions && typeof divisions === "object") return Object.keys(divisions);
  return [];
}

// Render chips in Daily Activities tab
function renderFixedDivisionChips() {
  const wrap = document.getElementById("fixedDivisionChips");
  if (!wrap) return;
  wrap.innerHTML = "";

  const divs = _currentDivisionList();
  if (!divs.length) {
    wrap.innerHTML = `<span class="muted">No divisions yet — add some in Setup.</span>`;
    return;
  }

  divs.forEach(div => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.dataset.div = div;
    chip.textContent = div;
    chip.addEventListener("click", () => chip.classList.toggle("active"));
    wrap.appendChild(chip);
  });
}

// Read selected chips
function getSelectedFixedDivisions() {
  const wrap = document.getElementById("fixedDivisionChips");
  if (!wrap) return [];
  return Array.from(wrap.querySelectorAll(".chip.active")).map(el => el.dataset.div);
}

// Render the fixed activities list
function renderFixedList() {
  const list = document.getElementById("fixedList");
  if (!list) return;

  if (!fixedDailyActivities.length) {
    list.innerHTML = `<div class="muted">No fixed activities yet.</div>`;
    return;
  }

  list.innerHTML = "";
  fixedDailyActivities.forEach(fa => {
    const row = document.createElement("div");
    row.className = "list-item";
    row.innerHTML = `
      <div>
        <strong>${fa.name}</strong>
        <div class="muted">${fa.start}–${fa.end} • ${fa.divisions?.length ? fa.divisions.join(", ") : "All divisions"}</div>
      </div>
      <div>
        <button class="btn-link danger" data-id="${fa.id}">Remove</button>
      </div>
    `;
    list.appendChild(row);
  });

  // Remove handlers
  list.querySelectorAll(".btn-link.danger").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      fixedDailyActivities = fixedDailyActivities.filter(x => x.id !== id);
      saveData();
      renderFixedList();
    });
  });
}

// Add handler for the form
function addFixedActivityFromForm() {
  const name = (document.getElementById("fixedName")?.value || "").trim();
  const start = document.getElementById("fixedStart")?.value || "";
  const end   = document.getElementById("fixedEnd")?.value || "";
  const selDivs = getSelectedFixedDivisions();

  if (!name) return alert("Please enter a name.");
  if (!start || !end) return alert("Please choose start and end times.");
  if (timeStrToMinutes(end) <= timeStrToMinutes(start)) return alert("End must be after start.");

  fixedDailyActivities.push({
    id: "fa_" + Math.random().toString(36).slice(2),
    name, start, end,
    // empty array means "all divisions"
    divisions: selDivs
  });

  saveData();
  renderFixedList();

  // optional: clear inputs (chips remain)
  const n = document.getElementById("fixedName");
  const s = document.getElementById("fixedStart");
  const e = document.getElementById("fixedEnd");
  if (n) n.value = ""; if (s) s.value = ""; if (e) e.value = "";
}

// Expose a single hook to wire the panel (chips + list + button)
function hookFixedUI() {
  renderFixedDivisionChips();
  renderFixedList();
  const addBtn = document.getElementById("addFixedBtn");
  if (addBtn && !addBtn._wired) {
    addBtn.addEventListener("click", addFixedActivityFromForm);
    addBtn._wired = true; // prevent double-binding
  }
}
window.hookFixedUI = hookFixedUI; // ensure index can call it

// Keep Daily Activities chips in sync when Setup changes
function notifyDivisionsChanged() {
  // Keep availableDivisions up to date if needed
  const fresh = _currentDivisionList();
  if (JSON.stringify(availableDivisions) !== JSON.stringify(fresh)) {
    availableDivisions = fresh;
  }
  // If the Daily tab is visible, refresh chips immediately
  const dailyTab = document.getElementById("daily");
  if (dailyTab && dailyTab.classList.contains("active")) {
    renderFixedDivisionChips();
  }
}
window.notifyDivisionsChanged = notifyDivisionsChanged;

// -------------------- Local Storage --------------------
function saveData() {
  const data = { 
    bunks, divisions, availableDivisions, selectedDivision, 
    fields, specialActivities, leagues, timeTemplates,
    // NEW: persist fixed daily activities too
    fixedDailyActivities
  };
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
    // NEW: restore fixed daily activities
    fixedDailyActivities = Array.isArray(data.fixedDailyActivities) ? data.fixedDailyActivities : [];
  } catch (e) { console.error("Error loading data:", e); }
}

// -------------------- Erase All --------------------
document.getElementById("eraseAllBtn")?.addEventListener("click", () => {
  if (confirm("Erase all camp data?")) {
    localStorage.removeItem("campSchedulerData");
    bunks = []; divisions = {}; availableDivisions = []; selectedDivision = null;
    fields = []; specialActivities = []; leagues = {}; timeTemplates = [];
    unifiedTimes = []; divisionActiveRows = {}; scheduleAssignments = {};
    fixedDailyActivities = []; // NEW: clear fixed activities too
    updateUnassigned(); setupDivisionButtons(); renderFields(); renderSpecials(); renderLeagues(); renderTimeTemplates(); updateTable?.();
    renderFixedList(); renderFixedDivisionChips(); // NEW: refresh Daily Activities UI
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

  // If the page opens on the Daily tab, ensure the panel is wired
  if (document.getElementById('daily')?.classList.contains('active')) {
    hookFixedUI();
  }
});
