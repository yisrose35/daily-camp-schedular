// =================================================================
// daily_overrides.js
// This file creates the UI for the "Daily Overrides" tab.
//
// NEW: Replaced simple field override with time-based availability.
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

// Helper function (copied from core)
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
    if (hh === 12) hh = mer === "am" ? 0 : 12;
    else if (mer === "pm") hh += 12;
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
  container.innerHTML = "<h2>Overrides & Trips for " + window.currentScheduleDate + "</h2>";

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
  renderFieldsOverride(); // Updated function
  renderTripsSection();
  renderLeaguesOverride();
}

/**
 * Helper: Renders the "Available / Unavailable" controls for daily overrides
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
  modeLabel.style.gap = "8px";
  modeLabel.style.marginBottom = "8px";
  modeLabel.style.cursor = "pointer";

  const modeToggle = document.createElement("input");
  modeToggle.type = "checkbox";
  // "available" = unchecked (false), "unavailable" = checked (true)
  item.mode = item.mode || "available";
  modeToggle.checked = item.mode === "unavailable";

  const modeText = document.createElement("span");
  modeText.textContent = modeToggle.checked ? "Unavailable" : "Available";

  modeToggle.addEventListener("change", () => {
    item.mode = modeToggle.checked ? "unavailable" : "available";
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
      onSave();
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
    if (/^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/.test(val)) {
      item.exceptions.push(val.replace(/\s/g, ''));
      timeInput.value = "";
      onSave();
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

/**
* Renders the "Field & Special Activity Time Overrides" section
*/
function renderFieldsOverride() {
  const wrapper = document.createElement('div');
  wrapper.className = 'override-section';
  wrapper.innerHTML = '<h3>Field & Special Activity Time Overrides</h3>';

  const allFields = (masterSettings.app1.fields || []).concat(masterSettings.app1.specialActivities || []);

  if (allFields.length === 0) {
    wrapper.innerHTML += '<p class="muted">No fields or special activities found in Setup.</p>';
    container.appendChild(wrapper);
    return;
  }

  allFields.forEach(item => {
    const itemName = item.name;
    const overrideData = currentOverrides.fieldAvailability[itemName];
    
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

    const saveAndRerender = () => {
      console.log("Daily Overrides: Saving field availability...", currentOverrides.fieldAvailability);
      window.saveCurrentDailyData("fieldAvailability", currentOverrides.fieldAvailability);
      // We don't need to call init() for this, just re-render this one item
      renderFieldsOverride();
    };

    if (overrideData) {
      // --- Render the full controls ---
      const removeBtn = document.createElement("button");
      removeBtn.textContent = "Remove Daily Override";
      removeBtn.style.background = "#c0392b";
      removeBtn.style.color = "white";
      removeBtn.onclick = () => {
        delete currentOverrides.fieldAvailability[itemName];
        saveAndRerender();
      };
      header.appendChild(removeBtn);
      itemWrapper.appendChild(header);

      // Get the global rule for display
      const globalRule = item.availabilityMode === 'unavailable' ? 'Unavailable' : 'Available';
      const globalExceptions = (item.availabilityExceptions || []).join(', ');
      const globalText = `(Global Rule: ${globalRule}${globalExceptions ? ` except ${globalExceptions}` : ''})`;
      const globalEl = document.createElement("p");
      globalEl.textContent = globalText;
      globalEl.style.fontSize = "0.9em";
      globalEl.style.fontStyle = "italic";
      globalEl.style.opacity = "0.7";
      globalEl.style.margin = "5px 0 0 0";
      itemWrapper.appendChild(globalEl);

      const controls = renderDailyAvailabilityControls(overrideData, () => {
         window.saveCurrentDailyData("fieldAvailability", currentOverrides.fieldAvailability);
      });
      itemWrapper.appendChild(controls);

    } else {
      // --- Render the "Add" button ---
      const addBtn = document.createElement("button");
      addBtn.textContent = "Add Daily Time Override";
      addBtn.onclick = () => {
        // Create a default override based on the global rule
        currentOverrides.fieldAvailability[itemName] = {
          mode: item.availabilityMode || "available",
          exceptions: JSON.parse(JSON.stringify(item.availabilityExceptions || [])) // Deep copy
        };
        saveAndRerender();
      };
      header.appendChild(addBtn);
      itemWrapper.appendChild(header);
    }
    
    wrapper.appendChild(itemWrapper);
  });
  container.appendChild(wrapper);
}

/**
* Renders the "Daily Trips" section
*/
function renderTripsSection() {
  const wrapper = document.createElement('div');
  wrapper.className = 'override-section';
  wrapper.innerHTML = '<h3>Daily Trips</h3>';

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
    init(); // Re-render the whole tab
  };

  form.appendChild(addBtn);
  wrapper.appendChild(form);

  // --- 2. Create the "Current Trips" List ---
  const listHeader = document.createElement('h4');
  listHeader.textContent = 'Scheduled Trips for This Day:';
  listHeader.style.marginTop = '20px';
  wrapper.appendChild(listHeader);

  if (currentTrips.length === 0) {
    wrapper.innerHTML += '<p class="muted">No trips scheduled for this day.</p>';
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
      init(); // Re-render
    };
    wrapper.appendChild(item);
  });

  container.appendChild(wrapper);
}

/**
* Renders the "Disabled Leagues" checklist
*/
function renderLeaguesOverride() {
  const wrapper = document.createElement('div');
  wrapper.className = 'override-section';
  wrapper.innerHTML = '<h3>Disabled Leagues</h3>';

  const leagues = masterSettings.leaguesByName || {};
  const leagueNames = Object.keys(leagues);

  if (leagueNames.length === 0) {
    wrapper.innerHTML += '<p class="muted">No leagues found in Setup.</p>';
    container.appendChild(wrapper);
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
    wrapper.appendChild(el.wrapper);
  });
  container.appendChild(wrapper);
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
