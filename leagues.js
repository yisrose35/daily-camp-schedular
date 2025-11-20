=================================================================== // leagues.js // // UPDATED: // - Fixed Syntax Error (removed stray brace). // - Matches fields.js layout (Split View). // - Auto-saves on changes. // ===================================================================

(function () { 'use strict';

let leaguesByName = {};
window.leaguesByName = leaguesByName;

let leagueRoundState = {};
window.leagueRoundState = leagueRoundState;

// UI State
let selectedLeagueName = null;
let activeSubView = null;

let listEl = null;
let detailPaneEl = null;

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

// --- HELPER: Editable Text ---
function makeEditable(el, save) {
    el.ondblclick = e => {
        e.stopPropagation();
        const old = el.textContent;
        const input = document.createElement("input");
        input.type = "text"; input.value = old;
        el.replaceWith(input); input.focus();
        function done() {
            const val = input.value.trim();
            if (val && val !== old) save(val);
            el.textContent = val || old; input.replaceWith(el);
        }
        input.onblur = done; input.onkeyup = e => { if (e.key === "Enter") done(); };
    };
}

window.initLeagues = function () {
    const container = document.getElementById("leaguesContainer");
    if (!container) return;

    loadLeaguesData();
    loadRoundState();

    // --- 1. RENDER LAYOUT (Split View) ---
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
            .master-list .list-item {
                padding: 12px 10px;
                border: 1px solid #ddd;
                border-radius: 5px;
                margin-bottom: 5px;
                cursor: pointer;
                display: flex;
                justify-content: space-between;
                align-items: center;
                background: #fff;
            }
            .master-list .list-item:hover { background: #f9f9f9; }
            .master-list .list-item.selected {
                background: #e7f3ff; border-color: #007bff; font-weight: 600;
            }
            .master-list .list-item-name { flex-grow: 1; }
            .detail-pane {
                border: 1px solid #ccc; border-radius: 8px; padding: 20px;
                background: #fdfdfd; min-height: 400px;
            }
            .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px; }
            .chip { padding: 4px 8px; border-radius: 12px; border: 1px solid #ccc; cursor: pointer; }
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
    
    // Restore state if exists
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
        
        // Toggle
        const tog = document.createElement("label"); 
        tog.className = "switch";
        tog.onclick = (e) => e.stopPropagation();
        const cb = document.createElement("input"); 
        cb.type = "checkbox"; 
        cb.checked = item.enabled;
        cb.onchange = () => { 
            item.enabled = cb.checked; 
            saveLeaguesData(); 
        };
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

    // 1. Header (Name + Delete)
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
    
    const closeBtn = document.createElement('button');
    closeBtn.textContent = "Close";
    closeBtn.style.marginRight = "10px";
    closeBtn.style.background = "#555";
    closeBtn.style.color = "white";
    closeBtn.onclick = () => {
        selectedLeagueName = null;
        renderMasterList();
        detailPaneEl.innerHTML = `<p class="muted">Select a league.</p>`;
    };

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
    btnGroup.appendChild(closeBtn);
    btnGroup.appendChild(delBtn);
    header.appendChild(btnGroup);
    detailPaneEl.appendChild(header);

    // 2. Standings Area (Hidden by default)
    const standingsContainer = document.createElement("div");
    standingsContainer.id = "league-standings-ui";
    standingsContainer.style.display = "none";
    standingsContainer.style.marginBottom = "20px";
    standingsContainer.style.padding = "15px";
    standingsContainer.style.border = "1px solid #ccc";
    standingsContainer.style.background = "#fff";
    standingsContainer.style.borderRadius = "8px";
    detailPaneEl.appendChild(standingsContainer);

    // Toggle Logic
    const toggleStandings = () => {
        if (standingsContainer.style.display === 'none') {
            standingsContainer.style.display = 'block';
            renderGameResultsUI(league, standingsContainer);
            standingsBtn.textContent = "Close Standings";
            activeSubView = 'standings';
        } else {
            standingsContainer.style.display = 'none';
            standingsBtn.textContent = "Manage Standings / Games";
            activeSubView = null;
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
            saveLeaguesData();
            renderDetailPane(); // Re-render to update chips
        };
        divChips.appendChild(chip);
    });
    divSec.appendChild(divChips);
    detailPaneEl.appendChild(divSec);

    // 4. Sports
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

    // 5. Teams
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

// --- GAME RESULTS UI ---
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

    const showStandings = () => {
        content.innerHTML = renderStandingsHTML(league);
    };

    const showGames = () => {
        content.innerHTML = "";
        renderGamesUI(league, content);
    };

    tabs.querySelector("#tab-std").onclick = showStandings;
    tabs.querySelector("#tab-gms").onclick = showGames;

    showStandings(); // Default
}

function renderStandingsHTML(league) {
    // Recalc logic
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
    // Add New Game Block
    const newGameDiv = document.createElement("div");
    newGameDiv.style.padding = "10px";
    newGameDiv.style.background = "#f9f9f9";
    newGameDiv.style.marginBottom = "15px";
    newGameDiv.innerHTML = `<strong>Add New Game:</strong><br>`;
    
    const importBtn = document.createElement("button");
    importBtn.textContent = "Import Today's Matchups";
    importBtn.onclick = () => {
        // Logic to pull from schedule would go here
        alert("Function to import from schedule needs to be connected to schedule data.");
    };
    newGameDiv.appendChild(importBtn);
    wrapper.appendChild(newGameDiv);

    // List Existing Games
    (league.games || []).forEach((g, gIdx) => {
        const gDiv = document.createElement("div");
        gDiv.style.border = "1px solid #eee";
        gDiv.style.marginBottom = "5px";
        gDiv.innerHTML = `<div style="background:#eee; padding:5px;"><strong>${g.name}</strong> (${g.date})</div>`;
        
        g.matches.forEach((m, mIdx) => {
            const row = document.createElement("div");
            row.style.display = "flex";
            row.style.alignItems = "center";
            row.style.padding = "5px";
            row.style.gap = "5px";
            
            // Score Inputs
            const inA = document.createElement("input");
            inA.type = "number"; inA.value = m.scoreA; inA.style.width = "40px";
            const inB = document.createElement("input");
            inB.type = "number"; inB.value = m.scoreB; inB.style.width = "40px";
            
            // SAVE ON CHANGE (Instant save)
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

            row.appendChild(document.createTextNode(m.teamA));
            row.appendChild(inA);
            row.appendChild(document.createTextNode("-"));
            row.appendChild(inB);
            row.appendChild(document.createTextNode(m.teamB));
            gDiv.appendChild(row);
        });
        wrapper.appendChild(gDiv);
    });
}
})();

}
