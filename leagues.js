// ===================================================================
// leagues.js
//
// UPDATED (11/16):
// - **REMOVED:** Removed "GENERATE ULTIMATE ROTATION" button and
//   the "ultimate-preview" panel, as requested.
// - **NEW:** Added a division chip picker to the `editLeague`
//   view, allowing selection of divisions (e.g., grades) for
//   each league. It pulls divisions from `window.availableDivisions`.
// - **NEW:** Replaced the sports `<select>` box with the same
//   "activity-button" chip interface from fields.js.
// - **NEW:** Added an "Add new sport" input that calls
//   `window.addGlobalSport()` and re-renders the editor.
// ===================================================================

(function () {
    'use strict';

    // Global league store
    let leaguesByName = {};
    window.leaguesByName = leaguesByName;

    // Round state (per league per day)
    let leagueRoundState = {};
    window.leagueRoundState = leagueRoundState;

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
    // Round Robin (fallback)
    // ---------------------------------------------------------------
    function generateRoundRobin(teams) {
        const t = teams.map(String);
        if (t.length < 2) return [];

        const n = t.length;
        const rounds = [];

        for (let r = 0; r < n - 1; r++) {
            const round = [];
            for (let i = 0; i < n / 2; i++) {
                const a = t[i];
                const b = t[(n - 1 - i + r) % (n - 1)];
                if (a !== "BYE" && b !== "BYE") round.push([a, b]);
            }
            rounds.push(round);
        }
        return rounds;
    }

    // ---------------------------------------------------------------
    // Main init
    // ---------------------------------------------------------------
    window.initLeagues = function () {
        loadLeaguesData(); // Load league setup first
        loadRoundState(); // Then load daily state
        renderLeaguesTab();
    };

    // ---------------------------------------------------------------
    // MAIN TAB RENDERER (UPDATED)
    // ---------------------------------------------------------------
    function renderLeaguesTab() {
        const container = document.getElementById("leagues");
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
    // LEAGUE LIST
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

        list.innerHTML = keys.map(name => {
            const l = leaguesByName[name];
            return `
                <div style="padding:16px; background:white; border:1px solid #ddd;
                            border-radius:10px; cursor:pointer; box-shadow:0 2px 5px rgba(0,0,0,0.1);"
                     onclick="editLeague('${name}')">
                    <h3 style="margin:0 0 8px 0; color:#1a5fb4;">${name}</h3>
                    <p style="margin:0; color:#555;">Teams: ${l.teams?.length || 0}</p>
                    <p style="margin:0; color:#555;">Sports: ${l.sports?.length || 0}</p>
                    <p style="margin:0; color:#555;">Divisions: ${l.divisions?.length || 0}</p>
                </div>
            `;
        }).join("");
    }

    // ---------------------------------------------------------------
    // CREATE LEAGUE
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
            standings: {},
            enabled: true // Added for consistency
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
        if (!editor) return;

        editor.style.display = "block";

        // --- Get data from other modules ---
        const allSports = window.getAllGlobalSports?.() || [];
        const allDivisions = window.availableDivisions || [];

        editor.innerHTML = `
            <h2 style="color:#1a5fb4;">Editing: ${name}</h2>
            <button onclick="deleteLeague('${name}')"
                style="float:right; background:#d40000; color:white; padding:6px 12px;
                       border:none; border-radius:6px; cursor:pointer;">
                Delete
            </button>

            <h3 style="margin-top:20px;">Divisions:</h3>
            <p class="muted" style="font-size: 0.9em; margin: 0 0 8px 0;">Select which divisions this league applies to.</p>
            <div id="league-division-picker" class="chips"></div>

            <h3 style="margin-top:20px;">Teams:</h3>
            <div id="team-picker"></div>

            <h3 style="margin-top:20px;">Sports:</h3>
            <p class="muted" style="font-size: 0.9em; margin: 0 0 8px 0;">Select which sports are playable in this league.</p>
            <div id="sport-button-wrapper" style="display: flex; flex-wrap: wrap; gap: 5px;">
                </div>
            <input id="sport-add-new" placeholder="Add new sport type" style="margin-top: 8px;">

            `;

        // --- Render Division Chips ---
        const divisionPicker = document.getElementById("league-division-picker");
        allDivisions.forEach(divName => {
            const chip = createChip(divName, league.divisions.includes(divName));
            chip.onclick = () => {
                toggleArrayItem(league.divisions, divName);
                saveLeaguesData();
                editLeague(name); // Re-render to update chip state
            };
            divisionPicker.appendChild(chip);
        });

        // --- Render Team Picker (Unchanged) ---
        renderTeamPicker(name, league.teams);

        // --- Render Sports Picker ---
        const sportWrapper = document.getElementById("sport-button-wrapper");
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

        // --- Hook up "Add new sport" input ---
        const otherSportInput = document.getElementById("sport-add-new");
        otherSportInput.onkeyup = e => {
            if (e.key === "Enter" && otherSportInput.value.trim()) {
                const newSport = otherSportInput.value.trim();
                
                // 1. Register the sport globally
                window.addGlobalSport?.(newSport);
                
                // 2. Add it to this league's list
                if (!league.sports.includes(newSport)) {
                    league.sports.push(newSport);
                    saveLeaguesData();
                }
                
                // 3. Clear input and re-render
                otherSportInput.value = "";
                editLeague(name);
            }
        };

        // --- "GENERATE" button handler REMOVED ---
    };

    // ---------------------------------------------------------------
    // UI HELPERS
    // ---------------------------------------------------------------

    /**
     * Helper: Creates a toggle chip
     */
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

    /**
     * Helper: Toggles an item in an array
     */
    function toggleArrayItem(arr, item) {
        const idx = arr.indexOf(item);
        if (idx > -1) {
            arr.splice(idx, 1);
        } else {
            arr.push(item);
        }
    }

    // ---------------------------------------------------------------
    // TEAM PICKER (Unchanged)
    // ---------------------------------------------------------------
    function renderTeamPicker(leagueName, selectedTeams) {
        const container = document.getElementById("team-picker");
        container.innerHTML = ""; // Clear

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
                    saveLeaguesData();
                }
                editLeague(leagueName);
            }
        };
        container.appendChild(input);
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
    // PREVIEW TABLE (REMOVED)
    // ---------------------------------------------------------------
    // function showUltimatePreview(...) REMOVED

    // ---------------------------------------------------------------
    // SAVE / LOAD LEAGUES
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
        });
        
        window.leaguesByName = leaguesByName;
    }

    // ---------------------------------------------------------------
    // Initialize on script load
    // ---------------------------------------------------------------
    loadLeaguesData();
    loadRoundState();
})();
