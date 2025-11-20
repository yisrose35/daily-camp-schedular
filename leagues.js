// ===================================================================
// leagues.js
//
// UPDATED:
// - Fix: Import skips 'continuation' slots (prevents duplicates).
// - UI: Game History is now collapsible.
// - UI: Score inputs are text-based (no spinner arrows).
// ===================================================================

(function () {
    'use strict';

    let leaguesByName = {};
    window.leaguesByName = leaguesByName;

    let leagueRoundState = {};
    window.leagueRoundState = leagueRoundState;

    // --- UI State Persistence ---
    let selectedLeagueName = null;
    let activeSubView = null; // 'standings' or null

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
                .staging-row { transition: background 0.2s; }
                .staging-row:hover { background: #f9f9f9; }
                .time-badge { font-size: 0.8em; background: #e2e6ea; padding: 2px 6px; border-radius: 4px; color: #555; margin-right: 10px; min-width: 65px; text-align: center; display: inline-block; }
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

        // Header
        const header = document.createElement('div');
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.marginBottom = '15px';
        header.style.borderBottom = '2px solid #eee';
        header.style.paddingBottom = '10px';

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

        const btnGroup = document.createElement('div');
        const standingsBtn = document.createElement('button');
        standingsBtn.textContent = "Manage Standings / Games";
        standingsBtn.style.marginRight = "10px";
        standingsBtn.style.background = "#28a745";
        standingsBtn.style.color = "white";
        
        const delBtn = document.createElement('button');
        delBtn.textContent = "Delete";
        delBtn.style.background = "#c0392b";
        delBtn.style.color = "white";
        delBtn.onclick = () => {
            if(confirm("Delete league?")) {
                delete leaguesByName[selectedLeagueName];
                selectedLeagueName = null;
                saveLeaguesData();
                renderMasterList();
                detailPaneEl.innerHTML = `<p class="muted">Select a league.</p>`;
            }
        };

        btnGroup.appendChild(standingsBtn);
        btnGroup.appendChild(delBtn);
        header.appendChild(btnGroup);
        detailPaneEl.appendChild(header);

        // Standings Area
        const standingsContainer = document.createElement("div");
        standingsContainer.id = "league-standings-ui";
        standingsContainer.style.display = "none";
        standingsContainer.style.marginBottom = "20px";
        standingsContainer.style.padding = "15px";
        standingsContainer.style.border = "1px solid #ccc";
        standingsContainer.style.background = "#fff";
        standingsContainer.style.borderRadius = "8px";
        detailPaneEl.appendChild(standingsContainer);

        const toggleStandings = () => {
            const isVisible = standingsContainer.style.display === 'block';
            if (isVisible) {
                standingsContainer.style.display = 'none';
                standingsBtn.textContent = "Manage Standings / Games";
                activeSubView = null;
            } else {
                standingsContainer.style.display = 'block';
                renderGameResultsUI(league, standingsContainer);
                standingsBtn.textContent = "Close Standings";
                activeSubView = 'standings';
            }
        };
        standingsBtn.onclick = toggleStandings;

        if (activeSubView === 'standings') {
             standingsContainer.style.display = 'block';
             renderGameResultsUI(league, standingsContainer);
             standingsBtn.textContent = "Close Standings";
        }

        // Configuration Sections
        renderConfigSections(league);
    }
    
    function renderConfigSections(league) {
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
                renderDetailPane();
            };
            divChips.appendChild(chip);
        });
        divSec.appendChild(divChips);
        detailPaneEl.appendChild(divSec);

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
                renderDetailPane();
            };
            sportChips.appendChild(chip);
        });
        sportSec.appendChild(sportChips);
        detailPaneEl.appendChild(sportSec);

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
                renderDetailPane();
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
                    renderDetailPane();
                }
            }
        };
        teamSec.appendChild(teamInput);
        detailPaneEl.appendChild(teamSec);
    }

    // --- GAME RESULTS & STANDINGS LOGIC ---
    function renderGameResultsUI(league, container) {
        container.innerHTML = "";
        
        const tabs = document.createElement("div");
        tabs.innerHTML = `
            <button id="tab-std" style="margin-right:5px; padding:5px 10px;">Standings</button>
            <button id="tab-gms" style="padding:5px 10px;">Game History</button>
        `;
        container.appendChild(tabs);
        
        const content = document.createElement("div");
        content.style.marginTop = "10px";
        container.appendChild(content);

        const showStandings = () => { content.innerHTML = renderStandingsHTML(league); };
        const showGames = () => { content.innerHTML = ""; renderGamesUI(league, content); };

        tabs.querySelector("#tab-std").onclick = showStandings;
        tabs.querySelector("#tab-gms").onclick = showGames;

        showStandings(); 
    }

    function renderStandingsHTML(league) {
        league.teams.forEach(t => league.standings[t] = { w:0, l:0, t:0 });
        league.games.forEach(g => {
            g.matches.forEach(m => {
                if (m.winner === 'tie') {
                    if(league.standings[m.teamA]) league.standings[m.teamA].t++;
                    if(league.standings[m.teamB]) league.standings[m.teamB].t++;
                } else if (m.winner) {
                    if(league.standings[m.winner]) league.standings[m.winner].w++;
                    const loser = (m.winner === m.teamA) ? m.teamB : m.teamA;
                    if(league.standings[loser]) league.standings[loser].l++;
                }
            });
        });
        
        const sorted = [...league.teams].sort((a, b) => {
             const sA = league.standings[a] || {w:0};
             const sB = league.standings[b] || {w:0};
             return sB.w - sA.w;
        });

        let h = `<table style="width:100%; border-collapse:collapse;">
            <tr style="background:#f0f0f0;"><th style="text-align:left; padding:5px;">Team</th><th>W</th><th>L</th><th>T</th></tr>`;
        sorted.forEach(t => {
            const s = league.standings[t] || {w:0,l:0,t:0};
            h += `<tr><td style="padding:5px; border-bottom:1px solid #eee;">${t}</td><td style="text-align:center;">${s.w}</td><td style="text-align:center;">${s.l}</td><td style="text-align:center;">${s.t}</td></tr>`;
        });
        h += `</table>`;
        return h;
    }

    function renderGamesUI(league, wrapper) {
        // --- NEW GAME SECTION ---
        const newGameSection = document.createElement("div");
        newGameSection.style.padding = "15px";
        newGameSection.style.background = "#e8f4f8";
        newGameSection.style.border = "1px solid #b3d7ff";
        newGameSection.style.borderRadius = "8px";
        newGameSection.style.marginBottom = "20px";
        
        newGameSection.innerHTML = `
            <h4 style="margin-top:0; margin-bottom:10px; color:#0056b3;">Record New Game Results</h4>
            <div style="display:flex; gap:10px; margin-bottom:10px;">
                <button id="btn-import-schedule" style="background:#007bff; color:white; border:none; padding:6px 12px; border-radius:4px; cursor:pointer;">
                    📥 Import Today's Schedule
                </button>
                <button id="btn-add-manual-row" style="background:#6c757d; color:white; border:none; padding:6px 12px; border-radius:4px; cursor:pointer;">
                    + Add Manual Matchup
                </button>
                <button id="btn-clear-list" style="background:#d40000; color:white; border:none; padding:6px 12px; border-radius:4px; cursor:pointer;">
                    Clear List
                </button>
            </div>
            <div id="new-game-rows-container" style="background:white; border:1px solid #ccc; padding:10px; border-radius:4px; min-height:50px; margin-bottom:10px;">
                <p class="muted" id="new-game-placeholder" style="text-align:center; margin:0; padding:10px;">No matches added yet.</p>
            </div>
            <div style="text-align:right;">
                <button id="btn-commit-new-game" style="background:#28a745; color:white; border:none; padding:8px 16px; border-radius:4px; cursor:pointer; font-weight:bold; display:none;">
                    Save & Add to History
                </button>
            </div>
        `;
        wrapper.appendChild(newGameSection);
        
        const rowsContainer = newGameSection.querySelector("#new-game-rows-container");
        const placeholder = newGameSection.querySelector("#new-game-placeholder");
        const commitBtn = newGameSection.querySelector("#btn-commit-new-game");
        const clearBtn = newGameSection.querySelector("#btn-clear-list");

        const createTeamSelect = (teams, selected) => {
            const s = document.createElement("select");
            s.style.width = "120px";
            s.innerHTML = `<option value="">-- Team --</option>` + teams.map(t => `<option value="${t}">${t}</option>`).join('');
            if(selected) s.value = selected;
            return s;
        };

        const addStagingRow = (teamA = "", teamB = "", scoreA = 0, scoreB = 0, timeLabel = "") => {
            if(placeholder) placeholder.style.display = "none";
            commitBtn.style.display = "inline-block";

            const row = document.createElement("div");
            row.className = "staging-row";
            row.style.display = "flex";
            row.style.alignItems = "center";
            row.style.gap = "10px";
            row.style.marginBottom = "8px";
            row.style.padding = "5px";
            row.style.borderBottom = "1px dashed #eee";

            const timeHTML = timeLabel 
                ? `<span class="time-badge">${timeLabel}</span>` 
                : `<span class="time-badge" style="background:transparent;"></span>`;

            const selA = createTeamSelect(league.teams, teamA);
            const inpA = document.createElement("input"); 
            // NO ARROWS: type="text" + inputmode="numeric"
            inpA.type = "text"; inpA.inputMode = "numeric"; inpA.value = scoreA; inpA.style.width = "50px";
            
            const vs = document.createElement("span"); vs.textContent = "vs";
            
            const inpB = document.createElement("input"); 
            inpB.type = "text"; inpB.inputMode = "numeric"; inpB.value = scoreB; inpB.style.width = "50px";
            
            const selB = createTeamSelect(league.teams, teamB);
            
            const remBtn = document.createElement("button");
            remBtn.textContent = "×";
            remBtn.style.color = "red";
            remBtn.style.border = "1px solid red";
            remBtn.style.background = "white";
            remBtn.style.cursor = "pointer";
            remBtn.onclick = () => {
                row.remove();
                if(rowsContainer.querySelectorAll(".staging-row").length === 0) {
                    if(placeholder) placeholder.style.display = "block";
                    commitBtn.style.display = "none";
                }
            };
            
            row.innerHTML = timeHTML;
            row.append(selA, inpA, vs, inpB, selB, remBtn);
            rowsContainer.appendChild(row);
        };

        newGameSection.querySelector("#btn-add-manual-row").onclick = () => addStagingRow();
        clearBtn.onclick = () => {
            rowsContainer.innerHTML = '';
            rowsContainer.appendChild(placeholder);
            placeholder.style.display = "block";
            commitBtn.style.display = "none";
        };

        newGameSection.querySelector("#btn-import-schedule").onclick = () => {
            const daily = window.loadCurrentDailyData?.() || {};
            const assignments = daily.scheduleAssignments || {};
            const times = window.unifiedTimes || [];
            const foundPairs = new Set();
            let count = 0;

            Object.keys(assignments).forEach(bunkName => {
                const schedule = assignments[bunkName];
                if(!schedule) return;

                schedule.forEach((entry, slotIndex) => {
                    // IMPORTANT FIX: SKIP CONTINUATIONS to avoid duplicate rows
                    if(entry && entry._h2h && !entry.continuation) {
                        const matchStr = entry.sport || "";
                        const m = matchStr.match(/^(.*?) vs (.*?) \(/);
                        if(m) {
                            const t1 = m[1].trim();
                            const t2 = m[2].trim();
                            
                            if(league.teams.includes(t1) && league.teams.includes(t2)) {
                                const timeStr = times[slotIndex]?.label || "Unknown Time";
                                const key = [t1, t2].sort().join("|||") + "::" + timeStr;
                                
                                if(!foundPairs.has(key)) {
                                    foundPairs.add(key);
                                    addStagingRow(t1, t2, 0, 0, timeStr);
                                    count++;
                                }
                            }
                        }
                    }
                });
            });
            if(count === 0) alert("No matching scheduled games found for today.");
        };

        commitBtn.onclick = () => {
            const rows = rowsContainer.querySelectorAll(".staging-row");
            const newMatches = [];
            rows.forEach(r => {
                const selects = r.querySelectorAll("select");
                const inputs = r.querySelectorAll("input");
                const tA = selects[0].value;
                const tB = selects[1].value;
                const sA = parseInt(inputs[0].value) || 0;
                const sB = parseInt(inputs[1].value) || 0;
                
                if(tA && tB && tA !== tB) {
                    let w = 'tie';
                    if(sA > sB) w = tA;
                    if(sB > sA) w = tB;
                    newMatches.push({ teamA: tA, teamB: tB, scoreA: sA, scoreB: sB, winner: w });
                }
            });

            if(newMatches.length > 0) {
                league.games.push({
                    id: Date.now(),
                    name: `Game Set ${league.games.length + 1}`,
                    date: window.currentScheduleDate || new Date().toLocaleDateString(),
                    matches: newMatches
                });
                saveLeaguesData();
                renderDetailPane(); 
            }
        };

        // --- EXISTING GAMES (COLLAPSIBLE) ---
        const historyDetails = document.createElement("details");
        historyDetails.style.marginTop = "20px";
        historyDetails.style.border = "1px solid #ccc";
        historyDetails.style.borderRadius = "5px";
        historyDetails.style.padding = "5px";
        
        const summary = document.createElement("summary");
        summary.textContent = "View Game History";
        summary.style.fontWeight = "bold";
        summary.style.padding = "10px";
        summary.style.cursor = "pointer";
        historyDetails.appendChild(summary);
        
        const historyContent = document.createElement("div");
        historyContent.style.padding = "10px";
        historyDetails.appendChild(historyContent);
        wrapper.appendChild(historyDetails);

        (league.games || []).slice().reverse().forEach((g, gIdx) => {
            const gDiv = document.createElement("div");
            gDiv.style.border = "1px solid #eee";
            gDiv.style.marginBottom = "10px";
            gDiv.innerHTML = `<div style="background:#f9f9f9; padding:5px; font-size:0.9em;"><strong>${g.name}</strong> (${g.date})</div>`;
            
            g.matches.forEach((m, mIdx) => {
                const row = document.createElement("div");
                row.style.display = "flex";
                row.style.alignItems = "center";
                row.style.padding = "5px";
                row.style.gap = "5px";
                
                const tA = document.createElement("span"); tA.textContent = m.teamA; tA.style.flex = "1"; tA.style.textAlign = "right";
                
                const inA = document.createElement("input"); 
                inA.type = "text"; inA.inputMode = "numeric"; // No Arrows
                inA.value = m.scoreA; inA.style.width = "40px";
                
                const inB = document.createElement("input"); 
                inB.type = "text"; inB.inputMode = "numeric"; // No Arrows
                inB.value = m.scoreB; inB.style.width = "40px";
                
                const tB = document.createElement("span"); tB.textContent = m.teamB; tB.style.flex = "1";

                const doSave = () => {
                    m.scoreA = parseInt(inA.value) || 0;
                    m.scoreB = parseInt(inB.value) || 0;
                    if(m.scoreA > m.scoreB) m.winner = m.teamA;
                    else if(m.scoreB > m.scoreA) m.winner = m.teamB;
                    else m.winner = 'tie';
                    saveLeaguesData();
                };
                inA.oninput = doSave;
                inB.oninput = doSave;

                row.append(tA, inA, document.createTextNode("-"), inB, tB);
                gDiv.appendChild(row);
            });
            historyContent.appendChild(gDiv);
        });
    }

    loadLeaguesData();
    loadRoundState();

})();
