// ===================================================================
// leagues.js
//
// UPDATED:
// - FIXED: Data saving bug (now correctly persists to storage).
// - Auto-save is now instant (on keystroke) for scores.
// - State persistence (remembers active league/view) is enabled.
// ===================================================================

(function () {
    'use strict';

    let leaguesByName = {};
    window.leaguesByName = leaguesByName;

    let leagueRoundState = {};
    window.leagueRoundState = leagueRoundState;

    // --- UI State Persistence (Remembers where you were) ---
    let activeLeagueName = null; 
    let activeSubView = null;    

    function getPlaceSuffix(n) {
        const s = ["th", "st", "nd", "rd"];
        const v = n % 100;
        return (s[(v - 20) % 10] || s[v] || s[0]);
    }

    function loadRoundState() {
        try {
            const data = window.loadCurrentDailyData?.() || {};
            leagueRoundState = data.leagueRoundState || {};
            window.leagueRoundState = leagueRoundState;
        } catch (e) {
            leagueRoundState = {};
        }
    }

    // --- CRITICAL FIX: Corrected Save Function ---
    function saveLeaguesData() {
        // Saves directly to the 'leaguesByName' key in global settings
        window.saveGlobalSettings?.("leaguesByName", leaguesByName);
    }

    function loadLeaguesData() {
        const global = window.loadGlobalSettings?.() || {};
        leaguesByName = global.leaguesByName || {};
        
        // Ensure structure integrity
        Object.values(leaguesByName).forEach(l => {
            l.divisions = l.divisions || [];
            l.sports = l.sports || [];
            l.teams = l.teams || [];
            l.enabled = l.enabled !== false;
            l.standings = l.standings || {};
            l.games = l.games || []; 
            (l.teams || []).forEach(team => {
                l.standings[team] = l.standings[team] || { w: 0, l: 0, t: 0 };
            });
        });
        window.leaguesByName = leaguesByName;
    }

    window.initLeagues = function () {
        loadLeaguesData();
        loadRoundState();
        renderLeaguesTab();
        
        // --- RESTORE STATE: Re-open last viewed league ---
        if (activeLeagueName && leaguesByName[activeLeagueName]) {
            window.editLeague(activeLeagueName);
        }
    };

    function renderLeaguesTab() {
        const container = document.getElementById("leaguesContainer");
        if (!container) return;

        container.innerHTML = `
            <div style="padding:20px; font-family:Arial;">
                <h1 style="color:#1a5fb4;">League Manager</h1>
                <p style="color:#444;">Create and manage leagues. <strong>Changes save automatically.</strong></p>

                <div style="margin-bottom: 20px;">
                    <button id="new-league-btn"
                        style="padding:10px 20px; background:#1a5fb4; color:white;
                               border:none; border-radius:6px; cursor:pointer;">
                        + Create New League
                    </button>
                </div>

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
                    <p style="margin:0; color:#555;">Games Played: ${l.games?.length || 0}</p>
                </div>
            `;
        }).join("");
    }

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
            games: [], 
            enabled: true
        };

        saveLeaguesData();
        renderLeagueList();
        editLeague(clean);
    }

    window.editLeague = function (name) {
        const league = leaguesByName[name];
        const editor = document.getElementById("league-editor");
        if (!editor || !league) return;

        // Update state
        activeLeagueName = name;

        editor.style.display = "block";

        const allSports = window.getAllGlobalSports?.() || [];
        const allDivisions = window.availableDivisions || [];

        editor.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                <h2 style="color:#1a5fb4; margin-top:0;">Editing: ${name}</h2>
                <div>
                    <button id="l-standings-btn" style="padding:8px 12px; background:#28a745; color:white; border:none; border-radius:6px; cursor:pointer; margin-right: 10px;">
                        Manage Standings / Games
                    </button>
                    <button id="l-close-btn" style="background:#555; color:white; padding:8px 12px; border:none; border-radius:6px; cursor:pointer; margin-right: 10px;">
                        Close
                    </button>
                    <button id="l-delete-btn" style="background:#d40000; color:white; padding:8px 12px; border:none; border-radius:6px; cursor:pointer;">
                        Delete
                    </button>
                </div>
            </div>
            
            <div id="l-standings-ui" style="display:none; margin-top:15px; padding:15px; border:1px solid #ccc; border-radius:8px; background:#fff;">
            </div>

            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:15px;">
                <label style="font-weight:600;">Enabled:</label>
                <label class="switch">
                    <input type="checkbox" id="l-enabled-toggle" ${league.enabled ? "checked" : ""}>
                    <span class="slider"></span>
                </label>
            </div>
            
            <div id="l-editor-content" style="margin-top:10px; padding-top:10px; border-top:1px solid #eee;">
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
                saveLeaguesData(); // Auto-save
                chip.style.backgroundColor = league.divisions.includes(divName) ? "#007BFF" : "#f0f0f0";
                chip.style.color = league.divisions.includes(divName) ? "white" : "black";
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
                saveLeaguesData(); // Auto-save
                b.classList.toggle("active");
            };
            sportWrapper.appendChild(b);
        });
        sportPicker.appendChild(sportWrapper);

        const otherSportInput = document.createElement("input");
        otherSportInput.placeholder = "Add new sport type";
        otherSportInput.style.marginTop = "8px";
        otherSportInput.onkeyup = e => {
            if (e.key === "Enter" && otherSportInput.value.trim()) {
                const newSport = otherSportInput.value.trim();
                window.addGlobalSport?.(newSport);
                if (!league.sports.includes(newSport)) {
                    league.sports.push(newSport);
                    saveLeaguesData(); // Auto-save
                }
                otherSportInput.value = "";
                editLeague(name);
            }
        };
        sportPicker.appendChild(otherSportInput);
        content.appendChild(sportPicker);
        
        document.getElementById("l-close-btn").onclick = () => {
            activeLeagueName = null;
            activeSubView = null;
            editor.style.display = "none";
            renderLeagueList();
        };
        
        document.getElementById("l-delete-btn").onclick = () => deleteLeague(name);
        
        document.getElementById("l-enabled-toggle").onchange = (e) => {
            league.enabled = e.target.checked;
            saveLeaguesData(); // Auto-save
            renderLeagueList(); 
        };
        
        const standingsBtn = document.getElementById("l-standings-btn");
        const standingsUI = document.getElementById("l-standings-ui");
        
        const toggleStandings = () => {
            const isVisible = standingsUI.style.display === 'block';
            if (isVisible) {
                standingsUI.style.display = 'none';
                standingsBtn.textContent = 'Manage Standings / Games';
                activeSubView = null;
            } else {
                standingsUI.innerHTML = ''; 
                standingsUI.appendChild(renderGameResultsUI(name)); 
                standingsUI.style.display = 'block';
                standingsBtn.textContent = 'Close Standings';
                activeSubView = 'standings';
            }
        };
        standingsBtn.onclick = toggleStandings;
        
        // RESTORE SUB-VIEW IF IT WAS OPEN
        if (activeSubView === 'standings') {
            standingsUI.innerHTML = ''; 
            standingsUI.appendChild(renderGameResultsUI(name)); 
            standingsUI.style.display = 'block';
            standingsBtn.textContent = 'Close Standings';
        }
    };

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
                delete leaguesByName[leagueName].standings[team]; 
                leaguesByName[leagueName].teams = leaguesByName[leagueName].teams.filter(t => t !== team);
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
                    leaguesByName[leagueName].standings[val] = { w: 0, l: 0, t: 0 }; 
                    saveLeaguesData();
                }
                editLeague(leagueName);
            }
        };
        container.appendChild(input);
    }

    // ---------------------------------------------------------------
    // GAME RESULTS UI & LOGIC
    // ---------------------------------------------------------------
    
    function renderGameResultsUI(leagueName) {
        const league = leaguesByName[leagueName];
        const container = document.createElement("div");

        const tabNav = document.createElement("div");
        tabNav.style.marginBottom = "15px";
        tabNav.innerHTML = `
            <button id="tab-standings" style="font-weight:bold; padding:8px; margin-right:5px;">Current Standings</button>
            <button id="tab-games" style="padding:8px;">Game Results Entry</button>
        `;
        container.appendChild(tabNav);

        const standingsDiv = document.createElement("div");
        const gamesDiv = document.createElement("div");
        gamesDiv.style.display = "none";

        container.appendChild(standingsDiv);
        container.appendChild(gamesDiv);

        tabNav.querySelector("#tab-standings").onclick = () => {
            standingsDiv.style.display = "block";
            gamesDiv.style.display = "none";
            renderStandingsTable(league, standingsDiv); 
        };
        tabNav.querySelector("#tab-games").onclick = () => {
            standingsDiv.style.display = "none";
            gamesDiv.style.display = "block";
            renderGameEntryUI(league, gamesDiv);
        };

        renderStandingsTable(league, standingsDiv);

        return container;
    }

    function renderStandingsTable(league, container) {
        container.innerHTML = "";
        if (!league.teams || league.teams.length === 0) {
            container.innerHTML = '<p class="muted">No teams to display.</p>';
            return;
        }

        recalcStandings(league); 

        const sortedTeams = [...league.teams].sort((a, b) => {
            const sA = league.standings[a] || {w:0, l:0, t:0};
            const sB = league.standings[b] || {w:0, l:0, t:0};
            
            if (sA.w !== sB.w) return sB.w - sA.w;
            if (sA.l !== sB.l) return sA.l - sB.l;
            if (sA.t !== sB.t) return sB.t - sA.t;
            return a.localeCompare(b);
        });

        let html = `
            <table class="league-standings-grid">
                <thead><tr><th>Place</th><th>Team</th><th>W</th><th>L</th><th>T</th></tr></thead>
                <tbody>
        `;
        
        sortedTeams.forEach((team, idx) => {
            const stats = league.standings[team] || {w:0,l:0,t:0};
            html += `<tr>
                <td>${idx + 1}${getPlaceSuffix(idx+1)}</td>
                <td>${team}</td>
                <td>${stats.w}</td>
                <td>${stats.l}</td>
                <td>${stats.t}</td>
            </tr>`;
        });
        html += `</tbody></table>`;
        container.innerHTML = html;
    }

    function renderGameEntryUI(league, container) {
        container.innerHTML = "";

        const controls = document.createElement("div");
        controls.style.marginBottom = "15px";
        controls.style.display = "flex";
        controls.style.gap = "10px";
        controls.style.alignItems = "center";

        const select = document.createElement("select");
        select.innerHTML = `<option value="new">-- Enter New Game Results --</option>`;
        
        (league.games || []).forEach((g, idx) => {
            const label = g.name || `Game ${idx + 1}`;
            select.innerHTML += `<option value="${idx}">${label} (${g.date})</option>`;
        });
        
        controls.appendChild(select);

        const importBtn = document.createElement("button");
        importBtn.textContent = "Import from Today's Schedule";
        importBtn.style.padding = "6px 12px";
        importBtn.onclick = () => importGamesFromSchedule(league, matchContainer);
        
        controls.appendChild(importBtn);
        container.appendChild(controls);

        const matchContainer = document.createElement("div");
        container.appendChild(matchContainer);

        // Save Button only for NEW games to commit them
        const createBtn = document.createElement("button");
        createBtn.textContent = "Add Game to History";
        createBtn.className = "update-standings-btn"; 
        createBtn.style.display = "none"; 
        createBtn.onclick = () => {
            const results = gatherResults(matchContainer);
            if (results.length === 0) return;
            
            league.games.push({
                id: Date.now(),
                date: window.currentScheduleDate,
                name: `Game ${league.games.length + 1}`,
                matches: results
            });
            recalcStandings(league);
            saveLeaguesData();
            alert("Game added!");
            renderGameEntryUI(league, container);
        };
        container.appendChild(createBtn);

        select.onchange = () => {
            matchContainer.innerHTML = "";
            if (select.value === "new") {
              
