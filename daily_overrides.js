// =================================================================
// daily_overrides.js
// This file creates the UI for the "Daily Overrides" tab.
//
// FIX: "Add Trip" button now correctly finds form fields.
// FIX: Division/Bunk chips now change color when selected.
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
        renderTripsSection(); 
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
            // Pass the division color to the chip factory
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
            // ===== FIX 1: Query from the 'form' element, not the 'document' =====
            const name = form.querySelector('#tripName').value.trim();
            const start = form.querySelector('#tripStart').value;
            const end = form.querySelector('#tripEnd').value;
            // ===================================================================
            
            const selectedDivChips = Array.from(divisionChipBox.querySelectorAll('.bunk-button.selected')).map(el => el.dataset.value);
            const selectedBunkChips = Array.from(bunkChipBox.querySelectorAll('.bunk-button.selected')).map(el => el.dataset.value);
            
            const selectedTargets = [...selectedDivChips, ...selectedBunkChips]; 
            
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
     * ===== FIX 2: Helper to create a bunk/division chip =====
     * Now visually toggles its own color.
     */
    function createChip(name, color = '#007BFF', isDivision = false) {
        const el = document.createElement('span');
        el.className = 'bunk-button'; 
        el.textContent = name;
        el.dataset.value = name;
        
        // Set default border color
        const defaultBorder = isDivision ? color : '#ccc';
        el.style.borderColor = defaultBorder;
        
        el.addEventListener('click', () => {
            const isSelected = el.classList.toggle('selected');
            el.style.backgroundColor = isSelected ? color : 'white';
            el.style.color = isSelected ? 'white' : 'black';
            el.style.borderColor = isSelected ? color : defaultBorder;
        });
        return el;
    }

    // Expose the init function to the global window
    window.initDailyOverrides = init;

})();
