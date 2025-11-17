// ===================================================================
// leagues.js
//
// UPDATED (UI Overhaul & Standings):
// - Added "Manage Standings" functionality, identical to specialty_leagues.js.
// - The editor UI now matches specialty_leagues.js (editor pane,
//   enabled toggle, delete button, and standings modal).
// - Standings (W/L/T) are now saved for each team in each league.
// - `loadData`, `createNewLeague`, and `renderTeamPicker` have been
//   updated to initialize and manage the `standings` object.
// ===================================================================

(function () {
    'use strict';

    // Global league store
    let leaguesByName = {};
    window.leaguesByName = leaguesByName;

    // Round state (per league per day)
    let leagueRoundState = {};
    window.leagueRoundState = leagueRoundState;

    /**
     * Helper: Gets the suffix for a place number (1st, 2nd, 3rd)
     */
    function getPlaceSuffix(n) {
        const s = ["th", "st", "nd", "rd"];
        const v = n % 100;
        return (s[(v - 20) % 10] || s[v] || s[0]);
    }

    // ---------------------------------------------------------------
    // Load & Save Round State
    // ---------------------------------------------------------------

    function loadRoundState() {
        try {
            const data = window.loadCurrentDailyData?.() || {};
            leagueRoundState = data.leagueRoundState || {};
            window.leagueRoundState = leagueRoundState;
        } catch (e) {
            leagueRoundState = {};
            window.leagueRoundState = {};
        }
    }

    function saveRoundState() {
        // Note: This is saved by scheduler_logic_core.js now.
        // This function is kept for potential future use.
    }

    // ---------------------------------------------------------------
    // Round Robin (fallback) - NO LONGER USED, core logic handles
    // ---------------------------------------------------------------
    
    // ---------------------------------------------------------------
    // Main init
    // ---------------------------------------------------------------
    window.initLeagues = function () {
        loadLeaguesData(); // Load league setup first
        loadRoundState(); // Then load daily state
        renderLeaguesTab();
    };

    // ---------------------------------------------------------------
    // MAIN TAB RENDERER (Unchanged)
    // ---------------------------------------------------------------
    function renderLeaguesTab() {
        const container = document.getElementById("leaguesContainer"); // Use the correct ID from index.html
        if (!container) return;

        container.innerHTML = `
            <div style="padding:20px; font-family:Arial;">
                <h1 style="color:#1a5fb4;">League Manager</h1>
                <p style="color:#444;">Create and manage leagues for the scheduler.</p>

                <button id="new-league-btn"
                    style="padding:10px 20px; background:#1a5fb4; color:white;
                           border:none; border-radius:6px; cursor:pointer;">
                    + Create New League
                </button>

                <div id="league-list"
                    style="margin-top:20px; display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:15px;">
                </div>

                <div id="league-editor"
                    style="margin-top:30px; padding:20px; border:2px solid #1a5fb4;
                           border-radius:10px; background:#f8faff; display:none;">
                </div>

                </div>
        `;

        document.getElementById("new-league-btn").onclick = () => createNewLeague();
        renderLeagueList();
    }

    // ---------------------------------------------------------------
    // LEAGUE LIST (Updated)
    // ---------------------------------------------------------------
    function renderLeagueList() {
        const list = document.getElementById("league-list");
        const keys = Object.keys(leaguesByName);

        if (keys.length === 0) {
            list.innerHTML = `
                <p style="grid-column:1/-1; text-align:center; color:#777;">
                    No leagues created yet.
                </p>`;
            return;
        }

        list.innerHTML = keys.sort().map(name => {
            const l = leaguesByName[name];
            return `
                <div style="padding:16px; background:white; border:1px solid #ddd;
                            border-radius:10px; cursor:pointer; box-shadow:0 2px 5px rgba(0,0,0,0.1);
                            opacity: ${l.enabled ? '1' : '0.6'};"
                     onclick="window.editLeague('${name}')">
                    <h3 style="margin:0 0 8px 0; color:#1a5fb4;">${name}</h3>
                    <p style="margin:0; color:#555;">Teams: ${l.teams?.length || 0}</p>
                    <p style="margin:0; color:#555;">Sports: ${l.sports?.length || 0}</p>
                    <p style="margin:0; color:#555;">Divisions: ${l.divisions?.length || 0}</p>
                </div>
            `;
        }).join("");
    }

    // ---------------------------------------------------------------
    // CREATE LEAGUE (Updated)
    // ---------------------------------------------------------------
    function createNewLeague() {
        const name = prompt("Enter league name:");
        if (!name) return;

        const clean = name.trim();
        if (leaguesByName[clean]) {
            alert("League already exists!");
            return;
        }

        leaguesByName[clean] = {
            teams: [],
            sports: [],
            divisions: [],
            standings: {}, // --- NEW ---
            enabled: true
        };

        saveLeaguesData();
        renderLeagueList();
        editLeague(clean);
    }

    // ---------------------------------------------------------------
    // EDIT LEAGUE UI (HEAVILY UPDATED)
    // ---------------------------------------------------------------
    window.editLeague = function (name) {
        const league = leaguesByName[name];
        const editor = document.getElementById("league-editor");
        if (!editor || !league) return;

        editor.style.display = "block";

        // --- Get data from other modules ---
        const allSports = window.getAllGlobalSports?.() || [];
        const allDivisions = window.availableDivisions || [];

        editor.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                <h2 style="color:#1a5fb4; margin-top:0;">Editing: ${name}</h2>
                <div>
                    <button id="l-standings-btn" style="padding:8px 12px; background:#28a745; color:white; border:none; border-radius:6px; cursor:pointer; margin-right: 10px;">
                        Manage Standings
                    </button>
                    <button id="l-delete-btn" style="background:#d40000; color:white; padding:8px 12px; border:none; border-radius:6px; cursor:pointer;">
                        Delete
                    </button>
                </div>
            </div>
            
            <div id="l-standings-ui" style="display:none; margin-top:15px; padding:15px; border:1px solid #ccc; border-radius:8px; background:#fff;">
                <!-- Standings UI will be injected here -->
            </div>

            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:15px;">
                <label style="font-weight:600;">Enabled:</label>
                <label class="switch">
                    <input type="checkbox" id="l-enabled-toggle" ${league.enabled ? "checked" : ""}>
                    <span class="slider"></span>
                </label>
            </div>
            
            <div id="l-editor-content" style="margin-top:10px; padding-top:10px; border-top:1px solid #eee;">
                <!-- Pickers will be injected here -->
            </div>
            `;

        const content = document.getElementById("l-editor-content");

        // --- Render Division Chips ---
        const divisionPicker = document.createElement("div");
        divisionPicker.innerHTML = `<h3 style="margin-top:10px;">Divisions:</h3>
            <p class="muted" style="font-size: 0.9em; margin: 0 0 8px 0;">Select which divisions this league applies to.</p>`;
        const divisionChipBox = document.createElement("div");
        divisionChipBox.className = "chips";
        
        allDivisions.forEach(divName => {
            const chip = createChip(divName, league.divisions.includes(divName));
            chip.onclick = () => {
                toggleArrayItem(league.divisions, divName);
                saveLeaguesData();
                editLeague(name); // Re-render to update chip state
            };
            divisionChipBox.appendChild(chip);
        });
        divisionPicker.appendChild(divisionChipBox);
        content.appendChild(divisionPicker);

        // --- Render Team Picker ---
        const teamPicker = document.createElement("div");
        teamPicker.innerHTML = `<h3 style="margin-top:20px;">Teams:</h3>`;
        content.appendChild(teamPicker);
        renderTeamPicker(name, league.teams, teamPicker);

        // --- Render Sports Picker ---
        const sportPicker = document.createElement("div");
        sportPicker.innerHTML = `<h3 style="margin-top:20px;">Sports:</h3>
            <p class="muted" style="font-size: 0.9em; margin: 0 0 8px 0;">Select which sports are playable in this league.</p>`;
        
        const sportWrapper = document.createElement("div");
        sportWrapper.style.display = "flex";
        sportWrapper.style.flexWrap = "wrap";
        sportWrapper.style.gap = "5px";
        
        allSports.forEach(act => {
            const b = document.createElement("button"); 
            b.textContent = act; 
            b.className = "activity-button";
            if (league.sports.includes(act)) b.classList.add("active");
            b.onclick = () => {
                toggleArrayItem(league.sports, act);
                saveLeaguesData(); 
                editLeague(name); // Re-render to update chip state
            };
            sportWrapper.appendChild(b);
        });
        sportPicker.appendChild(sportWrapper);

        // --- Hook up "Add new sport" input ---
        const otherSportInput = document.createElement("input");
        otherSportInput.placeholder = "Add new sport type";
        otherSportInput.style.marginTop = "8px";
        otherSportInput.onkeyup = e => {
            if (e.key === "Enter" && otherSportInput.value.trim()) {
                const newSport = otherSportInput.value.trim();
                
                window.addGlobalSport?.(newSport);
                
                if (!league.sports.includes(newSport)) {
                    league.sports.push(newSport);
                    saveLeaguesData();
                }
                
                otherSportInput.value = "";
                editLeague(name);
            }
        };
        sportPicker.appendChild(otherSportInput);
        content.appendChild(sportPicker);
        
        // --- Hook up buttons ---
        document.getElementById("l-delete-btn").onclick = () => deleteLeague(name);
        
        document.getElementById("l-enabled-toggle").onchange = (e) => {
            league.enabled = e.target.checked;
            saveLeaguesData();
            renderLeagueList(); // Update opacity on card
        };
        
        const standingsBtn = document.getElementById("l-standings-btn");
        const standingsUI = document.getElementById("l-standings-ui");
        
        standingsBtn.onclick = () => {
            const isVisible = standingsUI.style.display === 'block';
            if (isVisible) {
                standingsUI.style.display = 'none';
                standingsBtn.textContent = 'Manage Standings';
            } else {
                standingsUI.innerHTML = ''; // Clear
                standingsUI.appendChild(renderLeagueStandingsUI(name)); // Render content
                standingsUI.style.display = 'block';
                standingsBtn.textContent = 'Close Standings';
            }
        };
    };

    // ---------------------------------------------------------------
    // UI HELPERS
    // ---------------------------------------------------------------

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

    // ---------------------------------------------------------------
    // TEAM PICKER (Updated)
    // ---------------------------------------------------------------
    function renderTeamPicker(leagueName, selectedTeams, container) {
        
        (selectedTeams || []).forEach(team => {
            const btn = document.createElement("button");
            btn.textContent = team;
            btn.style.padding = "6px 12px";
            btn.style.margin = "3px";
            btn.style.borderRadius = "6px";
            btn.style.border = "1px solid #555";
            btn.style.background = "#fff";
            btn.style.cursor = "pointer";
            btn.title = "Click to remove team";

            btn.onclick = () => {
                delete leaguesByName[leagueName].standings[team]; // --- NEW ---
                leaguesByName[leagueName].teams =
                    leaguesByName[leagueName].teams.filter(t => t !== team);
                saveLeaguesData();
                editLeague(leagueName);
            };

            container.appendChild(btn);
        });

        const input = document.createElement("input");
        input.placeholder = "Add team...";
        input.style.marginTop = "10px";
        input.onkeypress = e => {
            if (e.key === "Enter") {
                const val = input.value.trim();
                if (!val) return;
                if (!leaguesByName[leagueName].teams) {
                    leaguesByName[leagueName].teams = [];
                }
                if (!leaguesByName[leagueName].teams.includes(val)) {
                    leaguesByName[leagueName].teams.push(val);
                    leaguesByName[leagueName].standings[val] = { w: 0, l: 0, t: 0 }; // --- NEW ---
                    saveLeaguesData();
                }
                editLeague(leagueName);
            }
        };
        container.appendChild(input);
    }

    // ---------------------------------------------------------------
    // STANDINGS UI (NEW)
    // ---------------------------------------------------------------
    /**
     * Renders the Standings UI *for one league*
     */
    function renderLeagueStandingsUI(leagueName) {
        const league = leaguesByName[leagueName];
        const container = document.createElement("div");

        if (!league || !league.teams || league.teams.length === 0) {
            container.innerHTML = '<p class="muted" style="padding: 10px;">No teams found. Add teams in the editor to manage standings.</p>';
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
                <td><input type="number" min="0" value="${teamData.w}" data-league-name="${leagueName}" data-team="${teamName}" data-record="w"></td>
                <td><input type="number" min="0" value="${teamData.l}" data-league-name="${leagueName}" data-team="${teamName}" data-record="l"></td>
                <td><input type="number" min="0" value="${teamData.t}" data-league-name="${leagueName}" data-team="${teamName}" data-record="t"></td>
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
                const lName = input.dataset.leagueName;
                const teamName = input.dataset.team;
                const recordType = input.dataset.record;
                const value = parseInt(input.value, 10) || 0;

                if (leaguesByName[lName] && leaguesByName[lName].standings[teamName]) {
                    if (leaguesByName[lName].standings[teamName][recordType] !== value) {
                        leaguesByName[lName].standings[teamName][recordType] = value;
                        changed = true;
                    }
                }
            });

            if (changed) {
                saveLeaguesData();
                // Re-render the standings UI
                const standingsUI = document.getElementById("l-standings-ui");
                standingsUI.innerHTML = ''; // Clear
                standingsUI.appendChild(renderLeagueStandingsUI(leagueName)); // Re-render
                alert(`Standings for ${leagueName} updated and saved!`);
            } else {
                alert("No changes detected.");
            }
        };
        container.appendChild(updateBtn);
        return container;
    }

    // ---------------------------------------------------------------
    // DELETE LEAGUE
    // ---------------------------------------------------------------
    window.deleteLeague = function (name) {
        if (!confirm(`Are you sure you want to delete "${name}"?`)) return;

        delete leaguesByName[name];
        saveLeaguesData();
        renderLeagueList();
        document.getElementById("league-editor").style.display = "none";
    };

    // ---------------------------------------------------------------
    // SAVE / LOAD LEAGUES (Updated)
    // ---------------------------------------------------------------
    function saveLeaguesData() {
        const global = window.loadGlobalSettings?.() || {};
        global.leaguesByName = leaguesByName;
        window.saveGlobalSettings?.(global);
        window.leaguesByName = leaguesByName;
    }

    function loadLeaguesData() {
        const global = window.loadGlobalSettings?.() || {};
        leaguesByName = global.leaguesByName || {};
        
        // Ensure new properties exist on old data
        Object.values(leaguesByName).forEach(l => {
            l.divisions = l.divisions || [];
            l.sports = l.sports || [];
            l.teams = l.teams || [];
            l.enabled = l.enabled !== false;
            // --- NEW: Initialize standings ---
            l.standings = l.standings || {};
            (l.teams || []).forEach(team => {
                l.standings[team] = l.standings[team] || { w: 0, l: 0, t: 0 };
            });
        });
        
        window.leaguesByName = leaguesByName;
    }

    // ---------------------------------------------------------------
    // Initialize on script load
    // ---------------------------------------------------------------
    loadLeaguesData();
    loadRoundState();
})();
