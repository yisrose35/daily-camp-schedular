// =================================================================
// specialty_leagues.js
//
// UPDATED:
// - Added Game Results Tracking (Scores, W/L/T).
// - Added "Import from Schedule" to auto-fill matchups.
// - Standings are now calculated dynamically from game history.
// =================================================================

(function() {
    'use strict';

    function getPlaceSuffix(n) {
        const s = ["th", "st", "nd", "rd"];
        const v = n % 100;
        return (s[(v - 20) % 10] || s[v] || s[0]);
    }

    let specialtyLeagues = {}; 
    let allFields = [];
    let allDivisions = [];
    let fieldsBySport = {};
    let leagueRoundState = {}; 

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
            leagueRoundState = {};
        }
    }

    function saveRoundState() {
        try {
            window.saveCurrentDailyData?.("leagueRoundState", leagueRoundState);
        } catch (e) {}
    }

    function loadData() {
        const globalSettings = window.loadGlobalSettings?.() || {};
        const app1Data = globalSettings.app1 || {};

        specialtyLeagues = globalSettings.specialtyLeagues || {};
        
        Object.values(specialtyLeagues).forEach(league => {
            league.standings = league.standings || {};
            league.games = league.games || []; // --- NEW
            (league.teams || []).forEach(team => {
                league.standings[team] = league.standings[team] || { w: 0, l: 0, t: 0 };
            });
        });

        allFields = app1Data.fields || []; 
        allDivisions = app1Data.availableDivisions || [];
        
        fieldsBySport = {};
        allFields.forEach(f => {
            (f.activities || []).forEach(sport => {
                fieldsBySport[sport] = fieldsBySport[sport] || [];
                fieldsBySport[sport].push(f.name);
            });
        });
        
        loadRoundState();
    }

    function saveData() {
        window.saveGlobalSettings?.("specialtyLeagues", specialtyLeagues);
    }

    function uid() {
        return `sl_${Math.random().toString(36).slice(2, 9)}`;
    }

    function initSpecialtyLeagues() {
        const container = document.getElementById("specialtyLeaguesContainer");
        if (!container) return;

        loadData(); 

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
    
    function renderLeagueList() {
        const list = document.getElementById("specialty-league-list");
        if (!list) return; 

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
                    <p style="margin:0; color:#555;"><strong>Games Played:</strong> ${l.games?.length || 0}</p>
                </div>
            `).join("");
    }
    
    function createNewLeague() {
        const name = prompt("Enter specialty league name:");
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
            standings: {},
            games: [] // --- NEW
        };

        saveData();
        renderLeagueList();
        window.editSpecialtyLeague(newId); 
    }

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
                        Manage Standings / Games
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
        
        document.getElementById("sl-delete-btn").onclick = () => deleteLeague(id);
        
        document.getElementById("sl-enabled-toggle").onchange = (e) => {
            league.enabled = e.target.checked;
            saveData();
            renderLeagueList(); 
        };
        
        const standingsBtn = document.getElementById("sl-standings-btn");
        const standingsUI = document.getElementById("sl-standings-ui");
        
        standingsBtn.onclick = () => {
            const isVisible = standingsUI.style.display === 'block';
            if (isVisible) {
                standingsUI.style.display = 'none';
                standingsBtn.textContent = 'Manage Standings / Games';
            } else {
                standingsUI.innerHTML = ''; 
                standingsUI.appendChild(renderGameResultsUI(league)); // --- UPDATED CALL
                standingsUI.style.display = 'block';
                standingsBtn.textContent = 'Close Standings';
            }
        };
    }

    function deleteLeague(id) {
        const league = specialtyLeagues[id];
        if (!league) return;
        if (!confirm(`Are you sure you want to delete "${league.name}"?`)) return;
        delete specialtyLeagues[id];
        saveData();
        renderLeagueList();
        document.getElementById("specialty-league-editor").style.display = "none";
    }

    // --- GAME RESULTS UI (NEW) ---
    function renderGameResultsUI(league) {
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
            const sA = league.standings[a] || {w:0,l:0,t:0};
            const sB = league.standings[b] || {w:0,l:0,t:0};
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
            select.innerHTML += `<option value="${idx}">${g.name || ('Game '+(idx+1))} (${g.date})</option>`;
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
            saveBtn.style.display = "inline-block";
        }

        function addMatchRow(target, teamA, teamB, scoreA = "", scoreB = "") {
            const row = document.createElement("div");
            row.className = "match-row";
            row.style.cssText = "display:flex; align-items:center; gap:10px; margin-bottom:8px; padding:8px; background:#f9f9f9; border:1px solid #eee;";

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
                    // Check if this schedule entry matches our league's sport (or is a generic league slot)
                    // Specialty leagues usually have a fixed sport.
                    const isMatch = entry._h2h && (entry._activity === league.sport || entry.sport.includes(league.sport));
                    
                    if (isMatch) {
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
                target.innerHTML = "<p class='muted'>No games found today for this league's sport.</p>";
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
        saveData();
        alert("Results saved!");
        document.getElementById("tab-standings").click(); 
    }

    function recalcStandings(league) {
        league.teams.forEach(t => { league.standings[t] = { w: 0, l: 0, t: 0 }; });
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
            league.fields = []; 
            saveData();
            window.editSpecialtyLeague(league.id); 
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
                league.standings[teamName] = league.standings[teamName] || { w: 0, l: 0, t: 0 };
                saveData();
                window.editSpecialtyLeague(league.id);
            }
            teamInput.value = "";
        };
        teamInput.onkeypress = (e) => { if (e.key === "Enter") addBtn.click(); };
        addWrapper.appendChild(teamInput);
        addWrapper.appendChild(addBtn);
        wrapper.appendChild(addWrapper);
        const chipBox = document.createElement("div");
        chipBox.className = "chips";
        chipBox.style.marginTop = "8px";
        if (league.teams.length === 0) {
            chipBox.innerHTML = `<span class="muted" style="font-size:0.9em;">No teams added yet.</span>`;
        }
        league.teams.forEach(teamName => {
            const chip = createChip(`${teamName} ✖`, true, "#5bc0de"); 
            chip.onclick = () => {
                delete league.standings[teamName];
                toggleArrayItem(league.teams, teamName); 
                saveData();
                window.editSpecialtyLeague(league.id); 
            };
            chipBox.appendChild(chip);
        });
        wrapper.appendChild(chipBox);
        return wrapper;
    }

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

    function getLeagueMatchups(leagueName, teams) {
        if (!leagueName || !teams || teams.length < 2) return [];
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
