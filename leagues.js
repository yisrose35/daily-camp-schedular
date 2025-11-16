// ===================================================================
// leagues.js — CLEAN, ERROR-FREE EDITION (Nov 2025)
// Works with: scheduler_logic_core.js (Ultimate Rotation Edition)
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
        if (window.saveCurrentDailyData) {
            const data = window.loadCurrentDailyData() || {};
            data.leagueRoundState = leagueRoundState;
            window.saveCurrentDailyData(data);
        }
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
        loadRoundState();
        renderLeaguesTab();
    };

    // ---------------------------------------------------------------
    // MAIN TAB RENDERER
    // ---------------------------------------------------------------
    function renderLeaguesTab() {
        const container = document.getElementById("leagues");
        if (!container) return;

        container.innerHTML = `
            <div style="padding:20px; font-family:Arial;">
                <h1 style="color:#1a5fb4;">Ultimate League Manager</h1>
                <p style="color:#444;">Create and optimize leagues with perfect matchups and perfect sport rotation.</p>

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

                <div id="ultimate-preview"
                    style="margin-top:40px; padding:25px; border:3px solid #00d4aa;
                           border-radius:12px; background:#f0fffa; display:none;">
                    <h2 style="color:#00a085;">Perfect Rotation Generated!</h2>
                    <div id="preview-table" style="overflow-x:auto;"></div>

                    <button id="save-ultimate-schedule"
                        style="margin-top:20px; padding:14px 32px; font-size:1.2em;
                               background:#00d4aa; color:white; border:none;
                               border-radius:8px; cursor:pointer;">
                        Save & Apply Schedule
                    </button>
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
            standings: {}
        };

        saveLeaguesData();
        renderLeagueList();
        editLeague(clean);
    }

    // ---------------------------------------------------------------
    // EDIT LEAGUE UI
    // ---------------------------------------------------------------
    window.editLeague = function (name) {
        const league = leaguesByName[name];
        const editor = document.getElementById("league-editor");
        if (!editor) return;

        editor.style.display = "block";

        const allSports = window.getAllGlobalSports?.() || [];

        editor.innerHTML = `
            <h2 style="color:#1a5fb4;">Editing: ${name}</h2>
            <button onclick="deleteLeague('${name}')"
                style="float:right; background:#d40000; color:white; padding:6px 12px;
                       border:none; border-radius:6px; cursor:pointer;">
                Delete
            </button>

            <h3 style="margin-top:20px;">Teams:</h3>
            <div id="team-picker"></div>

            <h3 style="margin-top:20px;">Sports:</h3>
            <select id="sport-selector" multiple size="8"
                style="width:100%; padding:10px; border-radius:6px;">
                ${allSports.map(s => `<option value="${s}">${s}</option>`).join("")}
            </select>

            <button id="generate-ultimate-btn"
                style="margin-top:30px; padding:16px 30px; background:#00d4aa;
                       color:white; border:none; border-radius:10px; cursor:pointer;
                       font-size:1.2em;">
                GENERATE ULTIMATE ROTATION
            </button>
        `;

        renderTeamPicker(name, league.teams);

        const sportSel = document.getElementById("sport-selector");
        (league.sports || []).forEach(s => {
            const opt = sportSel.querySelector(`option[value="${s}"]`);
            if (opt) opt.selected = true;
        });

        document.getElementById("generate-ultimate-btn").onclick = () => {
            const selectedTeams = getSelectedTeams();
            const selectedSports = Array.from(sportSel.selectedOptions).map(o => o.value);

            if (selectedTeams.length < 2) return alert("Select at least 2 teams.");
            if (selectedSports.length === 0) return alert("Select at least 1 sport.");

            const schedule = window.generateUltimateLeagueRotation(
                name,
                selectedTeams,
                selectedSports,
                window.fieldsBySport || {},
                { slots: [0,1,2,3,4,5,6,7] }
            );

            showUltimatePreview(schedule, name);
        };
    };

    // ---------------------------------------------------------------
    // TEAM PICKER
    // ---------------------------------------------------------------
    function renderTeamPicker(leagueName, selectedTeams) {
        const container = document.getElementById("team-picker");
        container.innerHTML = "";

        selectedTeams.forEach(team => {
            const btn = document.createElement("button");
            btn.textContent = team;
            btn.style.padding = "6px 12px";
            btn.style.margin = "3px";
            btn.style.borderRadius = "6px";
            btn.style.border = "1px solid #555";
            btn.style.cursor = "pointer";

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
                if (!leaguesByName[leagueName].teams.includes(val)) {
                    leaguesByName[leagueName].teams.push(val);
                    saveLeaguesData();
                }
                editLeague(leagueName);
            }
        };
        container.appendChild(input);
    }

    function getSelectedTeams() {
        return Array.from(document.querySelectorAll("#team-picker button"))
            .map(btn => btn.textContent);
    }

    // ---------------------------------------------------------------
    // DELETE LEAGUE
    // ---------------------------------------------------------------
    window.deleteLeague = function (name) {
        if (!confirm(`Delete "${name}"?`)) return;

        delete leaguesByName[name];
        saveLeaguesData();
        renderLeagueList();
        document.getElementById("league-editor").style.display = "none";
        document.getElementById("ultimate-preview").style.display = "none";
    };

    // ---------------------------------------------------------------
    // PREVIEW TABLE
    // ---------------------------------------------------------------
    function showUltimatePreview(schedule, leagueName) {
        const block = document.getElementById("ultimate-preview");
        const tableDiv = document.getElementById("preview-table");

        block.style.display = "block";

        let html = `
            <table style="width:100%; border-collapse:collapse;">
                <thead>
                    <tr style="background:#00a085; color:white;">
                        <th>Round</th>
                        <th>Team A</th>
                        <th></th>
                        <th>Team B</th>
                        <th>Sport</th>
                        <th>Field</th>
                    </tr>
                </thead>
                <tbody>
        `;

        schedule.forEach(m => {
            if (!m.isBye) {
                html += `
                    <tr style="background:#f8f9fa;">
                        <td>${m.round}</td>
                        <td>${m.teamA}</td>
                        <td style="text-align:center;font-weight:bold;">VS</td>
                        <td>${m.teamB}</td>
                        <td>${m.sport}</td>
                        <td>${m.field}</td>
                    </tr>
                `;
            }
        });

        html += "</tbody></table>";
        tableDiv.innerHTML = html;

        document.getElementById("save-ultimate-schedule").onclick = () => {
            const data = window.loadCurrentDailyData() || {};
            data.ultimateLeagueSchedules = data.ultimateLeagueSchedules || {};
            data.ultimateLeagueSchedules[leagueName] = schedule;
            window.saveCurrentDailyData(data);

            alert("Perfect rotation saved!");
        };
    }

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
        window.leaguesByName = leaguesByName;
    }

    // ---------------------------------------------------------------
    // Initialize on script load
    // ---------------------------------------------------------------
    loadLeaguesData();
    loadRoundState();
})();
