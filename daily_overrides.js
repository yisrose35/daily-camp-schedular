// =================================================================
// daily_overrides.js
// This file creates the UI for the "Daily Overrides" tab.
//
// NEW: Fixed page-jump bug on field override add/remove.
// NEW: Fixed "Add Trip" functionality and split render functions.
// =================================================================

(function() {
'use strict';

let container = null;
let masterSettings = {};
let currentOverrides = {
  fieldAvailability: {}, // NEW
  leagues: []
};
let currentTrips = [];

// --- Helper containers ---
let fieldOverridesContainer = null;
let tripsFormContainer = null;
let tripsListContainer = null;
let leaguesContainer = null;

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
* Main entry point. Called by index.html tab click or calendar.js date change.
*/
function init() {
  container = document.getElementById("daily-overrides-content");
  if (!container) {
    console.error("Daily Overrides: Could not find container #daily-overrides-content");
    return;
  }

  console.log("Daily Overrides: Initializing for", window.currentScheduleDate);
  container.innerHTML = `
    <h2>Overrides & Trips for ${window.currentScheduleDate}</h2>
    
    <div class="override-section" id="field-overrides-container">
      <h3>Field & Special Activity Time Overrides</h3>
    </div>
    
    <div class="override-section">
      <h3>Daily Trips</h3>
      <div id="trips-form-container"></div>
      <div id="trips-list-container"></div>
    </div>
    
    <div class="override-section" id="league-overrides-container">
      <h3>Disabled Leagues</h3>
    </div>
  `;

  // Get references to the new containers
  fieldOverridesContainer = document.getElementById("field-overrides-container");
  tripsFormContainer = document.getElementById("trips-form-container");
  tripsListContainer = document.getElementById("trips-list-container");
  leaguesContainer = document.getElementById("league-overrides-container");


  // 1. Load Master "Setup" Data
  masterSettings.global = window.loadGlobalSettings?.() || {};
  masterSettings.app1 = masterSettings.global.app1 || {};
  masterSettings.leaguesByName = masterSettings.global.leaguesByName || {};

  // 2. Load the data for the *current* day
  const dailyData = window.loadCurrentDailyData?.() || {};
  
  // Load new field availability, fall back to old "fields" list for one-time migration
  currentOverrides.fieldAvailability = dailyData.fieldAvailability || {};
  
  // Check for old "overrides" structure
  if (dailyData.overrides && dailyData.overrides.fields && dailyData.overrides.fields.length > 0 && Object.keys(currentOverrides.fieldAvailability).length === 0) {
    console.log("Daily Overrides: Migrating old 'fields' overrides...");
    // One-time migration from old "unavailable" list
    dailyData.overrides.fields.forEach(fieldName => {
      currentOverrides.fieldAvailability[fieldName] = {
        mode: "unavailable", // Old list only marked items as unavailable
        exceptions: []
      };
    });
    // Save the new structure immediately
    window.saveCurrentDailyData("fieldAvailability", currentOverrides.fieldAvailability);
    
    // Clear the old, now-migrated data
    const newOverrides = dailyData.overrides;
    delete newOverrides.fields;
    window.saveCurrentDailyData("overrides", newOverrides);
  }
  
  currentOverrides.leagues = dailyData.overrides?.leagues || [];
  currentTrips = dailyData.trips || [];

  // 3. Render the UI sections
  renderFieldsOverride();
  renderTripsForm();
  renderTripsList();
  renderLeaguesOverride();
}

/**
 * UPDATED: Renders the new "Available / Unavailable" SLIDER toggle
 */
function renderDailyAvailabilityControls(item, onSave) {
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
    backgroundColor: item.mode === 'available' ? '#22c55e' : '#d1d5db', // green or grey
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
    left: item.mode === 'available' ? '21px' : '1px', // right or left
    transition: "left 0.2s"
  });
  
  toggleTrack.appendChild(toggleKnob);
  
  const textUnavailable = document.createElement("span");
  textUnavailable.textContent = "Unavailable";
  
  // Set initial text style
  textAvailable.style.fontWeight = item.mode === 'available' ? 'bold' : 'normal';
  textUnavailable.style.fontWeight = item.mode === 'unavailable' ? 'bold' : 'normal';

  // Use onclick on the label to toggle state
  modeLabel.onclick = () => {
    item.mode = (item.mode === 'available') ? 'unavailable' : 'available';
    
    // Update styles
    toggleTrack.style.backgroundColor = item.mode === 'available' ? '#22c55e' : '#d1d5db';
    toggleKnob.style.left = item.mode === 'available' ? '21px' : '1px';
    textAvailable.style.fontWeight = item.mode === 'available' ? 'bold' : 'normal';
    textUnavailable.style.fontWeight = item.mode === 'unavailable' ? 'bold' : 'normal';
    
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

  item.exceptions = item.exceptions || [];
  item.exceptions.forEach((timeStr, index) => {
    const pill = document.createElement("span");
    pill.textContent = `${timeStr} ✖`;
    pill.style.background = "#ddd";
    pill.style.padding = "4px 8px";
    pill.style.borderRadius = "12px";
    pill.style.cursor = "pointer";
    pill.onclick = () => {
      item.exceptions.splice(index, 1);
      onSave(); // This will just save and re-render this specific control
    };
    exceptionList.appendChild(pill);
  });
  container.appendChild(exceptionList);

  // --- 4. Add New Exception Input ---
  const addContainer = document.createElement("div");
  addContainer.style.marginTop = "6px";
  const timeInput = document.createElement("input");
  // UPDATED Placeholder
  timeInput.placeholder = "e.g., 9:00am-10:30am";
  timeInput.style.marginRight = "5px";

  const addBtn = document.createElement("button");
  addBtn.textContent = "Add Time";
  
  // UPDATED Validation Logic
  addBtn.onclick = () => {
    const val = timeInput.value.trim();
    const parts = val.split('-');
    if (parts.length === 2) {
      const startMin = parseTimeToMinutes(parts[0]);
      const endMin = parseTimeToMinutes(parts[1]);
      
      if (startMin != null && endMin != null && endMin > startMin) {
        // Valid! Push the original, user-formatted string
        item.exceptions.push(val);
        timeInput.value = "";
        onSave();
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
* Renders the "Field & Special Activity Time Overrides" section
* NEW: This function now renders in-place and does not cause a page jump.
*/
function renderFieldsOverride() {
  // Clear only its own container
  fieldOverridesContainer.innerHTML = '<h3>Field & Special Activity Time Overrides</h3>';

  const allFields = (masterSettings.app1.fields || []).concat(masterSettings.app1.specialActivities || []);

  if (allFields.length === 0) {
    fieldOverridesContainer.innerHTML += '<p class="muted">No fields or special activities found in Setup.</p>';
    return;
  }

  allFields.forEach(item => {
    const itemName = item.name;
    let overrideData = currentOverrides.fieldAvailability[itemName];
    
    const itemWrapper = document.createElement("div");
    itemWrapper.style.padding = "10px";
    itemWrapper.style.border = "1px solid #ddd";
    itemWrapper.style.borderRadius = "5px";
    itemWrapper.style.marginBottom = "10px";

    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.alignItems = "center";
    
    const title = document.createElement("strong");
    title.textContent = itemName;
    header.appendChild(title);
    
    // --- Create ALL controls, but hide/show them ---
    const addBtn = document.createElement("button");
    addBtn.textContent = "Add Daily Time Override";
    
    const removeBtn = document.createElement("button");
    removeBtn.textContent = "Remove Daily Override";
    removeBtn.style.background = "#c0392b";
    removeBtn.style.color = "white";
    
    const globalEl = document.createElement("p");
    globalEl.style.fontSize = "0.9em";
    globalEl.style.fontStyle = "italic";
    globalEl.style.opacity = "0.7";
    globalEl.style.margin = "5px 0 0 0";
    
    const controlsPlaceholder = document.createElement("div");
    
    // Function to save data and re-render *only* this item's controls
    const saveAndRefreshControls = () => {
      window.saveCurrentDailyData("fieldAvailability", currentOverrides.fieldAvailability);
      // Re-render just the controls for this item
      controlsPlaceholder.innerHTML = "";
      controlsPlaceholder.appendChild(
        renderDailyAvailabilityControls(overrideData, saveAndRefreshControls)
      );
    };

    // --- Button Click Handlers ---
    addBtn.onclick = () => {
      // Create a default override based on the global rule
      overrideData = {
        mode: item.availabilityMode || "available",
        exceptions: JSON.parse(JSON.stringify(item.availabilityExceptions || [])) // Deep copy
      };
      currentOverrides.fieldAvailability[itemName] = overrideData;
      
      window.saveCurrentDailyData("fieldAvailability", currentOverrides.fieldAvailability);
      
      // Show the remove button and controls
      addBtn.style.display = "none";
      removeBtn.style.display = "block";
      globalEl.style.display = "block";
      saveAndRefreshControls(); // Render controls for the first time
    };
    
    removeBtn.onclick = () => {
      delete currentOverrides.fieldAvailability[itemName];
      overrideData = null; // Clear the local reference
      
      window.saveCurrentDailyData("fieldAvailability", currentOverrides.fieldAvailability);
      
      // Show the add button and hide controls
      addBtn.style.display = "block";
      removeBtn.style.display = "none";
      globalEl.style.display = "none";
      controlsPlaceholder.innerHTML = "";
    };

    // --- Initial State ---
    if (overrideData) {
      // Already overridden: Show remove button and controls
      addBtn.style.display = "none";
      removeBtn.style.display = "block";
      
      const globalRule = item.availabilityMode === 'unavailable' ? 'Unavailable' : 'Available';
      const globalExceptions = (item.availabilityExceptions || []).join(', ');
      globalEl.textContent = `(Global Rule: ${globalRule}${globalExceptions ? ` except ${globalExceptions}` : ''})`;
      globalEl.style.display = "block";
      
      controlsPlaceholder.appendChild(
        renderDailyAvailabilityControls(overrideData, saveAndRefreshControls)
      );
    } else {
      // Not overridden: Show add button, hide controls
      addBtn.style.display = "block";
      removeBtn.style.display = "none";
      globalEl.style.display = "none";
    }
    
    header.appendChild(addBtn);
    header.appendChild(removeBtn);
    itemWrapper.appendChild(header);
    itemWrapper.appendChild(globalEl);
    itemWrapper.appendChild(controlsPlaceholder);
    
    fieldOverridesContainer.appendChild(itemWrapper);
  });
}

/**
 * NEW: Renders *only* the "Daily Trips" form
 */
function renderTripsForm() {
  tripsFormContainer.innerHTML = ""; // Clear only the form container

  const form = document.createElement('div');
  form.style.border = '1px solid #ccc';
  form.style.padding = '15px';
  form.style.borderRadius = '8px';

  form.innerHTML = `
<label for="tripName" style="display: block; margin-bottom: 5px; font-weight: 600;">Trip Name:</label>
<input type="text" id="tripName" placeholder="e.g., Museum Trip" style="width: 250px;">

<label for="tripStart" style="display: inline-block; margin-top: 10px; font-weight: 600;">Start Time:</label>
<input id="tripStart" placeholder="e.g., 9:00am" style="margin-right: 8px;">

<label for="tripEnd" style="display: inline-block; font-weight: 600;">End Time:</label>
<input id="tripEnd" placeholder="e.g., 2:00pm" style="margin-right: 8px;">

<p style="margin-top: 15px; font-weight: 600;">Select Divisions:</p>
`;

  const divisions = masterSettings.app1.divisions || {};
  const availableDivisions = masterSettings.app1.availableDivisions || [];

  // 1. Create Division Chip Box
  const divisionChipBox = document.createElement('div');
  divisionChipBox.className = 'chips';
  divisionChipBox.style.marginBottom = '5px';

  availableDivisions.forEach(divName => {
    const divColor = divisions[divName]?.color || '#333';
    const chip = createChip(divName, divColor, true); // true = isDivision
    divisionChipBox.appendChild(chip);
  });

  form.appendChild(divisionChipBox);

  // 2. Add a separator
  const bunkHeader = document.createElement('p');
  bunkHeader.textContent = 'Or Select Individual Bunks:';
  bunkHeader.style.marginTop = '15px';
  bunkHeader.style.fontWeight = '600';
  form.appendChild(bunkHeader);

  // 3. Create Bunk Chip Box
  const bunkChipBox = document.createElement('div');
  bunkChipBox.className = 'chips';

  availableDivisions.forEach(divName => {
    const bunkList = divisions[divName]?.bunks || [];
    bunkList.forEach(bunkName => {
      const chip = createChip(bunkName, '#007BFF', false); // false = isBunk
      bunkChipBox.appendChild(chip);
    });
  });

  form.appendChild(bunkChipBox);

  const addBtn = document.createElement('button');
  addBtn.textContent = 'Add Trip';
  addBtn.className = 'bunk-button';
  addBtn.style.background = '#007BFF';
  addBtn.style.color = 'white';
  addBtn.style.marginTop = '15px';

  addBtn.onclick = () => {
    console.log("Daily Overrides: 'Add Trip' button clicked.");

    const nameEl = form.querySelector('#tripName');
    const startEl = form.querySelector('#tripStart');
    const endEl = form.querySelector('#tripEnd');

    if (!nameEl || !startEl || !endEl) {
      console.error("Daily Overrides: Could not find trip form elements!");
      return;
    }

    const name = nameEl.value.trim();
    const start = startEl.value;
    const end = endEl.value;

    const selectedDivChips = Array.from(divisionChipBox.querySelectorAll('.bunk-button.selected')).map(el => el.dataset.value);
    const selectedBunkChips = Array.from(bunkChipBox.querySelectorAll('.bunk-button.selected')).map(el => el.dataset.value);

    const selectedTargets = [...selectedDivChips, ...selectedBunkChips];

    console.log("Daily Overrides: Trip Data:", { name, start, end, selectedTargets });

    if (!name || !start || !end) {
      alert('Please enter a name, start time, and end time for the trip.');
      return;
    }
    if (selectedTargets.length === 0) {
      alert('Please select at least one division or bunk for the trip.');
      return;
    }

    currentTrips.push({
      id: Math.random().toString(36).slice(2,9),
      name,
      start,
      end,
      targets: selectedTargets
    });

    console.log("Daily Overrides: Saving trips...", currentTrips);
    window.saveCurrentDailyData("trips", currentTrips);
    
    // --- FIX: Re-render ONLY the list and clear the form ---
    renderTripsList();
    
    // Clear form
    nameEl.value = "";
    startEl.value = "";
    endEl.value = "";
    form.querySelectorAll('.bunk-button.selected').forEach(chip => {
        chip.click(); // This will toggle the class and style
    });
    // --- END FIX ---
  };

  form.appendChild(addBtn);
  tripsFormContainer.appendChild(form);
}

/**
 * NEW: Renders *only* the list of current trips
 */
function renderTripsList() {
  tripsListContainer.innerHTML = ""; // Clear only the list container

  const listHeader = document.createElement('h4');
  listHeader.textContent = 'Scheduled Trips for This Day:';
  listHeader.style.marginTop = '20px';
  tripsListContainer.appendChild(listHeader);

  if (currentTrips.length === 0) {
    tripsListContainer.innerHTML += '<p class="muted">No trips scheduled for this day.</p>';
  }

  currentTrips.forEach(trip => {
    const item = document.createElement('div');
    item.className = 'item';
    item.innerHTML = `
  <div style="flex-grow:1;">
    <div><strong>${trip.name}</strong></div>
    <div class="muted" style="font-size: 0.9em;">${trip.start} - ${trip.end}</div>
    <div class="muted" style="font-size: 0.8em; padding-left: 10px;">
      &hookrightarrow; Applies to: ${trip.targets.join(', ')}
    </div>
  </div>
  <button data-id="${trip.id}" style="padding: 6px 10px; border-radius:4px; cursor:pointer; background: #c0392b; color: white;">Remove</button>
  `;

    item.querySelector('button').onclick = () => {
      console.log("Daily Overrides: Removing trip", trip.id);
      currentTrips = currentTrips.filter(t => t.id !== trip.id);
      window.saveCurrentDailyData("trips", currentTrips);
      renderTripsList(); // Re-render only this list
    };
    tripsListContainer.appendChild(item);
  });
}


/**
* Renders the "Disabled Leagues" checklist
*/
function renderLeaguesOverride() {
  leaguesContainer.innerHTML = '<h3>Disabled Leagues</h3>'; // Clear only its container

  const leagues = masterSettings.leaguesByName || {};
  const leagueNames = Object.keys(leagues);

  if (leagueNames.length === 0) {
    leaguesContainer.innerHTML += '<p class="muted">No leagues found in Setup.</p>';
    return;
  }

  leagueNames.forEach(leagueName => {
    const el = createCheckbox(leagueName, currentOverrides.leagues.includes(leagueName));
    el.checkbox.onchange = () => {
      if (el.checkbox.checked) {
        if (!currentOverrides.leagues.includes(leagueName)) {
          currentOverrides.leagues.push(leagueName);
        }
      } else {
        currentOverrides.leagues = currentOverrides.leagues.filter(l => l !== leagueName);
      }
      
      // Save under the original "overrides" key for leagues
      const dailyData = window.loadCurrentDailyData?.() || {};
      const fullOverrides = dailyData.overrides || {};
      fullOverrides.leagues = currentOverrides.leagues;
      
      console.log("Daily Overrides: Saving league overrides...", fullOverrides.leagues);
      window.saveCurrentDailyData("overrides", fullOverrides);
    };
    leaguesContainer.appendChild(el.wrapper);
  });
}

/**
* Helper to create a standardized checkbox UI element
*/
function createCheckbox(name, isChecked) {
  const wrapper = document.createElement('label');
  wrapper.className = 'override-checkbox';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = isChecked;

  const text = document.createElement('span');
  text.textContent = name;

  wrapper.appendChild(checkbox);
  wrapper.appendChild(text);
  return { wrapper, checkbox };
}

/**
* Helper to create a bunk/division chip
*/
function createChip(name, color = '#007BFF', isDivision = false) {
  const el = document.createElement('span');
  el.className = 'bunk-button';
  el.textContent = name;
  el.dataset.value = name;

  const defaultBorder = isDivision ? color : '#ccc';
  el.style.borderColor = defaultBorder;
  // Make sure it renders in the "unselected" state by default
  el.style.backgroundColor = 'white';
  el.style.color = 'black';

  el.addEventListener('click', () => {
    const isSelected = el.classList.toggle('selected');
    console.log("Daily Overrides: Chip clicked:", name, "Selected:", isSelected);
    el.style.backgroundColor = isSelected ? color : 'white';
    el.style.color = isSelected ? 'white' : 'black';
    el.style.borderColor = isSelected ? color : defaultBorder;
  });
  return el;
}

// Expose the init function to the global window
window.initDailyOverrides = init;

})();
