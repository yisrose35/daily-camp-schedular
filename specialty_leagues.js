
// =================================================================
// specialty_leagues.js
//
// UPDATED:
// - `loadData`: Changed `window.getFields()` (which was removed
//   from app1.js) to `window.loadGlobalSettings().app1.fields`.
// - `loadData`: Also updated to get special activities from
//   `app1.specialActivities` for future use (if needed).
// =================================================================

(function() {
    'use strict';

    let specialtyLeagues = {}; // { "leagueId": { id, name, sport, fields, teams, divisions, enabled } }
    
    // Data from app1
    let allFields = [];
    let allDivisions = [];
    let fieldsBySport = {};

    /**
     * Loads all data from global settings
     */
    function loadData() {
        const globalSettings = window.loadGlobalSettings?.() || {};
        const app1Data = globalSettings.app1 || {};

        // 1. Load our own data
        specialtyLeagues = globalSettings.specialtyLeagues || {};

        // 2. Load data from app1
        // --- UPDATED THESE LINES ---
        allFields = app1Data.fields || []; 
        // We get special activities too, in case they are ever used
        const allSpecialActivities = app1Data.specialActivities || [];
        allDivisions = app1Data.availableDivisions || [];
        
        // 3. Process data for our UI
        fieldsBySport = {};
        // Only fields (not specials) can have sports
        allFields.forEach(f => {
            (f.activities || []).forEach(sport => {
                fieldsBySport[sport] = fieldsBySport[sport] || [];
                fieldsBySport[sport].push(f.name);
            });
        });
    }

    /**
     * Saves our data to global settings
     */
    function saveData() {
        window.saveGlobalSettings?.("specialtyLeagues", specialtyLeagues);
    }

    /**
     * Generate a unique ID for a new league
     */
    function uid() {
        return `sl_${Math.random().toString(36).slice(2, 9)}`;
    }

    /**
     * Main entry point, called by index.html
     */
    function initSpecialtyLeagues() {
        const container = document.getElementById("specialtyLeaguesContainer");
        if (!container) return;

        loadData();
        container.innerHTML = ""; // Clear

        // --- 1. "Add New" Form ---
        const addForm = document.createElement("div");
        addForm.className = "league-section"; // Reuse style from leagues.css
        addForm.style.background = "#fdfdfd";

        addForm.innerHTML = `
            <h3 style="margin-top:0;">Add New Specialty League</h3>
            <label style="display:block; margin-bottom: 5px; font-weight: 600;">League Name:</label>
            <input type="text" id="sl_name" placeholder="e.g., 5th Grade Basketball" style="width: 250px;">
            <button id="sl_addBtn" style="margin-left: 8px;">Add League</button>
        `;

        container.appendChild(addForm);

        document.getElementById("sl_addBtn").onclick = () => {
            const nameInput = document.getElementById("sl_name");
            const name = nameInput.value.trim();
            if (!name) return alert("Please enter a name.");
            if (Object.values(specialtyLeagues).some(l => l.name === name)) {
                return alert("A league with this name already exists.");
            }

            const newId = uid();
            specialtyLeagues[newId] = {
                id: newId,
                name: name,
                divisions: [],
                sport: null,
                fields: [],
                teams: [],
                enabled: true
            };
            saveData();
            initSpecialtyLeagues(); // Re-render
        };

        // --- 2. Render Existing Leagues ---
        Object.values(specialtyLeagues).sort((a,b) => a.name.localeCompare(b.name)).forEach(league => {
            container.appendChild(renderLeagueSection(league));
        });
    }

    /**
     * Renders the UI for a single league
     */
    function renderLeagueSection(league) {
        const section = document.createElement("div");
        section.className = "league-section"; // Reuse style
        section.style.opacity = league.enabled ? "1" : "0.85";

        const header = document.createElement("div");
        header.style.display = "flex";
        header.style.justifyContent = "space-between";
        header.style.alignItems = "center";
        header.innerHTML = `
            <h3 style="margin: 0;">${league.name}</h3>
            <div>
                <label class="switch" style="margin-right: 15px;">
                    <input type="checkbox" ${league.enabled ? "checked" : ""}>
                    <span class="slider"></span>
                </label>
                <button data-act="delete" style="background:transparent; border:none; font-size: 1.2em; cursor:pointer;">🗑️</button>
            </div>
        `;

        header.querySelector('input[type="checkbox"]').onchange = (e) => {
            league.enabled = e.target.checked;
            section.style.opacity = league.enabled ? "1" : "0.85";
            saveData();
        };

        header.querySelector('[data-act="delete"]').onclick = () => {
            if (confirm(`Are you sure you want to delete "${league.name}"?`)) {
                delete specialtyLeagues[league.id];
                saveData();
                initSpecialtyLeagues(); // Re-render
            }
        };

        section.appendChild(header);
        
        const content = document.createElement("div");
        content.style.marginTop = "10px";
        content.style.paddingTop = "10px";
        content.style.borderTop = "1px solid #eee";
        
        // --- 1. Division Picker ---
        content.appendChild(renderDivisionPicker(league));

        // --- 2. Sport Picker ---
        content.appendChild(renderSportPicker(league));

        // --- 3. Field Picker (shows *after* sport is chosen) ---
        if (league.sport) {
            content.appendChild(renderFieldPicker(league));
        }
        
        // --- 4. Team Picker ---
        content.appendChild(renderTeamPicker(league));

        section.appendChild(content);
        return section;
    }

    function renderDivisionPicker(league) {
        const wrapper = document.createElement("div");
        wrapper.innerHTML = `<label style="font-weight: 600; display:block; margin-bottom: 6px;">1. Select Divisions:</label>`;
        
        const chipBox = document.createElement("div");
        chipBox.className = "chips";
        allDivisions.forEach(divName => {
            const chip = createChip(divName, league.divisions.includes(divName));
            chip.onclick = () => {
                toggleArrayItem(league.divisions, divName);
                saveData();
                // Just update chip, no full re-render
                chip.style.backgroundColor = league.divisions.includes(divName) ? "#007BFF" : "#f0f0f0";
                chip.style.color = league.divisions.includes(divName) ? "white" : "black";
            };
            chipBox.appendChild(chip);
        });
        wrapper.appendChild(chipBox);
        return wrapper;
    }

    function renderSportPicker(league) {
        const wrapper = document.createElement("div");
        wrapper.style.marginTop = "15px";

        const allSports = Object.keys(fieldsBySport).sort();
        
        let options = `<option value="">-- 2. Select a Sport --</option>`;
        allSports.forEach(sport => {
            options += `<option value="${sport}" ${league.sport === sport ? "selected" : ""}>${sport}</option>`;
        });

        wrapper.innerHTML = `
            <label style="font-weight: 600; margin-right: 8px;">Sport:</label>
            <select>${options}</select>
        `;

        wrapper.querySelector("select").onchange = (e) => {
            league.sport = e.target.value || null;
            league.fields = []; // Reset fields if sport changes
            saveData();
            initSpecialtyLeagues(); // Re-render to show/hide field picker
        };
        return wrapper;
    }

    function renderFieldPicker(league) {
        const wrapper = document.createElement("div");
        wrapper.style.marginTop = "15px";
        
        const availableFields = fieldsBySport[league.sport] || [];
        
        wrapper.innerHTML = `<label style="font-weight: 600; display:block; margin-bottom: 6px;">3. Select Fields (Exclusive Lock):</label>`;
        
        if (availableFields.length === 0) {
            wrapper.innerHTML += `<p class="muted">No fields are set up for "${league.sport}" in the Fields tab.</p>`;
            return wrapper;
        }

        const chipBox = document.createElement("div");
        chipBox.className = "chips";
        availableFields.forEach(fieldName => {
            const chip = createChip(fieldName, league.fields.includes(fieldName));
            chip.onclick = () => {
                toggleArrayItem(league.fields, fieldName);
                saveData();
                // Just update the chip
                chip.style.backgroundColor = league.fields.includes(fieldName) ? "#007BFF" : "#f0f0f0";
                chip.style.color = league.fields.includes(fieldName) ? "white" : "black";
            };
            chipBox.appendChild(chip);
        });
        wrapper.appendChild(chipBox);
        return wrapper;
    }

    function renderTeamPicker(league) {
        const wrapper = document.createElement("div");
        wrapper.style.marginTop = "15px";
        
        wrapper.innerHTML = `<label style="font-weight: 600; display:block; margin-bottom: 6px;">4. Add Teams:</label>`;

        // --- Add Team Input ---
        const addWrapper = document.createElement("div");
        const teamInput = document.createElement("input");
        teamInput.type = "text";
        teamInput.placeholder = "Enter team name";
        const addBtn = document.createElement("button");
        addBtn.textContent = "Add Team";
        addBtn.style.marginLeft = "8px";

        addBtn.onclick = () => {
            const teamName = teamInput.value.trim();
            if (teamName && !league.teams.includes(teamName)) {
                league.teams.push(teamName);
                league.teams.sort();
                saveData();
                initSpecialtyLeagues(); // Re-render this tab
            }
            teamInput.value = "";
        };
        teamInput.onkeypress = (e) => { if (e.key === "Enter") addBtn.click(); };

        addWrapper.appendChild(teamInput);
        addWrapper.appendChild(addBtn);
        wrapper.appendChild(addWrapper);

        // --- Team List ---
        const chipBox = document.createElement("div");
        chipBox.className = "chips";
        chipBox.style.marginTop = "8px";
        
        if (league.teams.length === 0) {
            chipBox.innerHTML = `<span class="muted" style="font-size:0.9em;">No teams added yet.</span>`;
        }
        
        league.teams.forEach(teamName => {
            const chip = createChip(`${teamName} ✖`, true, "#5bc0de"); // Light blue
            chip.onclick = () => {
                toggleArrayItem(league.teams, teamName);
                saveData();
                initSpecialtyLeagues(); // Re-render
            };
            chipBox.appendChild(chip);
        });
        wrapper.appendChild(chipBox);
        return wrapper;
    }


    // --- UI Helpers ---
    function createChip(name, isActive, activeColor = "#007BFF") {
        const chip = document.createElement("span");
        chip.textContent = name;
        chip.style.padding = "4px 8px";
        chip.style.borderRadius = "12px";
        chip.style.cursor = "pointer";
        chip.style.border = "1px solid #ccc";
        chip.style.backgroundColor = isActive ? activeColor : "#f0f0f0";
        chip.style.color = isActive ? "white" : "black";
        chip.style.borderColor = isActive ? activeColor : "#ccc";
        return chip;
    }
    
    function toggleArrayItem(arr, item) {
        const idx = arr.indexOf(item);
        if (idx > -1) {
            arr.splice(idx, 1);
        } else {
            arr.push(item);
        }
    }

    window.initSpecialtyLeagues = initSpecialtyLeagues;

})();
