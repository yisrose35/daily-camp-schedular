// -------------------- app1.js --------------------

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

// Global App1 data object
window.app1Data = {
  divisions: divisions,
  availableDivisions: availableDivisions,
  fields: fields,
  specialActivities: specialActivities,
  timeTemplates: timeTemplates
};

// -------------------- Helpers --------------------
function makeEditable(el, save) { el.ondblclick = e => { e.stopPropagation(); const old = el.textContent; const input = document.createElement("input"); input.type = "text"; input.value = old; el.replaceWith(input); input.focus(); function done() { const val = input.value.trim(); if (val && val !== old) save(val); el.textContent = val || old; input.replaceWith(el); } input.onblur = done; input.onkeyup = e => { if (e.key === "Enter") done(); }; };}
function parseTime(str) { if (!str) return null; const m = str.match(/^(\d{1,2}):(\d{2})(\s*)?(AM|PM)$/i); if (!m) return null; let h = parseInt(m[1],10), min = parseInt(m[2],10), ap = m[4].toUpperCase(); if (ap === "PM" && h !== 12) h += 12; if (ap === "AM" && h === 12) h = 0; return new Date(0,0,0,h,min);}
function fmtTime(d) { let h = d.getHours(), m = d.getMinutes().toString().padStart(2,"0"), ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return `${h}:${m} ${ap}`;}

// -------------------- NEW HELPER FUNCTION --------------------
/**
 * Renders the "Available / Unavailable" time-based controls
 * @param {object} item - The field or special activity object
 * @param {function} onSave - The function to call to save all data
 * @returns {HTMLElement}
 */
function renderAvailabilityControls(item, onSave) {
  const container = document.createElement("div");
  container.style.marginTop = "10px";
  container.style.paddingLeft = "15px";
  container.style.borderLeft = "3px solid #eee";

  // --- 1. Mode Toggle (Available / Unavailable) ---
  const modeLabel = document.createElement("label");
  modeLabel.style.display = "flex";
  modeLabel.style.alignItems = "center";
  modeLabel.style.gap = "8px";
  modeLabel.style.marginBottom = "8px";
  modeLabel.style.cursor = "pointer";

  const modeToggle = document.createElement("input");
  modeToggle.type = "checkbox";
  // "available" = unchecked (false), "unavailable" = checked (true)
  item.availabilityMode = item.availabilityMode || "available";
  modeToggle.checked = item.availabilityMode === "unavailable";

  const modeText = document.createElement("span");
  modeText.textContent = modeToggle.checked ? "Unavailable" : "Available";

  modeToggle.addEventListener("change", () => {
    item.availabilityMode = modeToggle.checked ? "unavailable" : "available";
    modeText.textContent = modeToggle.checked ? "Unavailable" : "Available";
    onSave();
  });

  modeLabel.appendChild(modeToggle);
  modeLabel.appendChild(modeText);
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
      renderApp1Specials(); // Re-render to reflect change
    };
    exceptionList.appendChild(pill);
  });
  container.appendChild(exceptionList);

  // --- 4. Add New Exception Input ---
  const addContainer = document.createElement("div");
  addContainer.style.marginTop = "6px";
  const timeInput = document.createElement("input");
  timeInput.placeholder = "e.g., 9:00-10:30 or 14:00-15:00";
  timeInput.style.marginRight = "5px";

  const addBtn = document.createElement("button");
  addBtn.textContent = "Add Time";
  addBtn.onclick = () => {
    const val = timeInput.value.trim();
    // Basic validation for "HH:MM-HH:MM" format
    if (/^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/.test(val)) {
      item.availabilityExceptions.push(val.replace(/\s/g, ''));
      timeInput.value = "";
      onSave();
      renderApp1Specials(); // Re-render to reflect change
    } else {
      alert("Invalid format. Use HH:MM-HH:MM (e.g., 9:00-10:30).");
    }
  };
  timeInput.onkeypress = (e) => { if (e.key === "Enter") addBtn.click(); };
  
  addContainer.appendChild(timeInput);
  addContainer.appendChild(addBtn);
  container.appendChild(addContainer);

  return container;
}


// -------------------- Save/Load --------------------
function saveApp1Data() {
  // Update the global object with the latest state
  const app1Data = {
    divisions: divisions,
    availableDivisions: availableDivisions,
    fields: fields,
    specialActivities: specialActivities,
    timeTemplates: timeTemplates
  };
  window.app1Data = app1Data;
  
  // Call the global save function (defined in calendar.js or main.js)
  window.saveGlobalSettings?.("app1", app1Data);
  console.log("App1 Data Saved.");

  // Re-publish global variables that other modules might be using
  window.divisions = divisions;
  window.availableDivisions = availableDivisions;
}

function loadApp1Data() {
  const globalSettings = window.loadGlobalSettings?.() || {};
  const app1Data = globalSettings.app1 || {};

  // Load data, providing defaults
  divisions = app1Data.divisions || {};
  availableDivisions = app1Data.availableDivisions || [];
  fields = app1Data.fields || [];
  specialActivities = app1Data.specialActivities || [];
  timeTemplates = app1Data.timeTemplates || [];
  
  // Ensure defaults for nested properties
  fields.forEach(f => {
    f.available = f.available !== false; // default true
    f.sharable = f.sharable === true; // default false
    f.allowedDivisions = f.allowedDivisions || [];
    f.availabilityMode = f.availabilityMode || 'available';
    f.availabilityExceptions = f.availabilityExceptions || [];
  });
  specialActivities.forEach(s => {
    s.available = s.available !== false; // default true
    s.sharable = s.sharable === true; // default false
    s.allowedDivisions = s.allowedDivisions || [];
    s.availabilityMode = s.availabilityMode || 'available';
    s.availabilityExceptions = s.availabilityExceptions || [];
  });

  // Re-publish global variables
  window.app1Data = app1Data;
  window.divisions = divisions;
  window.availableDivisions = availableDivisions;
  window.fields = fields;
  window.specialActivities = specialActivities;
  window.timeTemplates = timeTemplates;
  
  console.log("App1 Data Loaded.");
}

// -------------------- Render Functions --------------------

/**
 * UPDATED RENDER FUNCTION
 * This now includes the 'Available', 'Sharable' toggles and time-based availability
 */
function renderApp1Fields() {
  const container = document.getElementById("app1-fields-container");
  if (!container) return;
  container.innerHTML = "";

  fields.forEach((field, index) => {
    const div = document.createElement("div");
    div.className = "app1-item";
    
    const header = document.createElement("div");
    header.className = "app1-item-header";

    const title = document.createElement("strong");
    title.textContent = field.name || "Field";
    header.appendChild(title);

    const controls = document.createElement("div");
    
    // --- Available Toggle ---
    const availableLabel = document.createElement("label");
    availableLabel.textContent = "Available: ";
    const availableCheck = document.createElement("input");
    availableCheck.type = "checkbox";
    availableCheck.checked = field.available;
    availableCheck.onchange = () => {
      field.available = availableCheck.checked;
      saveApp1Data();
    };
    availableLabel.appendChild(availableCheck);
    controls.appendChild(availableLabel);

    // --- Sharable Toggle ---
    const sharableLabel = document.createElement("label");
    sharableLabel.textContent = "Sharable: ";
    const sharableCheck = document.createElement("input");
    sharableCheck.type = "checkbox";
    sharableCheck.checked = field.sharable;
    sharableCheck.onchange = () => {
      field.sharable = sharableCheck.checked;
      saveApp1Data();
    };
    sharableLabel.appendChild(sharableCheck);
    controls.appendChild(sharableLabel);

    // --- Delete Button ---
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.onclick = () => {
      if (confirm(`Delete ${field.name}?`)) {
        fields.splice(index, 1);
        saveApp1Data();
        renderApp1Fields(); // Re-render
      }
    };
    controls.appendChild(deleteBtn);
    header.appendChild(controls);
    div.appendChild(header);

    // --- (ADD YOUR 'allowedDivisions' LOGIC HERE) ---
    // e.g., const allowedDivsEl = renderAllowedDivisions(field, saveApp1Data);
    // div.appendChild(allowedDivsEl);
    
    // --- (NEW) Availability Controls ---
    const availabilityControls = renderAvailabilityControls(field, () => {
        saveApp1Data();
        renderApp1Fields(); // Re-render this section
    });
    div.appendChild(availabilityControls);
    // --- END NEW ---

    container.appendChild(div);
  });

  // "Add Field" button
  const addBtn = document.createElement("button");
  addBtn.textContent = "Add Field";
  addBtn.onclick = () => {
    const name = prompt("Enter new field name:");
    if (name) {
      fields.push({
        name: name,
        available: true,
        sharable: false,
        activities: [],
        allowedDivisions: [],
        availabilityMode: 'available',
        availabilityExceptions: []
      });
      saveApp1Data();
      renderApp1Fields();
    }
  };
  container.appendChild(addBtn);
}

/**
 * UPDATED RENDER FUNCTION
 * This now includes the 'Available', 'Sharable' toggles and time-based availability
 */
function renderApp1Specials() {
  const container = document.getElementById("app1-specials-container");
  if (!container) return;
  container.innerHTML = "";

  specialActivities.forEach((special, index) => {
    const div = document.createElement("div");
    div.className = "app1-item";
    
    const header = document.createElement("div");
    header.className = "app1-item-header";

    const title = document.createElement("strong");
    title.textContent = special.name || "Special Activity";
    header.appendChild(title);

    const controls = document.createElement("div");
    
    // --- Available Toggle ---
    const availableLabel = document.createElement("label");
    availableLabel.textContent = "Available: ";
    const availableCheck = document.createElement("input");
    availableCheck.type = "checkbox";
    availableCheck.checked = special.available;
    availableCheck.onchange = () => {
      special.available = availableCheck.checked;
      saveApp1Data();
    };
    availableLabel.appendChild(availableCheck);
    controls.appendChild(availableLabel);

    // --- Sharable Toggle ---
    const sharableLabel = document.createElement("label");
    sharableLabel.textContent = "Sharable: ";
    const sharableCheck = document.createElement("input");
    sharableCheck.type = "checkbox";
    sharableCheck.checked = special.sharable;
    sharableCheck.onchange = () => {
      special.sharable = sharableCheck.checked;
      saveApp1Data();
    };
    sharableLabel.appendChild(sharableCheck);
    controls.appendChild(sharableLabel);

    // --- Delete Button ---
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.onclick = () => {
      if (confirm(`Delete ${special.name}?`)) {
        specialActivities.splice(index, 1);
        saveApp1Data();
        renderApp1Specials(); // Re-render
      }
    };
    controls.appendChild(deleteBtn);
    header.appendChild(controls);
    div.appendChild(header);

    // --- (ADD YOUR 'allowedDivisions' LOGIC HERE) ---
    // e.g., const allowedDivsEl = renderAllowedDivisions(special, saveApp1Data);
    // div.appendChild(allowedDivsEl);

    // --- (NEW) Availability Controls ---
    const availabilityControls = renderAvailabilityControls(special, () => {
        saveApp1Data();
        renderApp1Specials(); // Re-render this section
    });
    div.appendChild(availabilityControls);
    // --- END NEW ---

    container.appendChild(div);
  });
  
  // "Add Special" button
  const addBtn = document.createElement("button");
  addBtn.textContent = "Add Special Activity";
  addBtn.onclick = () => {
    const name = prompt("Enter new special activity name:");
    if (name) {
      specialActivities.push({
        name: name,
        available: true,
        sharable: true, // Specials default to sharable
        allowedDivisions: [],
        availabilityMode: 'available',
        availabilityExceptions: []
      });
      saveApp1Data();
      renderApp1Specials();
    }
  };
  container.appendChild(addBtn);
}

// -------------------- Init --------------------
function initApp1() {
  loadApp1Data();
  
  // Call your other render functions
  // renderApp1Divisions(); // (You have this function, I assume)
  renderApp1Fields(); // Updated
  renderApp1Specials(); // Updated
  // renderApp1TimeTemplates(); // (You have this function, I assume)

  console.log("App1 (Setup) Initialized.");
}

// Expose the init function to the global window
window.initApp1 = initApp1;
