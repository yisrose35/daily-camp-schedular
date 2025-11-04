// =================================================================
// daily_overrides.js
// This file creates the UI for the "Daily Overrides" tab.
//
// NEW: Replaced "Unavailable Bunks" with a "Daily Trips" scheduler.
// =================================================================

(function() {
    'use strict';

    let container = null;
    let masterSettings = {};
    let currentOverrides = { fields: [], leagues: [] };
    let currentTrips = [];

    /**
     * Main entry point. Called by index.html tab click or calendar.js date change.
     */
    function init() {
        container = document.getElementById("daily-overrides-content");
        if (!container) return; // Failsafe

        container.innerHTML = "<h2>Overrides & Trips for " + window.currentScheduleDate + "</h2>";

        // 1. Load Master "Setup" Data (from app1, leagues)
        masterSettings.global = window.loadGlobalSettings?.() || {};
        masterSettings.app1 = masterSettings.global.app1 || {};
        masterSettings.leaguesByName = masterSettings.global.leaguesByName || {};

        // 2. Load the data for the *current* day
        const dailyData = window.loadCurrentDailyData?.() || {};
        currentOverrides = dailyData.overrides || { fields: [], leagues: [] };
        currentTrips = dailyData.trips || [];

        // 3. Render the UI sections
        renderFieldsOverride();
        renderTripsSection(); // <-- NEW
        renderLeaguesOverride();
    }

    /**
     * Renders the "Unavailable Fields & Specials" checklist
     */
    function renderFieldsOverride() {
        const wrapper = document.createElement('div');
        wrapper.className = 'override-section';
        wrapper.innerHTML = '<h3>Unavailable Fields & Specials</h3>';

        const allFields = (masterSettings.app1.fields || []).concat(masterSettings.app1.specialActivities || []);

        if (allFields.length === 0) {
            wrapper.innerHTML += '<p class="muted">No fields or special activities found in Setup.</p>';
            container.appendChild(wrapper);
            return;
        }

        allFields.forEach(item => {
            const el = createCheckbox(item.name, currentOverrides.fields.includes(item.name));
            el.checkbox.onchange = () => {
                if (el.checkbox.checked) {
                    if (!currentOverrides.fields.includes(item.name)) {
                        currentOverrides.fields.push(item.name);
                    }
                } else {
                    currentOverrides.fields = currentOverrides.fields.filter(f => f !== item.name);
                }
                window.saveCurrentDailyData("overrides", currentOverrides);
            };
            wrapper.appendChild(el.wrapper);
        });
        container.appendChild(wrapper);
    }

    /**
     * NEW: Renders the "Daily Trips" section
     */
    function renderTripsSection() {
        const wrapper = document.createElement('div');
        wrapper.className = 'override-section';
        wrapper.innerHTML = '<h3>Daily Trips</h3>';
        
        // --- 1. Create the "Add Trip" Form ---
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
            
            <p style="margin-top: 15px; font-weight: 600;">Select Divisions / Bunks:</p>
        `;

        const chipBox = document.createElement('div');
        chipBox.className = 'chips';
        
        const divisions = masterSettings.app1.divisions || {};
        const availableDivisions = masterSettings.app1.availableDivisions || [];

        // Add chips for each Division
        availableDivisions.forEach(divName => {
            const chip = createChip(divName);
            chip.style.backgroundColor = divisions[divName]?.color;
            chip.style.color = 'white';
            chip.style.border = 'none';
            chipBox.appendChild(chip);
        });

        // Add chips for each Bunk
        availableDivisions.forEach(divName => {
            const bunkList = divisions[divName]?.bunks || [];
            bunkList.forEach(bunkName => {
                const chip = createChip(bunkName);
                chipBox.appendChild(chip);
            });
        });
        
        form.appendChild(chipBox);

        const addBtn = document.createElement('button');
        addBtn.textContent = 'Add Trip';
        addBtn.className = 'bunk-button';
        addBtn.style.background = '#007BFF';
        addBtn.style.color = 'white';
        addBtn.style.marginTop = '15px';
        
        addBtn.onclick = () => {
            const name = document.getElementById('tripName').value.trim();
            const start = document.getElementById('tripStart').value;
            const end = document.getElementById('tripEnd').value;
            
            const selectedTargets = Array.from(chipBox.querySelectorAll('.bunk-button.selected')).map(el => el.dataset.value);
            
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
                targets: selectedTargets // This can be mixed: ["5th Grade", "Bunk 1"]
            });
            
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
            item.className = 'item'; // Use the style from dailyActivities
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
                window.saveCurrentDailyData("overrides", currentOverrides);
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
    function createChip(name) {
        const el = document.createElement('span');
        el.className = 'bunk-button'; 
        el.textContent = name;
        el.dataset.value = name;
        el.addEventListener('click', ()=> el.classList.toggle('selected'));
        return el;
    }

    // Expose the init function to the global window
    window.initDailyOverrides = init;

})();
