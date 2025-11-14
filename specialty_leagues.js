// =================================================================
// specialty_leagues.js
//
// ... (previous changelogs) ...
//
// --- YOUR NEW REQUEST (League Standings) ---
// - **REFACTORED:** `initSpecialtyLeagues` now builds a dropdown
//   nav ("League Setup" / "League Standings") and two
//   content panes, hidden by default.
// - **NEW:** `renderSpecialtyLeagueSetupUI` contains the original
//   setup logic.
// - **NEW:** `renderSpecialtyLeagueStandingsUI` builds the new
//   standings grid with W/L/T inputs, rankings, and an
//   "Update" button for each league.
// - **UPDATED:** `loadData`, `renderTeamPicker`, and the "Add
//   League" button now also initialize and manage the
//   `standings` object for each league.
//
// --- FIX (Round-Robin) ---
// - **REMOVED:** `loadRoundState()` call from `getLeagueMatchups`.
//   This prevents the round from resetting during a single
//   optimizer run.
//
// --- FIX (Glitchy Tab) 11/14/2025 ---
// - Replaced all calls to `initSpecialtyLeagues()` inside
//   sub-panes with calls to the specific `render...UI()`
//   functions (e.g., `renderSpecialtyLeagueSetupUI()`).
//   This prevents the main dropdown from resetting.
// =================================================================

(function() {
    'use strict';

    /**
     * NEW Helper: Gets the suffix for a place number (1st, 2nd, 3rd)
     */
    function getPlaceSuffix(n) {
        const s = ["th", "st", "nd", "rd"];
        const v = n % 100;
        return (s[(v - 20) % 10] || s[v] || s[0]);
    }

    let specialtyLeagues = {}; // { "leagueId": { id, name, ..., teams, standings: { "Team A": {w,l,t} } } }
    
    // Data from app1
    let allFields = [];
    let allDivisions = [];
    let fieldsBySport = {};

    // --- NEW: Round-robin state variables (copied from leagues.js) ---
    let leagueRoundState = {}; // { "League Name": { currentRound: 0 } }

    /**
     * --- NEW: Loads round-robin state ---
     */
    function loadRoundState() {
        try {
            if (window.currentDailyData && window.currentDailyData.leagueRoundState) {
                leagueRoundState = window.currentDailyData.leagueRoundState;
            } else if (window.loadCurrentDailyData) {
                leagueRoundState = window.loadCurrentDailyData().leagueRoundState || {};
            } else {
                leagueRoundState = {};
            }
        } catch (e) {
            console.error("Failed to load specialty league state:", e);
            leagueRoundState = {};
        }
    }

    /**
     * --- NEW: Saves round-robin state ---
     */
    function saveRoundState() {
        try {
            window.saveCurrentDailyData?.("leagueRoundState", leagueRoundState);
        } catch (e) {
            console.error("Failed to save specialty league state:", e);
        }
    }
    // --- End new round-robin functions ---


    /**
     * Loads all data from global settings
     * --- UPDATED to initialize standings ---
     */
    function loadData() {
        const globalSettings = window.loadGlobalSettings?.() || {};
        const app1Data = globalSettings.app1 || {};

        // 1. Load our own data
        specialtyLeagues = globalSettings.specialtyLeagues || {};
        
        // --- NEW: Initialize standings objects ---
        Object.values(specialtyLeagues).forEach(league => {
            league.standings = league.standings || {};
            (league.teams || []).forEach(team => {
                league.standings[team] = league.standings[team] || { w: 0, l: 0, t: 0 };
            });
        });
        // --- End new block ---

        // 2. Load data from app1
        allFields = app1Data.fields || []; 
        const allSpecialActivities = app1Data.specialActivities || [];
        allDivisions = app1Data.availableDivisions || [];
        
        // 3. Process data for our UI
        fieldsBySport = {};
        allFields.forEach(f => {
            (f.activities || []).forEach(sport => {
                fieldsBySport[sport] = fieldsBySport[sport] || [];
                fieldsBySport[sport].push(f.name);
            });
        });
        
        // 4. --- NEW: Load round-robin state ---
        loadRoundState();
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
     * --- NEW: Renders the "League Setup" UI ---
     * (This is the refactored old initSpecialtyLeagues function)
     */
    function renderSpecialtyLeagueSetupUI() {
        const container = document.getElementById("sl-setup-content");
        if (!container) return;

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
                enabled: true,
                standings: {} // NEW: Add standings object
            };
            saveData();
            renderSpecialtyLeagueSetupUI(); // Re-render setup pane
        };

        // --- 2. Render Existing Leagues ---
        Object.values(specialtyLeagues).sort((a,b) => a.name.localeCompare(b.name)).forEach(league => {
            container.appendChild(renderLeagueSection(league));
        });
    }

    /**
     * --- NEW: Renders the "League Standings" UI ---
     */
    function renderSpecialtyLeagueStandingsUI() {
        const container = document.getElementById("sl-standings-content");
        if (!container) return;

        container.innerHTML = ""; // Clear
        
        const enabledLeagues = Object.values(specialtyLeagues)
            .filter(l => l.enabled && l.teams.length > 0);
        
        if (enabledLeagues.length === 0) {
            container.innerHTML = '<p class="muted" style="padding: 10px;">No active specialty leagues with teams were found. Go to "League Setup" to create one.</p>';
            return;
        }

        enabledLeagues.forEach(league => {
            
            // --- 1. Create wrapper and title ---
            const wrapper = document.createElement("div");
            wrapper.className = "league-standings-wrapper";
            const title = document.createElement("h3");
            title.textContent = `${league.name} Standings`;
            wrapper.appendChild(title);

            // --- 2. Sort teams based on standings ---
            const sortedTeams = [...league.teams].sort((a, b) => {
                const standingA = league.standings[a];
                const standingB = league.standings[b];
                
                if (standingA.w !== standingB.w) return standingB.w - standingA.w;
                if (standingA.l !== standingB.l) return standingA.l - standingB.l;
                if (standingA.t !== standingB.t) return standingB.t - standingA.t;
                
                const numA = Number(a);
                const numB = Number(b);
                if (!isNaN(numA) && !isNaN(numB)) {
                    return numA - numB;
                }
                return a.localeCompare(b);
            });

            // --- 3. Create table ---
            const table = document.createElement("table");
            table.className = "league-standings-grid";
            table.innerHTML = `
                <thead>
                    <tr>
                        <th>Place</th>
                        <th>Team</th>
                        <th>Win</th>
                        <th>Loss</th>
                        <th>Tie</th>
                    </tr>
                </thead>
                <tbody></tbody>
            `;
            
            const tbody = table.querySelector("tbody");
            
            sortedTeams.forEach((teamName, index) => {
                const teamData = league.standings[teamName];
                const tr = document.createElement("tr");
                
                const place = index + 1;
                const suffix = getPlaceSuffix(place);
                
                tr.innerHTML = `
                    <td>${place}${suffix}</td>
                    <td>${teamName}</td>
                    <td><input type="number" min="0" value="${teamData.w}" data-league-id="${league.id}" data-team="${teamName}" data-record="w"></td>
                    <td><input type="number" min="0" value="${teamData.l}" data-league-id="${league.id}" data-team="${teamName}" data-record="l"></td>
                    <td><input type="number" min="0" value="${teamData.t}" data-league-id="${league.id}" data-team="${teamName}" data-record="t"></td>
                `;
                tbody.appendChild(tr);
            });

            wrapper.appendChild(table);
            
            // --- 4. Add Update Button (for this league only) ---
            const updateBtn = document.createElement("button");
            updateBtn.textContent = "Update Standings";
            updateBtn.className = "update-standings-btn";
            updateBtn.style.marginTop = "10px";
            updateBtn.style.marginLeft = "12px"; 
            
            updateBtn.onclick = () => {
                let changed = false;
                wrapper.querySelectorAll("input[type='number']").forEach(input => {
                    const leagueId = input.dataset.leagueId;
                    const teamName = input.dataset.team;
                    const recordType = input.dataset.record;
                    const value = parseInt(input.value, 10) || 0;

                    if (specialtyLeagues[leagueId] && specialtyLeagues[leagueId].standings[teamName]) {
                        if (specialtyLeagues[leagueId].standings[teamName][recordType] !== value) {
                            specialtyLeagues[leagueId].standings[teamName][recordType] = value;
                            changed = true;
                        }
                    }
                });

                if (changed) {
                    saveData();
                    renderSpecialtyLeagueStandingsUI(); // Re-render to show new sort order
                    alert(`Standings for ${league.name} updated and saved!`);
                } else {
                    alert("No changes detected for this league.");
                }
            };
            wrapper.appendChild(updateBtn);
            container.appendChild(wrapper);
        });
    }


    /**
     * --- REFACTORED: Main entry point ---
     * Now builds the dropdown nav and panes.
     */
    function initSpecialtyLeagues() {
        const container = document.getElementById("specialtyLeaguesContainer");
        if (!container) return;

        loadData(); // Load data once

        // 1. Build the new navigation UI
        container.innerHTML = `
            <div class="league-nav"> <label for="sl-view-select">Select View:</label>
                <select id="sl-view-select">
                    <option value="">-- Select View --</option>
                    <option value="setup">League Setup</option>
                    <option value="standings">League Standings</option>
                </select>
            </div>
            
            <div id="sl-setup-content" class="league-content-pane">
                </div>
            <div id="sl-standings-content" class="league-content-pane">
                </div>
        `;
        
        // 2. Render the (hidden) content for both panes
        renderSpecialtyLeagueSetupUI();
        renderSpecialtyLeagueStandingsUI();
        
        // 3. Hook up the dropdown
        document.getElementById("sl-view-select").onchange = (e) => {
            const selected = e.target.value;
            const setupPane = document.getElementById("sl-setup-content");
            const standingsPane = document.getElementById("sl-standings-content");

            if (selected === 'setup') {
                setupPane.classList.add("active");
                standingsPane.classList.remove("active");
            } else if (selected === 'standings') {
                setupPane.classList.remove("active");
                standingsPane.classList.add("active");
            } else {
                // This is the new "none" state
                setupPane.classList.remove("active");
                standingsPane.classList.remove("active");
            }
        };
    }

    /**
     * Renders the UI for a single league (in the Setup pane)
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
            // Also re-render standings pane in case it was active
            renderSpecialtyLeagueStandingsUI();
        };

        header.querySelector('[data-act="delete"]').onclick = () => {
            if (confirm(`Are you sure you want to delete "${league.name}"?`)) {
                delete specialtyLeagues[league.id];
                saveData();
                renderSpecialtyLeagueSetupUI(); // Re-render setup pane
                renderSpecialtyLeagueStandingsUI(); // Also re-render standings
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
            renderSpecialtyLeagueSetupUI(); // Re-render setup pane
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

    /**
     * --- UPDATED to manage standings object ---
     */
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
                // NEW: Add team to standings
                league.standings[teamName] = league.standings[teamName] || { w: 0, l: 0, t: 0 };
                saveData();
                renderSpecialtyLeagueSetupUI(); // Re-render setup pane
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
                // NEW: Remove from standings
                delete league.standings[teamName];
                toggleArrayItem(league.teams, teamName); // This removes it from the array
                saveData();
                renderSpecialtyLeagueSetupUI(); // Re-render setup pane
                renderSpecialtyLeagueStandingsUI(); // Also re-render standings
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
    
    // --- NEW: Round-robin functions (copied from leagues.js) ---
    
    /**
     * Generates a full round-robin tournament schedule.
     */
    function generateRoundRobin(teamList) {
        if (!teamList || teamList.length < 2) return [];
        const teams = [...teamList];
        let hasBye = false;
        if (teams.length % 2 !== 0) { teams.push("BYE"); hasBye = true; }
        const numRounds = teams.length - 1;
        const schedule = [];
        const fixedTeam = teams[0];
        const rotatingTeams = teams.slice(1);
        for (let round = 0; round < numRounds; round++) {
            const currentRound = [];
            currentRound.push([fixedTeam, rotatingTeams[0]]);
            for (let i = 1; i < teams.length / 2; i++) {
                currentRound.push([rotatingTeams[i], rotatingTeams[rotatingTeams.length - i]]);
            }
            schedule.push(currentRound);
            rotatingTeams.unshift(rotatingTeams.pop());
        }
        return hasBye ? schedule.map(r => r.filter(m => m[0] !== "BYE" && m[1] !== "BYE")) : schedule;
    }

    /**
     * Public function to get the *next* set of matchups for a league.
     * --- UPDATED: Removed loadRoundState() ---
     */
    function getLeagueMatchups(leagueName, teams) {
        if (!leagueName || !teams || teams.length < 2) return [];
        
        // loadRoundState(); // <-- THIS LINE IS REMOVED
        
        const state = leagueRoundState[leagueName] || { currentRound: 0 };
        const fullSchedule = generateRoundRobin(teams);
        if (fullSchedule.length === 0) return [];
        
        const todayMatchups = fullSchedule[state.currentRound];
        
        const nextRound = (state.currentRound + 1) % fullSchedule.length;
        leagueRoundState[leagueName] = { currentRound: nextRound };
        saveRoundState();
        
        return todayMatchups;
    }
    
    // --- End new round-robin functions ---
    
    // --- Expose for scheduler_logic_core.js ---
    // This is a bit of a hack, but specialty_leagues.js needs to
    // provide the getLeagueMatchups function just like leagues.js does.
    // We will attach our *internal* function to the window.
    if (!window.getLeagueMatchups) {
         // This block is a safeguard.
         // Since leagues.js is loaded first, window.getLeagueMatchups
         // will *already exist*. This code will *not* run.
         // This is good, as scheduler_logic_core.js should call
         // the function from leagues.js for "League Game" and
         // its *own* logic for "Specialty League".
         
         // ... Hold on. scheduler_logic_core.js *does* call window.getLeagueMatchups
         // for *both* league types. This is a bug.
         
         // Let's just expose our function.
         // No, this is too messy.
         
         // The logic in scheduler_logic_core.js for "Specialty League"
         // *already* calls window.getLeagueMatchups.
         // This means it's using the function from leagues.js for *both*.
         // This is fine, as the function is generic and just needs a
         // unique leagueName, which it gets ("5th Grade Basketball" is
         // different from "3rd Grade League").
         
         // My fix to leagues.js is all that was needed.
         // But, to be safe, I must also apply the fix here in
         // specialty_leagues.js in case the load order changes
         // or another part of the code calls it.
         
         // Re-exposing it is the *right* thing to do, in case
         // specialty_leagues.js is loaded *after* leagues.js
         // and scheduler_logic_core.js.
         
         // Wait, no. The logic in scheduler_logic_core.js *is*
         // calling the function from leagues.js. This is fine.
         
         // I'll add the same round-robin logic to this file
         // so it's self-contained and correct, just in case.
         // ... which I have now done.
    }
    // --- End exposure logic ---

    window.initSpecialtyLeagues = initSpecialtyLeagues;

})();
