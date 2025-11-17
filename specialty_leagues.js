// =================================================================
// specialty_leagues.js
//
// --- MAJOR REFACTOR (UI Overhaul) ---
// - Rewrote the entire file to match the UI/UX of leagues.js.
// - Removed the "Setup" / "Standings" dropdown.
// - The main tab now shows a card list of specialty leagues.
// - Clicking a league opens an editor pane, just like leagues.js.
// - Added a "Manage Standings" button to each league's editor,
//   which opens the standings grid in a modal-like view.
// - Kept all existing logic for pickers (division, sport, field, team).
// - Kept all existing logic for saving/loading standings data.
//
// --- FIX (Round-Robin) ---
// - Kept the fix from last time (removed loadRoundState from
//   getLeagueMatchups) to prevent round-robin resets.
// =================================================================

(function() {
    'use strict';

    /**
     * Helper: Gets the suffix for a place number (1st, 2nd, 3rd)
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

    // Round-robin state variables
    let leagueRoundState = {}; // { "League Name": { currentRound: 0 } }

    /**
     * Loads round-robin state
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
     * Saves round-robin state
     */
    function saveRoundState() {
        try {
            window.saveCurrentDailyData?.("leagueRoundState", leagueRoundState);
        } catch (e) {
            console.error("Failed to save specialty league state:", e);
        }
    }


    /**
     * Loads all data from global settings
     * (UPDATED to initialize standings)
     */
    function loadData() {
        const globalSettings = window.loadGlobalSettings?.() || {};
        const app1Data = globalSettings.app1 || {};

        // 1. Load our own data
        specialtyLeagues = globalSettings.specialtyLeagues || {};
        
        // Initialize standings objects
        Object.values(specialtyLeagues).forEach(league => {
            league.standings = league.standings || {};
            (league.teams || []).forEach(team => {
                league.standings[team] = league.standings[team] || { w: 0, l: 0, t: 0 };
            });
        });

        // 2. Load data from app1
        allFields = app1Data.fields || []; 
        allDivisions = app1Data.availableDivisions || [];
        
        // 3. Process data for our UI
        fieldsBySport = {};
        allFields.forEach(f => {
            (f.activities || []).forEach(sport => {
                fieldsBySport[sport] = fieldsBySport[sport] || [];
                fieldsBySport[sport].push(f.name);
            });
        });
        
        // 4. Load round-robin state
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
     * --- NEW: Main entry point, mimicking leagues.js ---
     */
    function initSpecialtyLeagues() {
        const container = document.getElementById("specialtyLeaguesContainer");
        if (!container) return;

        loadData(); // Load data once

        container.innerHTML = `
            <div style="padding:20px; font-family:Arial;">
                <h1 style="color:#1a5fb4;">🏆 Specialty League Manager</h1>
                <p style="color:#444;">Create dedicated leagues for a single sport (e.g., Basketball) with specific fields.</p>

                <button id="new-specialty-league-btn"
                    style="padding:10px 20px; background:#1a5fb4; color:white;
                           border:none; border-radius:6px; cursor:pointer;">
                    + Create New Specialty League
                </button>

                <div id="specialty-league-list"
                    style="margin-top:20px; display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:15px;">
                </div>

                <div id="specialty-league-editor"
                    style="margin-top:30px; padding:20px; border:2px solid #1a5fb4;
                           border-radius:10px; background:#f8faff; display:none;">
                </div>
            </div>
        `;

        document.getElementById("new-specialty-league-btn").onclick = createNewLeague;
        renderLeagueList();
    }
    
    /**
     * --- NEW: Renders the list of league cards ---
     */
    function renderLeagueList() {
        const list = document.getElementById("specialty-league-list");
        if (!list) return; // Failsafe if tab isn't visible

        const keys = Object.keys(specialtyLeagues);

        if (keys.length === 0) {
            list.innerHTML = `
                <p style="grid-column:1/-1; text-align:center; color:#777;">
                    No specialty leagues created yet.
                </p>`;
            return;
        }

        list.innerHTML = Object.values(specialtyLeagues)
            .sort((a,b) => a.name.localeCompare(b.name))
            .map(l => `
                <div style="padding:16px; background:white; border:1px solid #ddd;
                            border-radius:10px; cursor:pointer; box-shadow:0 2px 5px rgba(0,0,0,0.1);
                            opacity: ${l.enabled ? '1' : '0.6'};"
                     onclick="window.editSpecialtyLeague('${l.id}')">
                    <h3 style="margin:0 0 8px 0; color:#1a5fb4;">${l.name}</h3>
                    <p style="margin:0; color:#555;"><strong>Sport:</strong> ${l.sport || 'None'}</p>
                    <p style="margin:0; color:#555;"><strong>Divisions:</strong> ${l.divisions?.length || 0}</p>
                    <p style="margin:0; color:#555;"><strong>Teams:</strong> ${l.teams?.length || 0}</p>
                </div>
            `).join("");
    }
    
    /**
     * --- NEW: Handles creating a new league ---
     */
    function createNewLeague() {
        const name = prompt("Enter specialty league name (e.g., 5th Grade Basketball):");
        if (!name || !name.trim()) return;

        const clean = name.trim();
        if (Object.values(specialtyLeagues).some(l => l.name === clean)) {
            alert("League already exists!");
            return;
        }
        
        const newId = uid();
        specialtyLeagues[newId] = {
            id: newId,
            name: clean,
            divisions: [],
            sport: null,
            fields: [],
            teams: [],
            enabled: true,
            standings: {} // NEW: Add standings object
        };

        saveData();
        renderLeagueList();
        window.editSpecialtyLeague(newId); // Open the editor
    }

    /**
     * --- NEW: Renders the main league editor pane ---
     */
    window.editSpecialtyLeague = function (id) {
        const league = specialtyLeagues[id];
        if (!league) return;
        
        const editor = document.getElementById("specialty-league-editor");
        if (!editor) return;

        editor.style.display = "block";
        editor.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                <h2 style="color:#1a5fb4; margin-top:0;">Editing: ${league.name}</h2>
                <div>
                    <button id="sl-standings-btn" style="padding:8px 12px; background:#28a745; color:white; border:none; border-radius:6px; cursor:pointer; margin-right: 10px;">
                        Manage Standings
                    </button>
                    <button id="sl-delete-btn" style="background:#d40000; color:white; padding:8px 12px; border:none; border-radius:6px; cursor:pointer;">
                        Delete
                    </button>
                </div>
            </div>
            
            <div id="sl-standings-ui" style="display:none; margin-top:15px; padding:15px; border:1px solid #ccc; border-radius:8px; background:#fff;">
                </div>

            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:15px;">
                <label style="font-weight:600;">Enabled:</label>
                <label class="switch">
                    <input type="checkbox" id="sl-enabled-toggle" ${league.enabled ? "checked" : ""}>
                    <span class="slider"></span>
                </label>
            </div>
            
            <div id="sl-editor-content" style="margin-top:10px; padding-top:10px; border-top:1px solid #eee;">
                </div>
        `;
        
        const content = document.getElementById("sl-editor-content");
        content.appendChild(renderDivisionPicker(league));
        content.appendChild(renderSportPicker(league));
        if (league.sport) {
            content.appendChild(renderFieldPicker(league));
        }
        content.appendChild(renderTeamPicker(league));
        
        // --- Hook up buttons ---
        document.getElementById("sl-delete-btn").onclick = () => deleteLeague(id);
        
        document.getElementById("sl-enabled-toggle").onchange = (e) => {
            league.enabled = e.target.checked;
            saveData();
            renderLeagueList(); // Update opacity on card
        };
        
        const standingsBtn = document.getElementById("sl-standings-btn");
        const standingsUI = document.getElementById("sl-standings-ui");
        
        standingsBtn.onclick = () => {
            const isVisible = standingsUI.style.display === 'block';
            if (isVisible) {
                standingsUI.style.display = 'none';
                standingsBtn.textContent = 'Manage Standings';
            } else {
                standingsUI.innerHTML = ''; // Clear
                standingsUI.appendChild(renderSpecialtyLeagueStandingsUI(league)); // Render content
                standingsUI.style.display = 'block';
                standingsBtn.textContent = 'Close Standings';
            }
        };
    }

    /**
     * --- NEW: Deletes a league ---
     */
    function deleteLeague(id) {
        const league = specialtyLeagues[id];
        if (!league) return;
        
        if (!confirm(`Are you sure you want to delete "${league.name}"?`)) return;

        delete specialtyLeagues[id];
        saveData();
        renderLeagueList();
        
        const editor = document.getElementById("specialty-league-editor");
        if (editor) editor.style.display = "none";
    }

    /**
     * --- NEW: Renders the Standings UI *for one league* ---
     */
    function renderSpecialtyLeagueStandingsUI(league) {
        const container = document.createElement("div");

        if (!league.teams || league.teams.length === 0) {
            container.innerHTML = '<p class="muted" style="padding: 10px;">No teams found. Add teams in the editor below to manage standings.</p>';
            return container;
        }

        // --- 1. Sort teams based on standings ---
        const sortedTeams = [...league.teams].sort((a, b) => {
            const standingA = league.standings[a];
            const standingB = league.standings[b];
            
            if (standingA.w !== standingB.w) return standingB.w - standingA.w; // Wins (desc)
            if (standingA.l !== standingB.l) return standingA.l - standingB.l; // Losses (asc)
            if (standingA.t !== standingB.t) return standingB.t - standingA.t; // Ties (desc)
            
            return a.localeCompare(b); // Alphabetical
        });

        // --- 2. Create table ---
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
                <td><input type="number" min="0" value="${teamData.w}" data-team="${teamName}" data-record="w"></td>
                <td><input type="number" min="0" value="${teamData.l}" data-team="${teamName}" data-record="l"></td>
                <td><input type="number" min="0" value="${teamData.t}" data-team="${teamName}" data-record="t"></td>
            `;
            tbody.appendChild(tr);
        });

        container.appendChild(table);
        
        // --- 3. Add Update Button ---
        const updateBtn = document.createElement("button");
        updateBtn.textContent = "Update Standings";
        updateBtn.className = "update-standings-btn";
        updateBtn.style.marginTop = "10px";
        
        updateBtn.onclick = () => {
            let changed = false;
            container.querySelectorAll("input[type='number']").forEach(input => {
                const teamName = input.dataset.team;
                const recordType = input.dataset.record;
                const value = parseInt(input.value, 10) || 0;

                if (league.standings[teamName] && league.standings[teamName][recordType] !== value) {
                    league.standings[teamName][recordType] = value;
                    changed = true;
                }
            });

            if (changed) {
                saveData();
                // Re-render the standings UI
                const standingsUI = document.getElementById("sl-standings-ui");
                standingsUI.innerHTML = ''; // Clear
                standingsUI.appendChild(renderSpecialtyLeagueStandingsUI(league)); // Re-render
                alert(`Standings for ${league.name} updated and saved!`);
            } else {
                alert("No changes detected.");
            }
        };
        container.appendChild(updateBtn);
        return container;
    }


    /**
     * Renders the UI for a single league (in the Setup pane)
     * (These are now modular helpers)
     */
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
            window.editSpecialtyLeague(league.id); // Re-render editor
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
     * (UPDATED to manage standings object)
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
                window.editSpecialtyLeague(league.id); // Re-render editor
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
                window.editSpecialtyLeague(league.id); // Re-render editor
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
    
    // --- Round-robin functions (copied from leagues.js) ---
    
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
     * (UPDATED: Removed loadRoundState())
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

    window.initSpecialtyLeagues = initSpecialtyLeagues;

})();
