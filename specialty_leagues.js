// =================================================================
// specialty_leagues.js
//
// UPDATED:
// - MATCHES LEAGUES.JS LAYOUT (Split View).
// - Uses makeEditable for renaming.
// - Auto-saves on change/blur.
// =================================================================

(function() {
    'use strict';

    let specialtyLeagues = {}; 
    let activeLeagueId = null;
    let activeSubView = null; // 'standings' or null

    let listEl = null;
    let detailPaneEl = null;

    function loadData() {
        const globalSettings = window.loadGlobalSettings?.() || {};
        specialtyLeagues = globalSettings.specialtyLeagues || {};
    }

    function saveData() {
        window.saveGlobalSettings?.("specialtyLeagues", specialtyLeagues);
    }

    function uid() {
        return `sl_${Math.random().toString(36).slice(2, 9)}`;
    }

    // --- HELPER: Editable Text (Double-click to rename) ---
    function makeEditable(el, saveCallback) {
        el.ondblclick = e => {
            e.stopPropagation();
            const oldText = el.textContent;
            const input = document.createElement("input");
            input.type = "text";
            input.value = oldText;
            
            // Swap text for input
            el.replaceWith(input);
            input.focus();

            const finish = () => {
                const newVal = input.value.trim();
                if (newVal && newVal !== oldText) {
                    saveCallback(newVal);
                }
                // Swap back to text element
                el.textContent = newVal || oldText;
                input.replaceWith(el);
            };

            input.onblur = finish;
            input.onkeyup = (ev) => {
                if (ev.key === "Enter") finish();
            };
        };
    }

    // --- MAIN INIT ---
    window.initSpecialtyLeagues = function() {
        const container = document.getElementById("specialtyLeaguesContainer");
        if (!container) return;

        loadData(); 

        // 1. Render Layout (Split View)
        container.innerHTML = `
            <div style="display: flex; flex-wrap: wrap; gap: 20px;">
                
                <!-- LEFT COLUMN: List -->
                <div style="flex: 1; min-width: 300px;">
                    <h3>Add New Specialty League</h3>
                    <div style="display: flex; gap: 10px; margin-bottom: 20px;">
                        <input id="new-sl-input" placeholder="Name (e.g., Basketball League)" style="flex: 1;">
                        <button id="add-sl-btn">Add</button>
                    </div>

                    <h3>All Specialty Leagues</h3>
                    <div id="sl-master-list" class="master-list"></div>
                </div>

                <!-- RIGHT COLUMN: Details -->
                <div style="flex: 2; min-width: 400px; position: sticky; top: 20px;">
                    <h3>Details</h3>
                    <div id="sl-detail-pane" class="detail-pane">
                        <p class="muted">Select a league to edit.</p>
                    </div>
                </div>
            </div>
            
            <style>
                .master-list .list-item {
                    padding: 12px 10px; border: 1px solid #ddd; border-radius: 5px;
                    margin-bottom: 5px; cursor: pointer; background: #fff;
                    display: flex; justify-content: space-between; align-items: center;
                }
                .master-list .list-item:hover { background: #f9f9f9; }
                .master-list .list-item.selected { background: #e7f3ff; border-color: #007bff; font-weight: 600; }
                .master-list .list-item-name { flex-grow: 1; }
                
                .detail-pane { border: 1px solid #ccc; border-radius: 8px; padding: 20px; background: #fdfdfd; min-height: 400px; }
                .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px; }
                .chip { padding: 4px 8px; border-radius: 12px; border: 1px solid #ccc; cursor: pointer; }
            </style>
        `;

        listEl = document.getElementById("sl-master-list");
        detailPaneEl = document.getElementById("sl-detail-pane");
        
        const addInput = document.getElementById("new-sl-input");
        const addBtn = document.getElementById("add-sl-btn");

        // Add Handler
        const addLeague = () => {
            const name = addInput.value.trim();
            if (!name) return;
            
            const id = uid();
            specialtyLeagues[id] = { 
                id, 
                name, 
                divisions: [], 
                sport: null, 
                fields: [], 
                teams: [], 
                enabled: true, 
                standings: {}, 
                games: [] 
            };
            saveData();
            
            activeLeagueId = id;
            addInput.value = "";
            renderMasterList();
            renderDetailPane();
        };

        addBtn.onclick = addLeague;
        addInput.onkeyup = (e) => { if(e.key === "Enter") addLeague(); };

        renderMasterList();
        
        // Restore State
        if (activeLeagueId && specialtyLeagues[activeLeagueId]) {
            renderDetailPane();
        }
    };

    // --- RENDER MASTER LIST (LEFT) ---
    function renderMasterList() {
        listEl.innerHTML = "";
        const sortedLeagues = Object.values(specialtyLeagues).sort((a,b) => a.name.localeCompare(b.name));
        
        if (sortedLeagues.length === 0) {
            listEl.innerHTML = `<p class="muted">No specialty leagues created yet.</p>`;
            return;
        }

        sortedLeagues.forEach(l => {
            const el = document.createElement('div');
            el.className = 'list-item';
            if (l.id === activeLeagueId) el.classList.add('selected');
            
            el.onclick = () => {
                activeLeagueId = l.id;
                renderMasterList();
                renderDetailPane();
            };

            el.innerHTML = `<span class="list-item-name">${l.name}</span>`;

            // Toggle Switch
            const tog = document.createElement("label"); 
            tog.className = "switch";
            tog.onclick = (e) => e.stopPropagation();
            
            const cb = document.createElement("input"); 
            cb.type = "checkbox"; 
            cb.checked = l.enabled;
            cb.onchange = () => { 
                l.enabled = cb.checked; 
                saveData(); 
            };
            
            tog.append(cb, document.createElement("span"));
            tog.querySelector("span").className = "slider";
            el.appendChild(tog);

            listEl.appendChild(el);
        });
    }

    // --- RENDER DETAILS (RIGHT) ---
    function renderDetailPane() {
        if (!activeLeagueId || !specialtyLeagues[activeLeagueId]) {
            detailPaneEl.innerHTML = `<p class="muted">Select a league from the list.</p>`;
            return;
        }

        const league = specialtyLeagues[activeLeagueId];
        detailPaneEl.innerHTML = "";

        // 1. Header (Name + Buttons)
        const header = document.createElement('div');
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.marginBottom = '15px';
        header.style.borderBottom = '2px solid #eee';
        header.style.paddingBottom = '10px';
        
        const title = document.createElement('h2');
        title.style.margin = '0';
        title.textContent = league.name;
        title.title = "Double-click to rename";
        
        makeEditable(title, (newName) => {
            if(newName) {
                league.name = newName;
                saveData();
                renderMasterList();
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
            if(confirm("Are you sure you want to delete this league?")) {
                delete specialtyLeagues[activeLeagueId];
                activeLeagueId = null;
                saveData();
                renderMasterList();
                detailPaneEl.innerHTML = `<p class="muted">Select a league.</p>`;
            }
        };

        btnGroup.appendChild(standingsBtn);
        btnGroup.appendChild(delBtn);
        header.appendChild(btnGroup);
        detailPaneEl.appendChild(header);

        // 2. Standings/Games Container (Hidden by default)
        const standingsContainer = document.createElement("div");
        standingsContainer.id = "sl-standings-ui";
        standingsContainer.style.display = "none";
        standingsContainer.style.marginBottom = "20px";
        standingsContainer.style.padding = "15px";
        standingsContainer.style.border = "1px solid #ccc";
        standingsContainer.style.background = "#fff";
        standingsContainer.style.borderRadius = "8px";
        detailPaneEl.appendChild(standingsContainer);

        // Toggle Logic
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

        // 3. Divisions
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
                saveData(); // Auto-save
                renderDetailPane(); // Refresh UI
            };
            divChips.appendChild(chip);
        });
        divSec.appendChild(divChips);
        detailPaneEl.appendChild(divSec);

        // 4. Sport Selection
        const sportSec = document.createElement("div");
        sportSec.style.marginTop = "15px";
        sportSec.innerHTML = `<strong>Sport:</strong> `;
        const sportSel = document.createElement("select");
        sportSel.innerHTML = `<option value="">-- Select --</option>`;
        (window.getAllGlobalSports?.() || []).forEach(s => {
            sportSel.innerHTML += `<option value="${s}" ${league.sport === s ? 'selected' : ''}>${s}</option>`;
        });
        sportSel.onchange = () => {
            league.sport = sportSel.value;
            // Clear fields if sport changes (since fields are sport-specific)
            league.fields = []; 
            saveData(); // Auto-save
            renderDetailPane(); // Refresh to update Field list
        };
        sportSec.appendChild(sportSel);
        detailPaneEl.appendChild(sportSec);

        // 5. Fields (Filtered by Sport)
        if (league.sport) {
            const fieldSec = document.createElement("div");
            fieldSec.style.marginTop = "15px";
            fieldSec.innerHTML = `<strong>Fields (for ${league.sport}):</strong>`;
            const fieldChips = document.createElement("div");
            fieldChips.className = "chips";
            
            // Get fields matching this sport
            const allFields = window.loadGlobalSettings?.().app1.fields || [];
            const relevantFields = allFields.filter(f => f.activities && f.activities.includes(league.sport));
            
            if (relevantFields.length === 0) {
                fieldChips.innerHTML = `<span class="muted" style="font-size:0.9em;">No fields found for ${league.sport}. Check 'Fields' tab.</span>`;
            } else {
                relevantFields.forEach(f => {
                    const fName = f.name;
                    const isActive = (league.fields || []).includes(fName);
                    const chip = document.createElement('span');
                    chip.className = 'chip';
                    chip.textContent = fName;
                    chip.style.background = isActive ? '#007BFF' : '#f0f0f0';
                    chip.style.color = isActive ? 'white' : 'black';
                    chip.onclick = () => {
                        if (isActive) league.fields = league.fields.filter(n => n !== fName);
                        else {
                            if(!league.fields) league.fields = [];
                            league.fields.push(fName);
                        }
                        saveData();
                        renderDetailPane();
                    };
                    fieldChips.appendChild(chip);
                });
            }
            fieldSec.appendChild(fieldChips);
            detailPaneEl.appendChild(fieldSec);
        }

        // 6. Teams
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
                // Also clear from standings if removed
                if(league.standings) delete league.standings[team];
                saveData(); // Auto-save
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
                    // Initialize standings
                    if(!league.standings) league.standings = {};
                    league.standings[t] = { w:0, l:0, t:0 };
                    saveData(); // Auto-save
                    renderDetailPane();
                }
            }
        };
        teamSec.appendChild(teamInput);
        detailPaneEl.appendChild(teamSec);
    }

    // --- GAME RESULTS & STANDINGS LOGIC (Same as leagues.js) ---

    function renderGameResultsUI(league, container) {
        container.innerHTML = "";
        
        const tabs = document.createElement("div");
        tabs.innerHTML = `
            <button id="sl-tab-std" style="margin-right:5px; padding:5px 10px;">Standings</button>
            <button id="sl-tab-gms" style="padding:5px 10px;">Game History</button>
        `;
        container.appendChild(tabs);
        
        const content = document.createElement("div");
        content.style.marginTop = "10px";
        container.appendChild(content);

        const showStandings = () => {
            content.innerHTML = renderStandingsHTML(league);
        };

        const showGames = () => {
            content.innerHTML = "";
            renderGamesUI(league, content);
        };

        tabs.querySelector("#sl-tab-std").onclick = showStandings;
        tabs.querySelector("#sl-tab-gms").onclick = showGames;

        showStandings(); // Default
    }

    function renderStandingsHTML(league) {
        // Reset Stats
        league.teams.forEach(t => {
            if(!league.standings) league.standings = {};
            league.standings[t] = { w:0, l:0, t:0 };
        });

        // Recalc from Games
        (league.games || []).forEach(g => {
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
        // Add New Game
        const newGameDiv = document.createElement("div");
        newGameDiv.style.padding = "10px";
        newGameDiv.style.background = "#f9f9f9";
        newGameDiv.style.marginBottom = "15px";
        newGameDiv.style.border = "1px solid #eee";
        newGameDiv.innerHTML = `<strong>Add New Game Entry:</strong><br>`;
        
        const importBtn = document.createElement("button");
        importBtn.textContent = "Import Today's Matchups (Coming Soon)";
        importBtn.onclick = () => {
            alert("Auto-import logic will check the daily schedule.");
        };
        newGameDiv.appendChild(importBtn);
        wrapper.appendChild(newGameDiv);

        // List Games
        (league.games || []).forEach((g, gIdx) => {
            const gDiv = document.createElement("div");
            gDiv.style.border = "1px solid #eee";
            gDiv.style.marginBottom = "10px";
            gDiv.innerHTML = `<div style="background:#eee; padding:5px; font-size:0.9em;"><strong>${g.name}</strong> (${g.date})</div>`;
            
            g.matches.forEach((m, mIdx) => {
                const row = document.createElement("div");
                row.style.display = "flex";
                row.style.alignItems = "center";
                row.style.padding = "5px";
                row.style.gap = "5px";
                
                const tA = document.createElement("span");
                tA.textContent = m.teamA;
                tA.style.flex = "1";
                tA.style.textAlign = "right";
                
                const inA = document.createElement("input");
                inA.type = "number"; inA.value = m.scoreA; inA.style.width = "40px";
                const inB = document.createElement("input");
                inB.type = "number"; inB.value = m.scoreB; inB.style.width = "40px";
                
                // Instant Save
                const doSave = () => {
                    m.scoreA = parseInt(inA.value) || 0;
                    m.scoreB = parseInt(inB.value) || 0;
                    if(m.scoreA > m.scoreB) m.winner = m.teamA;
                    else if(m.scoreB > m.scoreA) m.winner = m.teamB;
                    else m.winner = 'tie';
                    saveData(); // Auto-save
                };
                inA.oninput = doSave;
                inB.oninput = doSave;

                const tB = document.createElement("span");
                tB.textContent = m.teamB;
                tB.style.flex = "1";

                row.appendChild(tA);
                row.appendChild(inA);
                row.appendChild(document.createTextNode("-"));
                row.appendChild(inB);
                row.appendChild(tB);
                gDiv.appendChild(row);
            });
            wrapper.appendChild(gDiv);
        });
    }

})();
