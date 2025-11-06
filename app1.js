// -------------------- State --------------------
let bunks = [];
let divisions = {}; // { divName:{ bunks:[], color, start, end } }
// availableDivisions will be exposed globally as window.availableDivisions
let availableDivisions = [];
let selectedDivision = null;

let fields = [], specialActivities = [];

let timeTemplates = []; // [{start,end,divisions:[]}]
let activityDuration = 30;
// NOTE: Scheduling state (scheduleAssignments, unifiedTimes, divisionActiveRows) 
// is now primarily managed by app2.js, but these arrays are
// retained for utility functions.
let unifiedTimes = []; // [{start:Date,end:Date,label:string}]
let divisionActiveRows = {}; // { divName: Set(rowIndices) }


const defaultColors = ['#4CAF50','#2196F3','#E91E63','#FF9800','#9C27B0','#00BCD4','#FFC107','#F44336','#8BC34A','#3F51B5'];
let colorIndex = 0;
const commonActivities = ["Basketball","Baseball","Hockey","Football","Soccer","Volleyball","Lacrosse"];

// Expose internal variable to the window for use by other modules (league.js, daily_activities.js)
window.divisions = divisions;
window.availableDivisions = availableDivisions;
window.fields = fields;
window.specialActivities = specialActivities;
window.timeTemplates = timeTemplates;


// =============================================
// ===== THIS CODE BLOCK WAS MOVED (see line 429) =====
// =============================================
// document.getElementById("activityDuration").onchange = function() {
//   activityDuration = parseInt(this.value, 10);
// };

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

// -------------------- NEW/UPDATED HELPER FUNCTIONS --------------------

/**
 * This is a copy of the helper from scheduler_logic_core.js
 * It's needed here for validation.
 */
function parseTimeToMinutes(str) {
  if (!str || typeof str !== "string") return null;
  let s = str.trim().toLowerCase();
  let mer = null;
  if (s.endsWith("am") || s.endsWith("pm")) {
    mer = s.endsWith("am") ? "am" : "pm";
    s = s.replace(/am|pm/g, "").trim();
  }
  const m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (Number.isNaN(hh) || Number.isNaN(mm) || mm < 0 || mm > 59) return null;
  if (mer) {
    if (hh === 12) hh = mer === "am" ? 0 : 12; // 12am -> 0, 12pm -> 12
    else if (mer === "pm") hh += 12; // 1pm -> 13
  }
  return hh * 60 + mm;
}

/**
 * Renders the "Available / Unavailable" time-based controls
 */
function renderAvailabilityControls(item, onSave, onRerender) {
  const container = document.createElement("div");
  container.style.marginTop = "10px";
  container.style.paddingLeft = "15px";
  container.style.borderLeft = "3px solid #eee";

  // --- 1. Mode Toggle (Available / Unavailable) ---
  const modeLabel = document.createElement("label");
  modeLabel.style.display = "flex";
  modeLabel.style.alignItems = "center";
  modeLabel.style.gap = "10px";
  modeLabel.style.cursor = "pointer";
  
  const textAvailable = document.createElement("span");
  textAvailable.textContent = "Available";
  
  const toggleTrack = document.createElement("span");
  Object.assign(toggleTrack.style, {
    width: "44px",
    height: "24px",
    borderRadius: "99px",
    position: "relative",
    display: "inline-block",
    border: "1px solid #ccc",
    backgroundColor: item.availabilityMode === 'available' ? '#22c55e' : '#d1d5db', // green or grey
    transition: "background-color 0.2s"
  });

  const toggleKnob = document.createElement("span");
  Object.assign(toggleKnob.style, {
    width: "20px",
    height: "20px",
    borderRadius: "50%",
    backgroundColor: "white",
    position: "absolute",
    top: "1px",
    left: item.availabilityMode === 'available' ? '21px' : '1px', // right or left
    transition: "left 0.2s"
  });
  
  toggleTrack.appendChild(toggleKnob);
  
  const textUnavailable = document.createElement("span");
  textUnavailable.textContent = "Unavailable";
  
  // Set initial text style
  textAvailable.style.fontWeight = item.availabilityMode === 'available' ? 'bold' : 'normal';
  textUnavailable.style.fontWeight = item.availabilityMode === 'unavailable' ? 'bold' : 'normal';

  // Use onclick on the label to toggle state
  modeLabel.onclick = () => {
    item.availabilityMode = (item.availabilityMode === 'available') ? 'unavailable' : 'available';
    
    // Update styles
    toggleTrack.style.backgroundColor = item.availabilityMode === 'available' ? '#22c55e' : '#d1d5db';
    toggleKnob.style.left = item.availabilityMode === 'available' ? '21px' : '1px';
    textAvailable.style.fontWeight = item.availabilityMode === 'available' ? 'bold' : 'normal';
    textUnavailable.style.fontWeight = item.availabilityMode === 'unavailable' ? 'bold' : 'normal';
    
    onSave();
  };

  modeLabel.appendChild(textAvailable);
  modeLabel.appendChild(toggleTrack);
  modeLabel.appendChild(textUnavailable);
  container.appendChild(modeLabel);


  // --- 2. "Except for..." Text ---
  const exceptLabel = document.createElement("span");
  exceptLabel.textContent = " except for:";
  exceptLabel.style.fontWeight = "500";
  container.appendChild(exceptLabel);

  // --- 3. Exception Time List ---
  const exceptionList = document.createElement("div");
  exceptionList.style.display = "flex";
  exceptionList.style.flexWrap = "wrap";
  exceptionList.style.gap = "6px";
  exceptionList.style.marginTop = "6px";

  item.availabilityExceptions = item.availabilityExceptions || [];
  item.availabilityExceptions.forEach((timeStr, index) => {
    const pill = document.createElement("span");
    pill.textContent = `${timeStr} ✖`;
    pill.style.background = "#ddd";
    pill.style.padding = "4px 8px";
    pill.style.borderRadius = "12px";
    pill.style.cursor = "pointer";
    pill.onclick = () => {
      item.availabilityExceptions.splice(index, 1);
      onSave();
      onRerender(); // Re-render to reflect change
    };
    exceptionList.appendChild(pill);
  });
  container.appendChild(exceptionList);

  // --- 4. Add New Exception Input ---
  const addContainer = document.createElement("div");
  addContainer.style.marginTop = "6px";
  const timeInput = document.createElement("input");
  timeInput.placeholder = "e.g., 9:00am-10:30am";
  timeInput.style.marginRight = "5px";

  const addBtn = document.createElement("button");
  addBtn.textContent = "Add Time";
  
  addBtn.onclick = () => {
    const val = timeInput.value.trim();
    const parts = val.split('-');
    if (parts.length === 2) {
      const startMin = parseTimeToMinutes(parts[0]);
      const endMin = parseTimeToMinutes(parts[1]);
      
      if (startMin != null && endMin != null && endMin > startMin) {
        // Valid! Push the original, user-formatted string
        item.availabilityExceptions.push(val);
        timeInput.value = "";
        onSave();
        onRerender(); // Re-render to reflect change
      } else {
        // Invalid time or range
        alert("Invalid time range. Use format '9:00am-10:30am'. Ensure end time is after start time.");
      }
    } else {
      // Invalid format
      alert("Invalid format. Must be a range separated by a hyphen (e.g., '9:00am-10:30am').");
    }
  };
  timeInput.onkeypress = (e) => { if (e.key === "Enter") addBtn.click(); };
  
  addContainer.appendChild(timeInput);
  addContainer.appendChild(addBtn);
  container.appendChild(addContainer);

  return container;
}

/**
 * NEW: Renders the advanced "Sharable With" controls
 */
function renderSharableControls(item, onSave, onRerender) {
  const container = document.createElement("div");
  container.style.marginTop = "10px";
  
  const rules = item.sharableWith || { type: 'not_sharable' };
  const isSharable = rules.type !== 'not_sharable';

  // --- 1. Master "Sharable" Toggle ---
  const tog = document.createElement("label"); 
  tog.className = "switch";
  tog.title = "Toggle Sharable";
  const cb = document.createElement("input"); 
  cb.type = "checkbox"; 
  cb.checked = isSharable;
  cb.onchange = () => {
    if (cb.checked) {
      rules.type = 'all'; // Default to 'all' when turned on
    } else {
      rules.type = 'not_sharable';
    }
    rules.divisions = []; // Clear custom rules
    rules.bunks = [];     // Clear custom rules
    onSave();
    onRerender();
  };
  const sl = document.createElement("span"); sl.className = "slider";
  tog.appendChild(cb); 
  tog.appendChild(sl); 
  const togLabel = document.createElement("span"); 
  togLabel.textContent = "Sharable";
  const shareWrap = document.createElement("label"); 
  shareWrap.style.display="flex"; 
  shareWrap.style.alignItems="center"; 
  shareWrap.style.gap="5px"; 
  shareWrap.style.cursor="pointer";
  shareWrap.appendChild(tog); 
  shareWrap.appendChild(togLabel);
  container.appendChild(shareWrap);

  // --- 2. Custom Panel (if "Sharable" is ON) ---
  if (isSharable) {
    const customPanel = document.createElement("div");
    customPanel.style.paddingLeft = "20px";
    customPanel.style.marginTop = "10px";
    
    // --- Division Picker ---
    const divLabel = document.createElement("div");
    divLabel.textContent = "Limit to Divisions (if none selected, sharable with all):";
    customPanel.appendChild(divLabel);
    
    const onDivToggle = () => {
      // Logic: If divisions are selected, it's custom. If not, it's 'all'.
      if (rules.divisions.length > 0) {
        rules.type = 'custom';
      } else {
        rules.type = 'all';
      }
      rules.bunks = []; // Any division change resets the bunk selection
      onSave();
      onRerender(); // Re-render to show/hide the bunks panel
    };
    
    const divChipBox = createChipPicker(window.availableDivisions || [], rules.divisions, onDivToggle);
    customPanel.appendChild(divChipBox);
    
    // --- Bunk Picker (if divisions are selected) ---
    if (rules.type === 'custom' && rules.divisions.length > 0) {
      const bunkLabel = document.createElement("div");
      bunkLabel.textContent = "Limit to Bunks (overrides division selection):";
      bunkLabel.style.marginTop = "10px";
      customPanel.appendChild(bunkLabel);
      
      // Get bunks *only* from selected divisions
      const bunksFromSelectedDivs = [];
      rules.divisions.forEach(divName => {
        (window.divisions[divName]?.bunks || []).forEach(bunk => {
          bunksFromSelectedDivs.push(bunk);
        });
      });
      
      const onBunkToggle = () => {
        // Logic: Bunk selection is always 'custom'.
        // The scheduler will see 'bunks' has items and will ignore 'divisions'.
        rules.type = 'custom';
        onSave();
        onRerender(); // Just to re-render the chips
      };

      const bunkChipBox = createChipPicker(bunksFromSelectedDivs, rules.bunks, onBunkToggle);
      customPanel.appendChild(bunkChipBox);
    }

    container.appendChild(customPanel);
  }

  return container;
}

/**
 * NEW: Helper for renderSharableControls to create chip pickers
 */
function createChipPicker(allItems, selectedItems, onToggle) {
  const chipBox = document.createElement("div");
  chipBox.style.display = "flex";
  chipBox.style.flexWrap = "wrap";
  chipBox.style.gap = "5px";
  chipBox.style.marginTop = "5px";
  
  allItems.forEach(name => {
    const chip = document.createElement("span");
    chip.textContent = name;
    chip.style.padding = "4px 8px";
    chip.style.borderRadius = "12px";
    chip.style.cursor = "pointer";
    chip.style.border = "1px solid #ccc";
    
    const isActive = selectedItems.includes(name);
    chip.style.backgroundColor = isActive ? "#007BFF" : "#f0f0f0";
    chip.style.color = isActive ? "white" : "black";
    
    chip.onclick = () => {
      const idx = selectedItems.indexOf(name);
      if (idx > -1) {
        selectedItems.splice(idx, 1);
      } else {
        selectedItems.push(name);
      }
      onToggle(); // Call the specific toggle logic
    };
    chipBox.appendChild(chip);
  });
  
  return chipBox;
}

// --- END OF NEW/UPDATED HELPER FUNCTIONS ---


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
      
      // We must also update scheduleAssignments IF it's loaded for a day
      if (window.scheduleAssignments && window.scheduleAssignments[b]) {
        window.scheduleAssignments[newName] = window.scheduleAssignments[b];
        delete window.scheduleAssignments[b];
        // Note: This only affects the *loaded* day. We need to save it.
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
    // --- UPDATED to include new properties ---
    fields.push({ 
      name: n, 
      activities: [], 
      available: true,
      sharableWith: { type: 'not_sharable' }, // <-- FIXED: Default to not sharable
      availabilityMode: 'available',
      availabilityExceptions: []
    });
    // --- END UPDATE ---
    i.value = "";
    saveData();
    renderFields();
  }
}
document.getElementById("addFieldBtn").onclick = addField;
document.getElementById("fieldInput").addEventListener("keyup", e => { if (e.key === "Enter") addField(); });

//
// ===== THIS IS THE FIRST MAJORLY UPDATED FUNCTION =====
//
function renderFields() {
  const c = document.getElementById("fieldList"); c.innerHTML = "";
  fields.forEach(f => {
    const w = document.createElement("div"); w.className = "fieldWrapper"; if (!f.available) w.classList.add("unavailable");
    const t = document.createElement("span"); t.className = "fieldTitle"; t.textContent = f.name;
    makeEditable(t, newName => { f.name = newName; saveData(); renderFields(); });
    w.appendChild(t);

    // --- START: "Available" toggle ---
    const controls = document.createElement("div");
    controls.style.display = "flex";
    controls.style.gap = "20px";
    controls.style.margin = "8px 0";

    // 1. Available Toggle
    const tog = document.createElement("label"); tog.className = "switch";
    tog.title = "Available (Master)";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = f.available;
    cb.onchange = () => { f.available = cb.checked; saveData(); renderFields(); };
    const sl = document.createElement("span"); sl.className = "slider";
    tog.appendChild(cb); tog.appendChild(sl); 
    const togLabel = document.createElement("span"); togLabel.textContent = "Available";
    const availWrap = document.createElement("label"); availWrap.style.display="flex"; availWrap.style.alignItems="center"; availWrap.style.gap="5px"; availWrap.style.cursor="pointer";
    availWrap.appendChild(tog); availWrap.appendChild(togLabel);
    controls.appendChild(availWrap);
    
    w.appendChild(controls);
    // --- END: "Available" toggle ---
    
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
    
    // --- (NEW) Sharable Controls ---
    const sharableControls = renderSharableControls(f, saveData, renderFields);
    w.appendChild(sharableControls);
    // --- END NEW ---

    // --- (NEW) Availability Controls ---
    const availabilityControls = renderAvailabilityControls(f, saveData, renderFields);
    w.appendChild(availabilityControls);
    // --- END NEW ---

    c.appendChild(w);
  });
}

function addSpecial() {
  const i = document.getElementById("specialInput");
  const n = i.value.trim();
  if (n) {
    // --- UPDATED to include new properties ---
    specialActivities.push({ 
      name: n, 
      available: true,
      sharableWith: { type: 'not_sharable' }, // <-- FIXED: Default to not sharable
      availabilityMode: 'available',
      availabilityExceptions: []
    });
    // --- END UPDATE ---
    i.value = "";
    saveData();
    renderSpecials();
  }
}
document.getElementById("addSpecialBtn").onclick = addSpecial;
document.getElementById("specialInput").addEventListener("keyup", e => { if (e.key === "Enter") addSpecial(); });


//
// ===== THIS IS THE SECOND MAJORLY UPDATED FUNCTION =====
//
function renderSpecials() {
  const c = document.getElementById("specialList"); c.innerHTML = "";
  specialActivities.forEach(s => {
    const w = document.createElement("div"); w.className = "fieldWrapper"; if (!s.available) w.classList.add("unavailable");
    const t = document.createElement("span"); t.className = "fieldTitle"; t.textContent = s.name;
    makeEditable(t, newName => { s.name = newName; saveData(); renderSpecials(); });
    w.appendChild(t);

    // --- START: "Available" toggle ---
    const controls = document.createElement("div");
    controls.style.display = "flex";
    controls.style.gap = "20px";
    controls.style.margin = "8px 0";

    // 1. Available Toggle
    const tog = document.createElement("label"); tog.className = "switch";
    tog.title = "Available (Master)";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = s.available;
    cb.onchange = () => { s.available = cb.checked; saveData(); renderSpecials(); };
    const sl = document.createElement("span"); sl.className = "slider";
    tog.appendChild(cb); tog.appendChild(sl); 
    const togLabel = document.createElement("span"); togLabel.textContent = "Available";
    const availWrap = document.createElement("label"); availWrap.style.display="flex"; availWrap.style.alignItems="center"; availWrap.style.gap="5px"; availWrap.style.cursor="pointer";
    availWrap.appendChild(tog); availWrap.appendChild(togLabel);
    controls.appendChild(availWrap);

    w.appendChild(controls);
    // --- END: "Available" toggle ---

    // --- (NEW) Sharable Controls ---
    const sharableControls = renderSharableControls(s, saveData, renderSpecials);
    w.appendChild(sharableControls);
    // --- END NEW ---

    // --- (NEW) Availability Controls ---
    const availabilityControls = renderAvailabilityControls(s, saveData, renderSpecials);
    w.appendChild(availabilityControls);
    // --- END NEW ---
    
    c.appendChild(w);
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
  
  // Expose the schedule times globally for app2.js
  window.unifiedTimes = unifiedTimes;
  window.divisionActiveRows = divisionActiveRows;
  
  // handoff to scheduling
  window.assignFieldsToBunks?.();
}

// -------------------- Local Storage (UPDATED) --------------------
function saveData() {
  // This now saves to the *Global Settings* object
  // NEW properties (availabilityMode, sharableWith) are saved automatically
  // because they are part of the 'fields' and 'specialActivities' objects.
  const data = { bunks, divisions, availableDivisions, selectedDivision, fields, specialActivities, timeTemplates };
  window.saveGlobalSettings?.("app1", data);
}

//
// ===== THIS IS THE THIRD MAJORLY UPDATED FUNCTION =====
//
function loadData() {
  // This now loads from the *GlobalSettings* object
  const data = window.loadGlobalSettings?.().app1 || {};
  
  try {
    bunks = data.bunks || [];
    divisions = data.divisions || {};
    
    availableDivisions = Object.keys(divisions);
    window.availableDivisions = availableDivisions;
    if (data.availableDivisions) availableDivisions = data.availableDivisions; 

    selectedDivision = data.selectedDivision || null;
    fields = data.fields || [];
    specialActivities = data.specialActivities || [];
    timeTemplates = data.timeTemplates || [];
    
    // --- NEW: Data Migration and Property Initialization ---
    fields.forEach(f => {
      f.available = f.available !== false; // default true
      // Migrate old 'sharable' boolean to new 'sharableWith' object
      if (typeof f.sharable === 'boolean') {
        f.sharableWith = { type: f.sharable ? 'all' : 'not_sharable' };
        delete f.sharable; // Remove old property
      } else {
        f.sharableWith = f.sharableWith || { type: 'not_sharable' }; // Default
      }
      f.availabilityMode = f.availabilityMode || 'available';
      f.availabilityExceptions = f.availabilityExceptions || [];
    });
    specialActivities.forEach(s => {
      s.available = s.available !== false; // default true
      // Migrate old 'sharable' boolean to new 'sharableWith' object
      if (typeof s.sharable === 'boolean') {
        // Old specials defaulted to sharable
        s.sharableWith = { type: s.sharable ? 'all' : 'not_sharable' };
        delete s.sharable; // Remove old property
      } else {
        // NEW specials default to NOT sharable
        s.sharableWith = s.sharableWith || { type: 'not_sharable' }; 
      }
      s.availabilityMode = s.availabilityMode || 'available';
      s.availabilityExceptions = s.availabilityExceptions || [];
    });
    // --- END NEW ---
    
  } catch (e) { console.error("Error loading data:", e); }
}

// "eraseAllBtn" is now handled by calendar.js

// -------------------- Init --------------------

// =============================================
// ===== START OF FIX =====
// =============================================
function initApp1() {
  // This code was moved from the global scope (line 32) to inside initApp1()
  // to ensure the DOM is ready before it runs.
  const activityDurationSelect = document.getElementById("activityDuration");
  if (activityDurationSelect) {
      activityDurationSelect.onchange = function() {
        activityDuration = parseInt(this.value, 10);
      };
      // Also set the initial value
      activityDuration = parseInt(activityDurationSelect.value, 10);
  } else {
    console.error("Could not find #activityDuration element");
  }

  loadData();
  updateUnassigned();
  setupDivisionButtons();
  renderFields();
  renderSpecials();
  renderTimeTemplates();
}
window.initApp1 = initApp1;
// =============================================
// ===== END OF FIX =====
// =============================================

// Expose internal objects for other modules to use (Data Source for the whole app)
window.getDivisions = () => divisions; 
window.getFields = () => fields;
window.getSpecials = () => specialActivities;
