// ===================================================================
// leagues.js
//
// UPDATED:
// - Added "Save All Changes" button to the main dashboard.
// ===================================================================

(function () {
    'use strict';

    let leaguesByName = {};
    window.leaguesByName = leaguesByName;

    let leagueRoundState = {};
    window.leagueRoundState = leagueRoundState;

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

    function saveRoundState() {}

    window.initLeagues = function () {
        loadLeaguesData();
        loadRoundState();
        renderLeaguesTab();
    };

    function renderLeaguesTab() {
        const container = document.getElementById("leaguesContainer");
        if (!container) return;

        container.innerHTML = `
            <div style="padding:20px; font-family:Arial;">
                <h1 style="color:#1a5fb4;">League Manager</h1>
                <p style="color:#444;">Create and manage leagues for the scheduler.</p>

                <div style="margin-bottom: 20px;">
                    <button id="new-league-btn"
                        style="padding:10px 20px; background:#1a5fb4; color:white;
                               border:none; border-radius:6px; cursor:pointer; margin-right: 10px;">
                        + Create New League
                    </button>
                    <button id="save-leagues-btn"
                        style="padding:10px 20px; background:#28a745; color:white;
                               border:none; border-radius:6px; cursor:pointer;">
                        Save All Changes
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
        
        // --- NEW SAVE BUTTON LISTENER ---
        document.getElementById("save-leagues-btn").onclick = () => {
            saveLeaguesData();
            alert("All league data saved successfully!");
        };

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
                saveLeaguesData();
                editLeague(name); 
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
                editLeague(name); 
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
                    saveLeaguesData();
                }
                otherSportInput.value = "";
                editLeague(name);
            }
        };
        sportPicker.appendChild(otherSportInput);
        content.appendChild(sportPicker);
        
        document.getElementById("l-delete-btn").onclick = () => deleteLeague(name);
        
        document.getElementById("l-enabled-toggle").onchange = (e) => {
            league.enabled = e.target.checked;
            saveLeaguesData();
            renderLeagueList(); 
        };
        
        const standingsBtn = document.getElementById("l-standings-btn");
        const standingsUI = document.getElementById("l-standings-ui");
        
        standingsBtn.onclick = () => {
            const isVisible = standingsUI.style.display === 'block';
            if (isVisible) {
                standingsUI.style.display = 'none';
                standingsBtn.textContent = 'Manage Standings / Games';
            } else {
                standingsUI.innerHTML = ''; 
                standingsUI.appendChild(renderGameResultsUI(name)); 
                standingsUI.style.display = 'block';
                standingsBtn.textContent = 'Close Standings';
            }
        };
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

        const saveBtn = document.createElement("button");
        saveBtn.textContent = "Save Game Results";
        saveBtn.className = "update-standings-btn"; 
        saveBtn.style.display = "none"; 
        saveBtn.onclick = () => saveGameResults(league, select.value, matchContainer);
        container.appendChild(saveBtn);

        select.onchange = () => {
            matchContainer.innerHTML = "";
            if (select.value === "new") {
                importBtn.style.display = "inline-block";
                saveBtn.style.display = "none";
            } else {
                importBtn.style.display = "none";
                saveBtn.style.display = "inline-block"; 
                loadExistingGame(league, select.value, matchContainer);
            }
        };

        function loadExistingGame(league, gameIdx, target) {
            const game = league.games[gameIdx];
            if (!game) return;

            game.matches.forEach(m => {
                addMatchRow(target, m.teamA, m.teamB, m.scoreA, m.scoreB);
            });
        }

        function addMatchRow(target, teamA, teamB, scoreA = "", scoreB = "") {
            const row = document.createElement("div");
            row.className = "match-row"; 
            row.style.display = "flex";
            row.style.alignItems = "center";
            row.style.gap = "10px";
            row.style.marginBottom = "8px";
            row.style.padding = "8px";
            row.style.background = "#f9f9f9";
            row.style.border = "1px solid #eee";

            row.innerHTML = `
                <strong style="min-width:100px; text-align:right;">${teamA}</strong>
                <input type="number" class="score-a" value="${scoreA}" style="width:50px; padding:5px;">
                <span>vs</span>
                <input type="number" class="score-b" value="${scoreB}" style="width:50px; padding:5px;">
                <strong style="min-width:100px;">${teamB}</strong>
            `;
            
            row.dataset.teamA = teamA;
            row.dataset.teamB = teamB;
            
            target.appendChild(row);
            saveBtn.style.display = "inline-block";
        }

        function importGamesFromSchedule(league, target) {
            target.innerHTML = "";
            const daily = window.loadCurrentDailyData?.() || {};
            const assignments = daily.scheduleAssignments || {};
            
            const foundMatches = new Set(); 
            
            league.teams.forEach(team => {
                const schedule = assignments[team] || [];
                schedule.forEach(entry => {
                    if (entry && entry._h2h) {
                        const label = entry.sport || ""; 
                        const match = label.match(/^(.*?) vs (.*?) \(/);
                        
                        if (match) {
                            const t1 = match[1].trim();
                            const t2 = match[2].trim();
                            
                            if (league.teams.includes(t1) && league.teams.includes(t2)) {
                                const key = [t1, t2].sort().join(" vs ");
                                if (!foundMatches.has(key)) {
                                    foundMatches.add(key);
                                    addMatchRow(target, t1, t2);
                                }
                            }
                        }
                    }
                });
            });

            if (foundMatches.size === 0) {
                target.innerHTML = "<p class='muted'>No scheduled games found for today.</p>";
            }
        }
    }

    function saveGameResults(league, gameId, container) {
        const rows = container.querySelectorAll(".match-row");
        const results = [];

        rows.forEach(row => {
            const tA = row.dataset.teamA;
            const tB = row.dataset.teamB;
            const sA = parseInt(row.querySelector(".score-a").value) || 0;
            const sB = parseInt(row.querySelector(".score-b").value) || 0;

            let winner = null;
            if (sA > sB) winner = tA;
            else if (sB > sA) winner = tB;
            else winner = "tie";

            results.push({ teamA: tA, teamB: tB, scoreA: sA, scoreB: sB, winner: winner });
        });

        if (results.length === 0) return;

        if (gameId === "new") {
            league.games.push({
                id: Date.now(),
                date: window.currentScheduleDate,
                name: `Game ${league.games.length + 1}`,
                matches: results
            });
        } else {
            league.games[gameId].matches = results;
        }

        recalcStandings(league); 
        saveLeaguesData();
        
        alert("Results saved and standings updated!");
        
        const editor = document.getElementById("league-editor");
        if(editor) {
            document.getElementById("tab-standings").click();
        }
    }

    function recalcStandings(league) {
        league.teams.forEach(t => {
            league.standings[t] = { w: 0, l: 0, t: 0 };
        });

        league.games.forEach(g => {
            g.matches.forEach(m => {
                if (m.winner === "tie") {
                    if(league.standings[m.teamA]) league.standings[m.teamA].t++;
                    if(league.standings[m.teamB]) league.standings[m.teamB].t++;
                } else if (m.winner) {
                    if(league.standings[m.winner]) league.standings[m.winner].w++;
                    const loser = (m.winner === m.teamA) ? m.teamB : m.teamA;
                    if(league.standings[loser]) league.standings[loser].l++;
                }
            });
        });
    }

    window.deleteLeague = function (name) {
        if (!confirm(`Are you sure you want to delete "${name}"?`)) return;
        delete leaguesByName[name];
        saveLeaguesData();
        renderLeagueList();
        document.getElementById("league-editor").style.display = "none";
    };

    function saveLeaguesData() {
        const global = window.loadGlobalSettings?.() || {};
        global.leaguesByName = leaguesByName;
        window.saveGlobalSettings?.(global);
        window.leaguesByName = leaguesByName;
    }

    function loadLeaguesData() {
        const global = window.loadGlobalSettings?.() || {};
        leaguesByName = global.leaguesByName || {};
        
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

    loadLeaguesData();
    loadRoundState();
})();
