
// ===================================================================
// leagues.js
//
// UPDATED:
// - Import Logic: Now prioritizes the explicit "League Game X" title 
//   from the schedule block (entry._activity) before falling back to 
//   auto-numbering.
// - Handles multiple games per day correctly.
// ===================================================================

(function () {
    'use strict';

    let leaguesByName = {};
    window.leaguesByName = leaguesByName;

    let leagueRoundState = {};
    window.leagueRoundState = leagueRoundState;

    // --- UI State Persistence ---
    let selectedLeagueName = null;
    let listEl = null;
    let detailPaneEl = null;

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

    function saveLeaguesData() {
        window.saveGlobalSettings?.("leaguesByName", leaguesByName);
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

    function makeEditable(el, saveCallback) {
        el.ondblclick = e => {
            e.stopPropagation();
            const oldText = el.textContent;
            const input = document.createElement("input");
            input.type = "text";
            input.value = oldText;
            el.replaceWith(input);
            input.focus();
            const finish = () => {
                const newVal = input.value.trim();
                if (newVal && newVal !== oldText) saveCallback(newVal);
                el.textContent = newVal || oldText;
                input.replaceWith(el);
            };
            input.onblur = finish;
            input.onkeyup = (ev) => { if (ev.key === "Enter") finish(); };
        };
    }

    window.initLeagues = function () {
        const container = document.getElementById("leaguesContainer");
        if (!container) return;

        loadLeaguesData();
        loadRoundState();

        container.innerHTML = `
            <div style="display: flex; flex-wrap: wrap; gap: 20px;">
                <div style="flex: 1; min-width: 300px;">
                    <h3>Add New League</h3>
                    <div style="display: flex; gap: 10px; margin-bottom: 20px;">
                        <input id="new-league-input" placeholder="League Name (e.g., Senior League)" style="flex: 1;">
                        <button id="add-league-btn">Add League</button>
                    </div>
                    <h3>All Leagues</h3>
                    <div id="league-master-list" class="master-list"></div>
                </div>
                <div style="flex: 2; min-width: 400px; position: sticky; top: 20px;">
                    <h3>Details</h3>
                    <div id="league-detail-pane" class="detail-pane">
                        <p class="muted">Select a league from the left to edit its details.</p>
                    </div>
                </div>
            </div>
            <style>
                .master-list .list-item { padding: 12px 10px; border: 1px solid #ddd; border-radius: 5px; margin-bottom: 5px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; background: #fff; }
                .master-list .list-item:hover { background: #f9f9f9; }
                .master-list .list-item.selected { background: #e7f3ff; border-color: #007bff; font-weight: 600; }
                .master-list .list-item-name { flex-grow: 1; }
                .detail-pane { border: 1px solid #ccc; border-radius: 8px; padding: 20px; background: #fdfdfd; min-height: 400px; }
                .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px; }
                .chip { padding: 4px 8px; border-radius: 12px; border: 1px solid #ccc; cursor: pointer; }
                .match-row { transition: background 0.2s; }
                .match-row:hover { background: #f9f9f9; }
                .league-standings-table { width: 100%; border-collapse: collapse; }
                .league-standings-table th, .league-standings-table td { padding: 8px; text-align: center; border-bottom: 1px solid #eee; }
                .league-standings-table th { background: #f0f0f0; text-align: left; }
                .league-standings-table td:first-child, .league-standings-table th:first-child { text-align: left; }
                .group-header { background: #e9ecef; padding: 8px 12px; font-weight: bold; font-size: 0.95em; color: #495057; border-radius: 4px; margin-top: 15px; margin-bottom: 8px; border-left: 4px solid #007bff; }
            </style>
        `;

        listEl = document.getElementById("league-master-list");
        detailPaneEl = document.getElementById("league-detail-pane");
        
        const addInput = document.getElementById("new-league-input");
        const addBtn = document.getElementById("add-league-btn");

        const addLeague = () => {
            const name = addInput.value.trim();
            if (!name) return;
            if (leaguesByName[name]) { alert("League exists!"); return; }
            leaguesByName[name] = { teams: [], sports: [], divisions: [], standings: {}, games: [], enabled: true };
            saveLeaguesData();
            addInput.value = "";
            selectedLeagueName = name;
            renderMasterList();
            renderDetailPane();
        };

        addBtn.onclick = addLeague;
        addInput.onkeyup = (e) => { if(e.key === "Enter") addLeague(); };

        renderMasterList();
        
        if (selectedLeagueName && leaguesByName[selectedLeagueName]) {
            renderDetailPane();
        }
    };

    function renderMasterList() {
        listEl.innerHTML = "";
        const keys = Object.keys(leaguesByName).sort();
        if (keys.length === 0) {
            listEl.innerHTML = `<p class="muted">No leagues yet.</p>`;
            return;
        }
        keys.forEach(name => {
            const item = leaguesByName[name];
            const el = document.createElement('div');
            el.className = 'list-item';
            if (name === selectedLeagueName) el.classList.add('selected');
            el.onclick = () => {
                selectedLeagueName = name;
                renderMasterList();
                renderDetailPane();
            };
            el.innerHTML = `<span class="list-item-name">${name}</span>`;
            const tog = document.createElement("label"); 
            tog.className = "switch";
            tog.onclick = (e) => e.stopPropagation();
            const cb = document.createElement("input"); 
            cb.type = "checkbox"; 
            cb.checked = item.enabled;
            cb.onchange = () => { item.enabled = cb.checked; saveLeaguesData(); };
            tog.append(cb, document.createElement("span"));
            tog.querySelector("span").className = "slider";
            el.appendChild(tog);
            listEl.appendChild(el);
        });
    }

    function renderDetailPane() {
        if (!selectedLeagueName || !leaguesByName[selectedLeagueName]) {
            detailPaneEl.innerHTML = `<p class="muted">Select a league.</p>`;
            return;
        }
        
        const league = leaguesByName[selectedLeagueName];
        detailPaneEl.innerHTML = "";

        // --- Header ---
        const header = document.createElement('div');
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.marginBottom = '15px';
        header.style.borderBottom = '2px solid #eee';
        header.style.paddingBottom = '10px';

        // Title
        const title = document.createElement('h2');
        title.style.margin = '0';
        title.textContent = selectedLeagueName;
        title.title = "Double-click to rename";
        makeEditable(title, (newName) => {
            if(newName && !leaguesByName[newName]) {
                leaguesByName[newName] = league;
                delete leaguesByName[selectedLeagueName];
                selectedLeagueName = newName;
                saveLeaguesData();
                renderMasterList();
                renderDetailPane();
            }
        });
        header.appendChild(title);

        // Buttons
        const btnGroup = document.createElement('div');
        
        // EDIT CONFIG BUTTON
        const editConfigBtn = document.createElement('button');
        editConfigBtn.textContent = "Edit Configuration";
        editConfigBtn.style.marginRight = "10px";
        editConfigBtn.style.background = "#6c757d";
        editConfigBtn.style.color = "white";
        editConfigBtn.style.border = "none";
        editConfigBtn.style.padding = "5px 10px";
        editConfigBtn.style.borderRadius = "4px";
        editConfigBtn.style.cursor = "pointer";

        // DELETE BUTTON
        const delBtn = document.createElement('button');
        delBtn.textContent = "Delete";
        delBtn.style.background = "#c0392b";
        delBtn.style.color = "white";
        delBtn.style.border = "none";
        delBtn.style.padding = "5px 10px";
        delBtn.style.borderRadius = "4px";
        delBtn.style.cursor = "pointer";
        delBtn.onclick = () => {
            if(confirm("Delete league?")) {
                delete leaguesByName[selectedLeagueName];
                selectedLeagueName = null;
                saveLeaguesData();
                renderMasterList();
                detailPaneEl.innerHTML = `<p class="muted">Select a league.</p>`;
            }
        };

        btnGroup.appendChild(editConfigBtn);
        btnGroup.appendChild(delBtn);
        header.appendChild(btnGroup);
        detailPaneEl.appendChild(header);

        // --- Configuration Section (Hidden by Default) ---
        const configContainer = document.createElement("div");
        configContainer.id = "league-config-ui";
        configContainer.style.display = "none"; // HIDDEN
        configContainer.style.marginBottom = "20px";
        configContainer.style.padding = "15px";
        configContainer.style.border = "1px solid #eee";
        configContainer.style.background = "#f8f9fa";
        configContainer.style.borderRadius = "8px";
        
        renderConfigSections(league, configContainer);
        detailPaneEl.appendChild(configContainer);

        // Toggle Config Logic
        editConfigBtn.onclick = () => {
            const isHidden = configContainer.style.display === "none";
            if (isHidden) {
                configContainer.style.display = "block";
                editConfigBtn.textContent = "Close Configuration";
                editConfigBtn.style.background = "#343a40"; 
            } else {
                configContainer.style.display = "none";
                editConfigBtn.textContent = "Edit Configuration";
                editConfigBtn.style.background = "#6c757d"; 
            }
        };

        // --- Main Content (Standings & Games) ---
        const mainContent = document.createElement("div");
        renderGameResultsUI(league, mainContent);
        detailPaneEl.appendChild(mainContent);
    }
    
    function renderConfigSections(league, container) {
        container.innerHTML = ""; 

        // Divisions
        const divSec = document.createElement('div');
        divSec.innerHTML = `<strong>Divisions:</strong>`;
        const divChips = document.createElement('div');
        divChips.className = 'chips';
        (window.availableDivisions || []).forEach(divName => {
            const isActive = league.divisions.includes(divName);
            const chip = document.createElement('span');
            chip.className = 'chip';
            chip.textContent = divName;
            chip.style.background = isActive ? '#007BFF' : '#f0f0f0';
            chip.style.color = isActive ? 'white' : 'black';
            chip.onclick = () => {
                if (isActive) league.divisions = league.divisions.filter(d => d !== divName);
                else league.divisions.push(divName);
                saveLeaguesData();
                renderConfigSections(league, container);
            };
            divChips.appendChild(chip);
        });
        divSec.appendChild(divChips);
        container.appendChild(divSec);

        // Sports
        const sportSec = document.createElement('div');
        sportSec.style.marginTop = "15px";
        sportSec.innerHTML = `<strong>Sports:</strong>`;
        const sportChips = document.createElement('div');
        sportChips.className = 'chips';
        (window.getAllGlobalSports?.() || []).forEach(act => {
            const isActive = league.sports.includes(act);
            const chip = document.createElement('span');
            chip.className = 'chip';
            chip.textContent = act;
            chip.style.background = isActive ? '#007BFF' : '#f0f0f0';
            chip.style.color = isActive ? 'white' : 'black';
            chip.onclick = () => {
                if (isActive) league.sports = league.sports.filter(s => s !== act);
                else league.sports.push(act);
                saveLeaguesData();
                renderConfigSections(league, container);
            };
            sportChips.appendChild(chip);
        });
        sportSec.appendChild(sportChips);
        container.appendChild(sportSec);

        // Teams
        const teamSec = document.createElement('div');
        teamSec.style.marginTop = "15px";
        teamSec.innerHTML = `<strong>Teams:</strong>`;
        const teamList = document.createElement('div');
        teamList.className = 'chips';
        league.teams.forEach(team => {
            const chip = document.createElement('span');
            chip.className = 'chip';
            chip.textContent = `${team} ✖`;
            chip.style.background = "#17a2b8";
            chip.style.color = "white";
            chip.onclick = () => {
                league.teams = league.teams.filter(t => t !== team);
                delete league.standings[team];
                saveLeaguesData();
                renderConfigSections(league, container);
                const parentPane = document.getElementById("league-detail-pane");
                if(parentPane) renderDetailPane(); 
            };
            teamList.appendChild(chip);
        });
        teamSec.appendChild(teamList);

        const teamInput = document.createElement("input");
        teamInput.placeholder = "Add team (Press Enter)";
        teamInput.style.marginTop = "8px";
        teamInput.onkeyup = (e) => {
            if (e.key === "Enter" && teamInput.value.trim()) {
                const t = teamInput.value.trim();
                if (!league.teams.includes(t)) {
                    league.teams.push(t);
                    league.standings[t] = {w:0, l:0, t:0};
                    saveLeaguesData();
                    renderConfigSections(league, container);
                    const parentPane = document.getElementById("league-detail-pane");
                    if(parentPane) renderDetailPane();
                }
            }
        };
        teamSec.appendChild(teamInput);
        container.appendChild(teamSec);
    }


    // ===================================================================
    // GAME RESULTS & STANDINGS LOGIC
    // ===================================================================

    function renderGameResultsUI(league, container) {
        container.innerHTML = "";

        // --- TABS: Standings vs Game Entry ---
        const tabNav = document.createElement("div");
        tabNav.style.marginBottom = "15px";
        tabNav.innerHTML = `
            <button id="tab-standings" style="font-weight:bold; padding:8px 15px; margin-right:5px; background:#007bff; color:white; border:none; border-radius:4px; cursor:pointer;">Current Standings</button>
            <button id="tab-games" style="padding:8px 15px; background:#e9ecef; color:#333; border:none; border-radius:4px; cursor:pointer;">Game Results / History</button>
        `;
        container.appendChild(tabNav);

        const standingsDiv = document.createElement("div");
        const gamesDiv = document.createElement("div");
        gamesDiv.style.display = "none";

        container.appendChild(standingsDiv);
        container.appendChild(gamesDiv);

        // Tab Switching Logic
        const btnStd = tabNav.querySelector("#tab-standings");
        const btnGms = tabNav.querySelector("#tab-games");

        btnStd.onclick = () => {
            standingsDiv.style.display = "block";
            gamesDiv.style.display = "none";
            btnStd.style.background = "#007bff"; btnStd.style.color = "white";
            btnGms.style.background = "#e9ecef"; btnGms.style.color = "#333";
            renderStandingsTable(league, standingsDiv); 
        };
        btnGms.onclick = () => {
            standingsDiv.style.display = "none";
            gamesDiv.style.display = "block";
            btnStd.style.background = "#e9ecef"; btnStd.style.color = "#333";
            btnGms.style.background = "#007bff"; btnGms.style.color = "white";
            renderGameEntryUI(league, gamesDiv);
        };

        // Initial Render (Default to Standings)
        renderStandingsTable(league, standingsDiv);
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
            <table class="league-standings-table">
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

        // 1. Game Selection Dropdown
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

        // "Import" Button
        const importBtn = document.createElement("button");
        importBtn.textContent = "Import from Today's Schedule";
        importBtn.style.padding = "6px 12px";
        importBtn.style.background = "#007bff";
        importBtn.style.color = "white";
        importBtn.style.border = "none";
        importBtn.style.borderRadius = "4px";
        importBtn.style.cursor = "pointer";

        const matchContainer = document.createElement("div");
        matchContainer.style.maxHeight = "400px";
        matchContainer.style.overflowY = "auto";
        
        importBtn.onclick = () => importGamesFromSchedule(league, matchContainer);

        controls.appendChild(importBtn);
        container.appendChild(controls);
        container.appendChild(matchContainer);

        // Save Button
        const saveBtn = document.createElement("button");
        saveBtn.textContent = "Save Game Results";
        saveBtn.style.marginTop = "10px";
        saveBtn.style.background = "#28a745";
        saveBtn.style.color = "white";
        saveBtn.style.border = "none";
        saveBtn.style.padding = "8px 16px";
        saveBtn.style.borderRadius = "4px";
        saveBtn.style.cursor = "pointer";
        saveBtn.style.display = "none"; 
        saveBtn.onclick = () => saveGameResults(league, select.value, matchContainer);
        container.appendChild(saveBtn);

        // Dropdown Change
        select.onchange = () => {
            matchContainer.innerHTML = "";
            if (select.value === "new") {
                importBtn.style.display = "inline-block";
                saveBtn.style.display = "none";
            } else {
                importBtn.style.display = "none";
                saveBtn.style.display = "inline-block"; 
                loadExistingGame(league, select.value, matchContainer, saveBtn);
            }
        };

        // Helper: Load Existing
        function loadExistingGame(league, gameIdx, target, saveButton) {
            const game = league.games[gameIdx];
            if (!game) return;

            const groupedMatches = {};
            game.matches.forEach(m => {
                const label = m.timeLabel || "Matchups";
                if(!groupedMatches[label]) groupedMatches[label] = [];
                groupedMatches[label].push(m);
            });

            Object.keys(groupedMatches).sort().forEach(label => {
                const header = document.createElement("div");
                header.className = "group-header";
                header.textContent = label;
                target.appendChild(header);

                groupedMatches[label].forEach(m => {
                    addMatchRow(target, m.teamA, m.teamB, m.scoreA, m.scoreB, saveButton, label);
                });
            });
        }
    }

    function addMatchRow(target, teamA, teamB, scoreA = "", scoreB = "", saveButton, timeLabel = "") {
        const row = document.createElement("div");
        row.className = "match-row"; 
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.gap = "10px";
        row.style.marginBottom = "8px";
        row.style.padding = "8px";
        row.style.background = "#f9f9f9";
        row.style.border = "1px solid #eee";
        row.style.borderRadius = "4px";

        row.innerHTML = `
            <strong style="min-width:100px; text-align:right;">${teamA}</strong>
            <input type="number" class="score-a" value="${scoreA}" style="width:50px; padding:5px;">
            <span>vs</span>
            <input type="number" class="score-b" value="${scoreB}" style="width:50px; padding:5px;">
            <strong style="min-width:100px;">${teamB}</strong>
        `;

        row.dataset.teamA = teamA;
        row.dataset.teamB = teamB;
        if(timeLabel) row.dataset.timeLabel = timeLabel;

        target.appendChild(row);
        if(saveButton) saveButton.style.display = "inline-block";
    }

    function importGamesFromSchedule(league, target) {
        target.innerHTML = "";
        const daily = window.loadCurrentDailyData?.() || {};
        const assignments = daily.scheduleAssignments || {};

        const foundMatches = new Set(); 
        const saveButton = target.parentElement.querySelector("button[style*='background: rgb(40, 167, 69)']") || target.parentElement.lastElementChild;

        // --- 1. Determine Previous Game Count ---
        let maxLeagueGameNum = 0;
        (league.games || []).forEach(g => {
            // Try to extract number from name "Game Set 5" or similar
            if (g.name) {
                const n = parseInt(g.name.replace(/\D/g, ''));
                if (!isNaN(n) && n > maxLeagueGameNum) maxLeagueGameNum = n;
            }
        });

        // --- 2. Gather Matches from Schedule ---
        const groupedMatches = {};

        league.teams.forEach(team => {
            const schedule = assignments[team] || [];
            schedule.forEach((entry, slotIndex) => {
                // IGNORE CONTINUATIONS
                if (entry && entry._h2h && !entry.continuation) {
                    const label = entry.sport || ""; 
                    
                    // Attempt to extract teams from string: "Team A vs Team B (Sport)"
                    const match = label.match(/^(.*?) vs (.*?) \(/);

                    if (match) {
                        const t1 = match[1].trim();
                        const t2 = match[2].trim();

                        // Ensure these teams belong to THIS league
                        if (league.teams.includes(t1) && league.teams.includes(t2)) {
                            const uniqueKey = [t1, t2].sort().join(" vs ") + "::" + slotIndex;
                            
                            if (!foundMatches.has(uniqueKey)) {
                                foundMatches.add(uniqueKey);
                                
                                if(!groupedMatches[slotIndex]) groupedMatches[slotIndex] = { matches: [], label: null };
                                groupedMatches[slotIndex].matches.push({ t1, t2 });

                                // ** PRIORITY: Check for explicit "League Game X" title in the activity field **
                                // This catches manually named blocks or specific skeleton items
                                const explicitName = (entry.field && typeof entry.field === 'string') ? entry.field : entry._activity;
                                if (explicitName && explicitName.match(/League Game \d+/i)) {
                                    groupedMatches[slotIndex].label = explicitName;
                                } 
                                // ** SECONDARY: Check for parens in the sport string **
                                else {
                                    const parenMatch = label.match(/\((.*?)\)$/);
                                    if (parenMatch) {
                                        const textInParens = parenMatch[1];
                                        if (textInParens.match(/Game \d+/i)) {
                                            groupedMatches[slotIndex].label = textInParens; 
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            });
        });

        // Sort slots by time
        const sortedSlots = Object.keys(groupedMatches).sort((a,b) => parseInt(a) - parseInt(b));
        
        if (sortedSlots.length === 0) {
            target.innerHTML = "<p class='muted'>No scheduled games found for today.</p>";
            return;
        }

        // --- 3. Render Groups ---
        sortedSlots.forEach((slotIdx, displayIndex) => {
            const group = groupedMatches[slotIdx];
            let gameLabel = "";

            // PRIORITY: Use specific label found in schedule (e.g. "League Game 5")
            if (group.label) {
                gameLabel = group.label;
            } else {
                // FALLBACK: Sequential numbering based on History + Today's Order
                // If we found 2 slots today, first is X+1, second is X+2
                const gameNumber = maxLeagueGameNum + displayIndex + 1;
                gameLabel = `League Game ${gameNumber}`;
            }

            const header = document.createElement("div");
            header.className = "group-header";
            header.textContent = gameLabel;
            target.appendChild(header);

            group.matches.forEach(m => {
                addMatchRow(target, m.t1, m.t2, "", "", saveButton, gameLabel);
            });
        });
        
        if(saveButton) saveButton.style.display = "inline-block";
    }

    function saveGameResults(league, gameId, container) {
        const rows = container.querySelectorAll(".match-row");
        const results = [];

        rows.forEach(row => {
            const tA = row.dataset.teamA;
            const tB = row.dataset.teamB;
            const tLabel = row.dataset.timeLabel || ""; 
            const sA = parseInt(row.querySelector(".score-a").value) || 0;
            const sB = parseInt(row.querySelector(".score-b").value) || 0;

            let winner = null;
            if (sA > sB) winner = tA;
            else if (sB > sA) winner = tB;
            else winner = "tie";

            results.push({ 
                teamA: tA, 
                teamB: tB, 
                scoreA: sA, 
                scoreB: sB, 
                winner: winner,
                timeLabel: tLabel 
            });
        });

        if (results.length === 0) return;

        if (gameId === "new") {
            // Use the first label found in the import as the Game Name, or generic
            const firstLabel = results[0].timeLabel || `Game Set ${league.games.length + 1}`;
            
            league.games.push({
                id: Date.now(),
                date: window.currentScheduleDate || new Date().toLocaleDateString(),
                name: firstLabel,
                matches: results
            });
        } else {
            league.games[gameId].matches = results;
        }

        recalcStandings(league); 
        saveLeaguesData();
        alert("Results saved and standings updated!");
        renderDetailPane(); 
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

    loadLeaguesData();
    loadRoundState();

})();
