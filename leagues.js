// ===================================================================
// leagues.js — ULTIMATE LEAGUE MANAGER + STANDINGS + ROUND-ROBIN
// Combined file — Nov 15, 2025
//
// - Keeps your existing League Setup + Standings UI.
// - Keeps league_scheduling.js round-robin + state persistence.
// - NEW: Adds "Ultimate Rotation Preview" per league, which uses
//   window.generateUltimateLeagueRotation from scheduler_logic_core.js.
// ===================================================================

// Internal store keyed by LEAGUE NAME for UI/storage
let leaguesByName = {};
// app2 expects window.leagues keyed by DIVISION NAME -> { enabled: boolean }
// app2 also reads window.leaguesByName (full map)

// -------------------- Helpers --------------------

/**
 * NEW Helper: Gets the suffix for a place number (1st, 2nd, 3rd)
 */
function getPlaceSuffix(n) {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return (s[(v - 20) % 10] || s[v] || s[0]);
}

function publishDivisionToggleMap() {
    const divMap = {};
    Object.values(leaguesByName).forEach(lg => {
        if (lg?.enabled && Array.isArray(lg.divisions)) {
            lg.divisions.forEach(d => { if (d) divMap[d] = { enabled: true }; });
        }
    });
    window.leagues = divMap;
}

function saveLeagues() {
    // UPDATED: Save to global settings
    window.saveGlobalSettings?.("leaguesByName", leaguesByName);

    window.leaguesByName = leaguesByName; // publish full map
    publishDivisionToggleMap();
}

/**
 * UPDATED: Now loads and initializes the `standings` object
 * for each league and team.
 */
function loadLeagues() {
    // UPDATED: Load from global settings
    const global = window.loadGlobalSettings?.() || {};
    const stored = global.leaguesByName;

    leaguesByName = stored || {};
    Object.keys(leaguesByName).forEach(name => {
        const l = leaguesByName[name] || {};
        if (typeof l.enabled === "undefined") l.enabled = false;
        l.divisions = Array.isArray(l.divisions) ? l.divisions : [];
        l.sports = Array.isArray(l.sports) ? l.sports : [];
        l.teams = Array.isArray(l.teams) ? l.teams : [];

        // NEW: Initialize standings object
        l.standings = l.standings || {};
        // Ensure every team has a standings entry
        l.teams.forEach(team => {
            l.standings[team] = l.standings[team] || { w: 0, l: 0, t: 0 };
        });

        leaguesByName[name] = l;
    });
    window.leaguesByName = leaguesByName; // publish full map
    publishDivisionToggleMap();
}

// -------------------- UI --------------------

/**
 * --- Main UI Rendering Function ---
 * Renders the dropdown nav and the two content panes.
 */
function renderLeagueUI() {
    const leaguesContainer = document.getElementById("leaguesContainer");
    if (!leaguesContainer) return;

    // 1. Build the new navigation UI
    leaguesContainer.innerHTML = `
        <div class="league-nav">
            <label for="league-view-select">Select View:</label>
            <select id="league-view-select">
                <option value="">-- Select View --</option>
                <option value="setup">League Setup</option>
                <option value="standings">League Standings</option>
            </select>
        </div>

        <div id="league-setup-content" class="league-content-pane"></div>
        <div id="league-standings-content" class="league-content-pane"></div>
    ";

    // 2. Render the content for both panes
    renderLeagueSetupUI();
    renderLeagueStandingsUI();

    // 3. Hook up the dropdown
    document.getElementById("league-view-select").onchange = (e) => {
        const selected = e.target.value;
        const setupPane = document.getElementById("league-setup-content");
        const standingsPane = document.getElementById("league-standings-content");

        if (selected === 'setup') {
            setupPane.classList.add("active");
            standingsPane.classList.remove("active");
        } else if (selected === 'standings') {
            setupPane.classList.remove("active");
            standingsPane.classList.add("active");
        } else {
            // "none" state
            setupPane.classList.remove("active");
            standingsPane.classList.remove("active");
        }
    };
}

/**
 * --- Standings UI ---
 * Creates a sorted grid for each division with a league.
 * Includes Place column.
 */
function renderLeagueStandingsUI() {
    const container = document.getElementById("league-standings-content");
    if (!container) return;

    container.innerHTML = ""; // Clear

    const allDivisions = window.availableDivisions || [];
    let gridsRendered = 0;

    allDivisions.forEach(divName => {
        // Find the first *enabled* league associated with this division
        const leagueEntry = Object.entries(leaguesByName).find(([name, l]) =>
            l.enabled && l.divisions.includes(divName)
        );

        if (!leagueEntry || leagueEntry[1].teams.length === 0) {
            return; // No league or no teams for this division, skip
        }

        gridsRendered++;

        const leagueName = leagueEntry[0]; // league name
        const league = leagueEntry[1];     // league object

        // --- 1. Create wrapper and title ---
        const wrapper = document.createElement("div");
        wrapper.className = "league-standings-wrapper";
        const title = document.createElement("h3");
        title.textContent = `${divName} (${leagueName}) Standings`;
        wrapper.appendChild(title);

        // --- 2. Sort teams based on standings ---
        league.teams.forEach(team => {
            league.standings[team] = league.standings[team] || { w: 0, l: 0, t: 0 };
        });

        const sortedTeams = [...league.teams].sort((a, b) => {
            const standingA = league.standings[a];
            const standingB = league.standings[b];

            if (standingA.w !== standingB.w) return standingB.w - standingA.w;
            if (standingA.l !== standingB.l) return standingA.l - standingB.l;
            if (standingA.t !== standingB.t) return standingB.t - standingA.t;

            const numA = Number(a);
            const numB = Number(b);
            if (!isNaN(numA) && !isNaN(numB)) {
                return numA - numB; // numeric
            }
            return a.localeCompare(b); // alpha
        });

        // --- 3. Create table ---
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
                <td><input type="number" min="0" value="${teamData.w}" data-league="${leagueName}" data-team="${teamName}" data-record="w"></td>
                <td><input type="number" min="0" value="${teamData.l}" data-league="${leagueName}" data-team="${teamName}" data-record="l"></td>
                <td><input type="number" min="0" value="${teamData.t}" data-league="${leagueName}" data-team="${teamName}" data-record="t"></td>
            `;
            tbody.appendChild(tr);
        });

        wrapper.appendChild(table);

        // --- 4. Add Update Button (for this division only) ---
        const updateBtn = document.createElement("button");
        updateBtn.textContent = "Update Standings";
        updateBtn.className = "update-standings-btn";
        updateBtn.style.marginTop = "10px";
        updateBtn.style.marginLeft = "12px";

        updateBtn.onclick = () => {
            let changed = false;
            // Find all inputs *within this division's wrapper*
            wrapper.querySelectorAll("input[type='number']").forEach(input => {
                const leagueNameAttr = input.dataset.league;
                const teamName = input.dataset.team;
                const recordType = input.dataset.record;
                const value = parseInt(input.value, 10) || 0;

                if (leaguesByName[leagueNameAttr] &&
                    leaguesByName[leagueNameAttr].standings[teamName]) {
                    if (leaguesByName[leagueNameAttr].standings[teamName][recordType] !== value) {
                        leaguesByName[leagueNameAttr].standings[teamName][recordType] = value;
                        changed = true;
                    }
                }
            });

            if (changed) {
                saveLeagues();
                // Re-render the entire standings UI to show new sorted order
                renderLeagueStandingsUI();
                alert(`Standings for ${divName} updated and saved!`);
            } else {
                alert("No changes detected for this division.");
            }
        };
        wrapper.appendChild(updateBtn); // Append button to the wrapper

        // Append the whole wrapper to the main container
        container.appendChild(wrapper);
    });

    if (gridsRendered === 0) {
        container.innerHTML = '<p class="muted" style="padding: 10px;">No active leagues with teams were found. Go to "League Setup" to create one.</p>';
        return;
    }
}

/**
 * --- League Setup UI ---
 * This function renders the setup UI only.
 */
function renderLeagueSetupUI() {
    const leaguesContainer = document.getElementById("league-setup-content");
    if (!leaguesContainer) return;
    leaguesContainer.innerHTML = ""; // Clear only setup container

    const addLeagueDiv = document.createElement("div");
    addLeagueDiv.style.marginBottom = "15px";

    const newLeagueInput = document.createElement("input");
    newLeagueInput.placeholder = "Enter new league name";
    newLeagueInput.style.marginRight = "8px";

    const addLeagueBtn = document.createElement("button");
    addLeagueBtn.textContent = "Add League";
    addLeagueBtn.onclick = () => {
        const name = newLeagueInput.value.trim();
        if (name !== "" && !leaguesByName[name]) {
            leaguesByName[name] = {
                enabled: false,
                divisions: [],
                sports: [],
                teams: [],
                standings: {} // NEW: Add standings object
            };
            newLeagueInput.value = "";
            saveLeagues();
            renderLeagueSetupUI(); // Re-render setup
        }
    };
    newLeagueInput.addEventListener("keypress", e => { if (e.key === "Enter") addLeagueBtn.click(); });

    addLeagueDiv.appendChild(newLeagueInput);
    addLeagueDiv.appendChild(addLeagueBtn);
    leaguesContainer.appendChild(addLeagueDiv);

    const sourceDivs = Array.isArray(window.availableDivisions) && window.availableDivisions.length > 0
        ? window.availableDivisions
        : Object.keys(window.divisions || {});

    Object.keys(leaguesByName).forEach(leagueName => {
        const leagueData = leaguesByName[leagueName];

        const section = document.createElement("div");
        section.className = "league-section";
        section.style.border = "1px solid #ccc";
        section.style.padding = "10px";
        section.style.marginBottom = "12px";
        section.style.borderRadius = "8px";
        section.style.background = "#fafafa";
        section.style.opacity = leagueData.enabled ? "1" : "0.85";

        const header = document.createElement("div");
        header.style.display = "flex";
        header.style.justifyContent = "space-between";
        header.style.alignItems = "center";
        header.style.gap = "8px";

        const leftHeader = document.createElement("div");
        leftHeader.style.display = "flex";
        leftHeader.style.alignItems = "center";
        leftHeader.style.gap = "10px";

        const title = document.createElement("h3");
        title.textContent = leagueName;
        title.style.margin = "0";

        // toggle
        const toggleWrap = document.createElement("label");
        toggleWrap.style.display = "inline-flex";
        toggleWrap.style.alignItems = "center";
        toggleWrap.style.gap = "8px";
        toggleWrap.style.cursor = "pointer";
        toggleWrap.title = "Enable/Disable this league";
        toggleWrap.style.position = "relative";

        const toggleText = document.createElement("span");
        toggleText.textContent = leagueData.enabled ? "Enabled" : "Disabled";

        const toggle = document.createElement("input");
        toggle.type = "checkbox";
        toggle.checked = !!leagueData.enabled;
        Object.assign(toggle.style, {
            appearance: "none",
            width: "44px",
            height: "24px",
            borderRadius: "999px",
            position: "relative",
            background: toggle.checked ? "#22c55e" : "#d1d5db",
            transition: "background 0.15s ease",
            outline: "none",
            border: "1px solid #9ca3af"
        });

        const knob = document.createElement("span");
        Object.assign(knob.style, {
            position: "absolute",
            top: "50%",
            transform: "translateY(-50%)",
            left: toggle.checked ? "24px" : "2px",
            width: "20px",
            height: "20px",
            borderRadius: "50%",
            background: "#fff",
            boxShadow: "0 1px 2px rgba(0,0,0,0.3)",
            transition: "left 0.15s ease"
        });

        toggle.addEventListener("change", () => {
            leagueData.enabled = toggle.checked;
            toggle.style.background = toggle.checked ? "#22c55e" : "#d1d5db";
            knob.style.left = toggle.checked ? "24px" : "2px";
            toggleText.textContent = toggle.checked ? "Enabled" : "Disabled";
            section.style.opacity = leagueData.enabled ? "1" : "0.85";
            saveLeagues();
        });

        toggleWrap.appendChild(toggle);
        toggleWrap.appendChild(knob);
        toggleWrap.appendChild(toggleText);

        const deleteBtn = document.createElement("button");
        deleteBtn.textContent = "🗑️";
        deleteBtn.title = "Delete League";
        deleteBtn.onclick = () => {
            if (confirm(`Delete ${leagueName}?`)) {
                delete leaguesByName[leagueName];
                saveLeagues();
                renderLeagueSetupUI();   // Re-render setup
                renderLeagueStandingsUI(); // Re-render standings
            }
        };

        leftHeader.appendChild(title);
        leftHeader.appendChild(toggleWrap);
        header.appendChild(leftHeader);
        header.appendChild(deleteBtn);
        section.appendChild(header);

        // Divisions
        const divTitle = document.createElement("p");
        divTitle.textContent = "Divisions in this League:";
        divTitle.style.marginBottom = "6px";
        section.appendChild(divTitle);

        const divContainer = document.createElement("div");
        divContainer.className = "division-push-buttons";
        divContainer.style.display = "flex";
        divContainer.style.flexWrap = "wrap";
        divContainer.style.gap = "6px";

        if (sourceDivs.length === 0) {
            const note = document.createElement("div");
            note.textContent = "No divisions found. Add divisions in Setup.";
            note.style.fontStyle = "italic";
            note.style.opacity = "0.7";
            section.appendChild(note);
        }

        sourceDivs.forEach(divName => {
            const divBtn = document.createElement("button");
            divBtn.textContent = divName;
            divBtn.className = "push-btn";

            const active = leagueData.divisions.includes(divName);
            const divColor = window.divisions?.[divName]?.color || "#ccc";
            divBtn.style.backgroundColor = active ? divColor : "white";
            divBtn.style.color = active ? "white" : "black";
            divBtn.style.border = `2px solid ${divColor}`;
            divBtn.style.borderRadius = "20px";
            divBtn.style.padding = "6px 10px";
            divBtn.style.fontWeight = "500";
            divBtn.style.cursor = "pointer";
            divBtn.style.transition = "all 0.15s ease";

            divBtn.onmouseenter = () => { if (!active) divBtn.style.backgroundColor = "#f3f3f3"; };
            divBtn.onmouseleave = () => { if (!active) divBtn.style.backgroundColor = "white"; };

            divBtn.onclick = () => {
                const idx = leagueData.divisions.indexOf(divName);
                if (idx >= 0) leagueData.divisions.splice(idx, 1);
                else leagueData.divisions.push(divName);
                saveLeagues();
                renderLeagueSetupUI(); // Re-render setup
            };

            divContainer.appendChild(divBtn);
        });
        section.appendChild(divContainer);

        // --- Sports Section ---
        const sportsTitle = document.createElement("p");
        sportsTitle.textContent = "League Sports:";
        sportsTitle.style.margin = "10px 0 6px";
        section.appendChild(sportsTitle);

        const sportsContainer = document.createElement("div");
        sportsContainer.style.display = 'flex';
        sportsContainer.style.flexWrap = 'wrap';
        sportsContainer.style.gap = '5px';

        // Get the master list of all sports
        const allSportsToShow = window.getAllGlobalSports?.() || [];

        // Loop over the master list to create the buttons
        allSportsToShow.forEach(sport => {
            const btn = document.createElement("button");
            btn.textContent = sport;

            const active = leagueData.sports.includes(sport);

            btn.style.margin = "0";
            btn.style.padding = "6px 10px";
            btn.style.borderRadius = "20px";
            btn.style.cursor = "pointer";
            btn.style.border = "2px solid #007BFF";
            btn.style.backgroundColor = active ? "#007BFF" : "white";
            btn.style.color = active ? "white" : "black";

            btn.onclick = () => {
                const idx = leagueData.sports.indexOf(sport);
                if (idx >= 0) {
                    leagueData.sports.splice(idx, 1);
                } else {
                    leagueData.sports.push(sport);
                }
                saveLeagues();
                renderLeagueSetupUI(); // Re-render setup
            };
            sportsContainer.appendChild(btn);
        });
        section.appendChild(sportsContainer);

        // "Add new sport" input
        const addSportWrapper = document.createElement("div");
        addSportWrapper.style.marginTop = "8px";

        const customSportInput = document.createElement("input");
        customSportInput.placeholder = "Add new sport type";
        customSportInput.style.marginLeft = "0";

        const addCustomSport = () => {
            const val = customSportInput.value.trim();
            if (val === "") return;

            // 1. Register the sport globally
            window.addGlobalSport?.(val);

            // 2. Add to this league's list
            if (!leagueData.sports.includes(val)) {
                leagueData.sports.push(val);
                saveLeagues();
            }

            // 3. Re-render the tab
            customSportInput.value = "";
            renderLeagueSetupUI(); // Re-render setup
        };

        customSportInput.onkeypress = e => {
            if (e.key === "Enter") {
                addCustomSport();
            }
        };
        addSportWrapper.appendChild(customSportInput);

        // Create the "Add" button
        const addCustomSportBtn = document.createElement("button");
        addCustomSportBtn.textContent = "Add";
        addCustomSportBtn.style.marginLeft = "4px";
        addCustomSportBtn.onclick = addCustomSport;
        addSportWrapper.appendChild(addCustomSportBtn);

        section.appendChild(addSportWrapper);
        // --- END Sports Section ---

        // Teams
        const teamTitle = document.createElement("p");
        teamTitle.textContent = "Teams:";
        teamTitle.style.margin = "10px 0 6px";
        section.appendChild(teamTitle);

        const teamInput = document.createElement("input");
        teamInput.placeholder = "Enter team name";
        teamInput.style.marginRight = "8px";
        teamInput.onkeypress = e => {
            if (e.key === "Enter") {
                const val = (teamInput.value || "").trim();
                if (!val) return;
                if (!leagueData.teams.includes(val)) {
                    leagueData.teams.push(val);
                    // NEW: Add team to standings
                    leagueData.standings[val] = leagueData.standings[val] || { w: 0, l: 0, t: 0 };
                    saveLeagues();
                    renderLeagueSetupUI(); // Re-render setup
                }
                teamInput.value = "";
            }
        };
        section.appendChild(teamInput);

        const addTeamBtn = document.createElement("button");
        addTeamBtn.textContent = "Add Team";
        addTeamBtn.onclick = () => {
            const val = (teamInput.value || "").trim();
            if (!val) return;
            if (!leagueData.teams.includes(val)) {
                leagueData.teams.push(val);
                leagueData.standings[val] = leagueData.standings[val] || { w: 0, l: 0, t: 0 };
                saveLeagues();
                renderLeagueSetupUI(); // Re-render setup
            }
            teamInput.value = "";
        };
        section.appendChild(addTeamBtn);

        const teamListContainer = document.createElement("div");
        teamListContainer.style.marginTop = "6px";
        teamListContainer.style.display = "flex";
        teamListContainer.style.flexWrap = "wrap";
        teamListContainer.style.gap = "6px";

        (leagueData.teams || []).forEach(team => {
            const teamBtn = document.createElement("button");
            teamBtn.textContent = team;
            teamBtn.style.padding = "6px 10px";
            teamBtn.style.border = "1px solid #333";
            teamBtn.style.borderRadius = "20px";
            teamBtn.style.cursor = "pointer";
            teamBtn.style.backgroundColor = "#f9f9f9";
            teamBtn.onclick = () => {
                if (confirm(`Remove ${team} from ${leagueName}? This will also remove their standings.`)) {
                    leagueData.teams = leagueData.teams.filter(t => t !== team);
                    delete leagueData.standings[team];
                    saveLeagues();
                    renderLeagueSetupUI();   // Re-render setup
                    renderLeagueStandingsUI(); // Re-render standings
                }
            };
            teamListContainer.appendChild(teamBtn);
        });
        section.appendChild(teamListContainer);

        // === NEW: Ultimate Rotation Preview Button ===
        const ultWrapper = document.createElement("div");
        ultWrapper.style.marginTop = "12px";
        const ultBtn = document.createElement("button");
        ultBtn.textContent = "Preview Ultimate Rotation";
        ultBtn.style.padding = "8px 16px";
        ultBtn.style.borderRadius = "8px";
        ultBtn.style.border = "none";
        ultBtn.style.cursor = "pointer";
        ultBtn.style.background = "#00d4aa";
        ultBtn.style.color = "#fff";
        ultBtn.style.fontWeight = "600";

        ultBtn.onclick = () => {
            openUltimatePreview(leagueName);
        };
        ultWrapper.appendChild(ultBtn);
        section.appendChild(ultWrapper);
        // === END NEW ===

        leaguesContainer.appendChild(section);
    });

    // Ensure preview container exists
    ensureUltimatePreviewContainer();
}

// --- NEW: Ultimate Rotation Preview UI (uses generateUltimateLeagueRotation) ---

function ensureUltimatePreviewContainer() {
    if (document.getElementById("ultimate-preview")) return;

    const leaguesContainer = document.getElementById("league-setup-content") || document.body;
    const preview = document.createElement("div");
    preview.id = "ultimate-preview";
    preview.style.marginTop = "20px";
    preview.style.padding = "16px";
    preview.style.border = "2px solid #00d4aa";
    preview.style.borderRadius = "10px";
    preview.style.background = "#f0fffa";
    preview.style.display = "none";

    preview.innerHTML = `
        <h2 style="color:#00a085; margin-top:0;">Perfect League Rotation Preview</h2>
        <p style="margin-bottom:8px;">
            This preview uses the same <strong>Ultimate Rotation</strong> engine as the optimizer:
            round-robin opponents, cycling sports, and smart field usage.
        </p>
        <div id="preview-league-name" style="font-weight:bold; margin-bottom:10px;"></div>
        <div id="preview-table" style="overflow-x:auto;"></div>
        <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap;">
            <button id="save-ultimate-schedule"
                    style="padding: 8px 18px; font-size: 1em; background:#00d4aa; color:white; border:none; border-radius:6px; cursor:pointer;">
                Save as Default Rotation for this League
            </button>
            <button id="close-ultimate-preview"
                    style="padding: 6px 14px; background:#e5e7eb; border:none; border-radius:6px; cursor:pointer;">
                Close Preview
            </button>
        </div>
    `;

    leaguesContainer.appendChild(preview);

    const closeBtn = preview.querySelector("#close-ultimate-preview");
    closeBtn.onclick = () => {
        preview.style.display = "none";
    };
}

function openUltimatePreview(leagueName) {
    const league = leaguesByName[leagueName];
    if (!league) {
        alert(`League "${leagueName}" not found.`);
        return;
    }

    const teams = (league.teams || []).map(String).filter(Boolean);
    const sports = (league.sports || []).filter(Boolean);

    if (teams.length < 2) {
        alert("Ultimate Rotation requires at least 2 teams in this league.");
        return;
    }
    if (sports.length === 0) {
        alert("Ultimate Rotation requires at least 1 sport selected for this league.");
        return;
    }

    if (typeof window.generateUltimateLeagueRotation !== "function") {
        alert("Ultimate Rotation engine (generateUltimateLeagueRotation) is not available. Make sure scheduler_logic_core.js is loaded.");
        return;
    }

    ensureUltimatePreviewContainer();
    const preview = document.getElementById("ultimate-preview");
    const nameDiv = document.getElementById("preview-league-name");
    const tableDiv = document.getElementById("preview-table");
    const saveBtn = document.getElementById("save-ultimate-schedule");

    nameDiv.textContent = `League: ${leagueName}`;

    // Use fieldsBySport from global if available; otherwise pass empty.
    const fieldsBySport = window.fieldsBySport || {};
    // Use a dummy block with 8 "slots" just for preview purposes.
    const blockBase = {
        slots: Array.from({ length: 8 }, (_, i) => i),
        divName: (league.divisions && league.divisions[0]) || ""
    };

    // For preview, safe to pass empty fieldUsage & activityProperties
    const schedule = window.generateUltimateLeagueRotation(
        leagueName,
        teams,
        sports,
        fieldsBySport,
        blockBase,
        {},         // fieldUsageBySlot (preview-only)
        {}          // activityProperties (preview-only)
    ) || [];

    // Build table
    let html = `
        <table style="width:100%; border-collapse:collapse; background:white; font-size:0.95em;">
            <thead>
                <tr style="background:#00a085; color:white;">
                    <th style="padding:8px;">Round</th>
                    <th style="padding:8px;">Team A</th>
                    <th style="padding:8px;">vs</th>
                    <th style="padding:8px;">Team B</th>
                    <th style="padding:8px;">Sport</th>
                    <th style="padding:8px;">Field</th>
                </tr>
            </thead>
            <tbody>
    `;

    schedule.forEach((m, idx) => {
        if (m.isBye) return;
        html += `
            <tr style="background:${idx % 2 === 0 ? "#f8f9fa" : "white"};">
                <td style="padding:6px; text-align:center;"><strong>${m.round ?? ""}</strong></td>
                <td style="padding:6px;">${m.teamA}</td>
                <td style="padding:6px; text-align:center; font-weight:bold; color:#d32f2f;">VS</td>
                <td style="padding:6px;">${m.teamB}</td>
                <td style="padding:6px; font-weight:bold; color:#1a5fb4;">${m.sport}</td>
                <td style="padding:6px; color:#00a085;">${m.field}</td>
            </tr>
        `;
    });

    html += `</tbody></table>`;
    tableDiv.innerHTML = html;

    // Save schedule into current day's data so core could use it later if desired
    saveBtn.onclick = () => {
        const daily = window.loadCurrentDailyData?.() || {};
        daily.ultimateLeagueSchedules = daily.ultimateLeagueSchedules || {};
        daily.ultimateLeagueSchedules[leagueName] = schedule;
        window.saveCurrentDailyData?.(daily);
        alert(`Perfect rotation for "${leagueName}" saved to today's data under ultimateLeagueSchedules.`);
    };

    preview.style.display = "block";
    preview.scrollIntoView({ behavior: "smooth", block: "center" });
}

// Init leagues data + UI
loadLeagues();
window.getLeaguesByName = () => leaguesByName;
window.loadLeagues = loadLeagues;
window.saveLeagues = saveLeagues;

/**
 * Main entry point for the Leagues tab.
 */
function initLeagues() {
    // loadLeagues() is already called at the top level of this file.
    if (document.getElementById("leaguesContainer")) {
        renderLeagueUI(); // Renders the new nav and both panes
    }
}
window.initLeagues = initLeagues;

// =============================================================
// LEAGUE SCHEDULING CORE (merged from league_scheduling.js)
// Round-robin matchups + persistent round state
// =============================================================
(function () {
    'use strict';

    let leagueRoundState = {}; // { "League Name": { currentRound: 0 } }

    /**
     * Loads the current round for all leagues from the *current day's* data.
     */
    function loadRoundState() {
        try {
            if (window.currentDailyData && window.currentDailyData.leagueRoundState) {
                leagueRoundState = window.currentDailyData.leagueRoundState;
            } else if (window.loadCurrentDailyData) {
                const d = window.loadCurrentDailyData() || {};
                leagueRoundState = d.leagueRoundState || {};
            } else {
                leagueRoundState = {};
            }
        } catch (e) {
            console.error("Failed to load league state:", e);
            leagueRoundState = {};
        }
        window.leagueRoundState = leagueRoundState;
    }

    /**
     * Saves the current round for all leagues to the *current day's* data.
     */
    function saveRoundState() {
        try {
            window.saveCurrentDailyData?.("leagueRoundState", leagueRoundState);
        } catch (e) {
            console.error("Failed to save league state:", e);
        }
        window.leagueRoundState = leagueRoundState;
    }

    /**
     * Generates a full round-robin tournament schedule for a list of teams.
     */
    function generateRoundRobin(teamList) {
        if (!teamList || teamList.length < 2) {
            return [];
        }

        const teams = [...teamList];
        let hasBye = false;
        if (teams.length % 2 !== 0) {
            teams.push("BYE");
            hasBye = true;
        }

        const numRounds = teams.length - 1;
        const schedule = [];

        const fixedTeam = teams[0];
        const rotatingTeams = teams.slice(1);

        for (let round = 0; round < numRounds; round++) {
            const currentRound = [];

            currentRound.push([fixedTeam, rotatingTeams[0]]);

            for (let i = 1; i < teams.length / 2; i++) {
                const team1 = rotatingTeams[i];
                const team2 = rotatingTeams[rotatingTeams.length - i];
                currentRound.push([team1, team2]);
            }

            schedule.push(currentRound);
            rotatingTeams.unshift(rotatingTeams.pop());
        }

        if (hasBye) {
            return schedule.map(round =>
                round.filter(match => match[0] !== "BYE" && match[1] !== "BYE")
            );
        }

        return schedule;
    }

    /**
     * Public function to get the *next* set of matchups for a league.
     * (No loadRoundState() here; it's called once on script load.)
     */
    function getLeagueMatchups(leagueName, teams) {
        if (!leagueName || !teams || teams.length < 2) {
            return [];
        }

        const state = leagueRoundState[leagueName] || { currentRound: 0 };
        const fullSchedule = generateRoundRobin(teams);

        if (fullSchedule.length === 0) {
            return [];
        }

        const todayMatchups = fullSchedule[state.currentRound];

        // Increment and save the round number for next time
        const nextRound = (state.currentRound + 1) % fullSchedule.length;
        leagueRoundState[leagueName] = { currentRound: nextRound };
        saveRoundState();

        return todayMatchups;
    }

    // --- Global Exposure and Initialization ---
    window.getLeagueMatchups = getLeagueMatchups;
    window.saveRoundState = saveRoundState;

    // Load state on script execution for current date
    loadRoundState();
})();
