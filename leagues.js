// -------------------- Leagues.js --------------------
// (UPDATED to use calendar.js save/load)
//
// ... (previous changelogs) ...
//
// --- YOUR LATEST REQUEST (Ranking) ---
// - **NEW FEATURE:** `renderLeagueStandingsUI` now adds a "Place"
//   column (1st, 2nd, etc.) to the standings grid.
// - **AUTO-SORT:** The `updateBtn.onclick` already calls
//   `renderLeagueStandingsUI()`, which re-runs the sorting
//   logic, automatically re-ordering the teams by rank.
//
// --- FIX (Round-Robin) ---
// - **REMOVED:** `loadRoundState()` call from `getLeagueMatchups`.
//   This prevents the round from resetting during a single
//   optimizer run, allowing multiple league blocks in one
//   day to get the correct, advancing matchups.
// -----------------------------------------------------------------

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
  const stored = window.loadGlobalSettings?.().leaguesByName;

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
 * --- NEW: Main UI Rendering Function ---
 * Renders the dropdown nav and the two content panes.
 * --- UPDATED to be hidden by default ---
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
        
        <div id="league-setup-content" class="league-content-pane">
            </div>
        <div id="league-standings-content" class="league-content-pane">
            </div>
    `;

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
            // This is the new "none" state
            setupPane.classList.remove("active");
            standingsPane.classList.remove("active");
        }
    };
}

/**
 * --- NEW: Renders the Standings UI ---
 * Creates a sorted grid for each division with a league.
 * --- UPDATED with Place column ---
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
        
        const leagueName = leagueEntry[0]; // Get the league name (the key)
        const league = leagueEntry[1]; // Get the league object (the value)
        
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
                return numA - numB; // Sort numerically
            }
            return a.localeCompare(b); // Sort alphabetically
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
            <tbody>
            </tbody>
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
                const leagueName = input.dataset.league;
                const teamName = input.dataset.team;
                const recordType = input.dataset.record;
                const value = parseInt(input.value, 10) || 0;

                if (leaguesByName[leagueName] && leaguesByName[leagueName].standings[teamName]) {
                    if (leaguesByName[leagueName].standings[teamName][recordType] !== value) {
                        leaguesByName[leagueName].standings[teamName][recordType] = value;
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
 * --- RENAMED: from `initLeaguesTab` ---
 * This function now *only* renders the setup UI.
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
        renderLeagueSetupUI(); // Re-render setup
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

    // --- UPDATED: Sports Section ---
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
      
      btn.style.margin = "0"; // Gap handles spacing
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
    addCustomSportBtn.onclick = addCustomSport; // Assign the same logic
    addSportWrapper.appendChild(addCustomSportBtn);
    
    section.appendChild(addSportWrapper);
    // --- END OF UPDATED Sports Section ---


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
        // NEW: Add team to standings
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
          // NEW: Remove from standings
          delete leagueData.standings[team];
          saveLeagues();
          renderLeagueSetupUI(); // Re-render setup
          renderLeagueStandingsUI(); // Re-render standings
        }
      };
      teamListContainer.appendChild(teamBtn);
    });
    section.appendChild(teamListContainer);

    leaguesContainer.appendChild(section);
  });
}


// Init
loadLeagues();
// ===== REMOVED DOMCONTENTLOADED LISTENER HERE =====
window.getLeaguesByName = () => leaguesByName;
window.loadLeagues = loadLeagues;
window.saveLeagues = saveLeagues;

// =============================================
// ===== START OF NEW INIT FUNCTION =====
// =============================================
/**
 * RENAMED: from `initLeaguesTab`
 * This is now the main entry point for the Leagues tab.
 */
function initLeagues() {
  // loadLeagues() is already called at the top level of this file.
  if (document.getElementById("leaguesContainer")) {
      renderLeagueUI(); // Renders the new nav and both panes
  }
}
window.initLeagues = initLeagues;
// =============================================
// ===== END OF NEW INIT FUNCTION =====
// =============================================

/**
* =============================================================
* LEAGUE SCHEDULING CORE (league_scheduling.js)
* (UPDATED to use calendar.js save/load)
*
* --- ROUND-ROBIN FIX ---
* - REMOVED `loadRoundState()` from `getLeagueMatchups` to
* prevent state from resetting during a single optimizer run.
* =============================================================
*/

(function () {
'use strict';

// const LEAGUE_STATE_KEY = "camp_league_round_state"; // No longer used
let leagueRoundState = {}; // { "League Name": { currentRound: 0 } }

/**
* Loads the current round for all leagues from the *current day's* data.
*/
function loadRoundState() {
try {
// UPDATED: Load from the globally scoped daily object
if (window.currentDailyData && window.currentDailyData.leagueRoundState) {
leagueRoundState = window.currentDailyData.leagueRoundState;
} else if (window.loadCurrentDailyData) {
// If it's the first load, loadCurrentDailyData will run and populate it
leagueRoundState = window.loadCurrentDailyData().leagueRoundState || {};
}
else {
leagueRoundState = {};
}
} catch (e) {
console.error("Failed to load league state:", e);
leagueRoundState = {};
}
}

/**
* Saves the current round for all leagues to the *current day's* data.
*/
function saveRoundState() {
try {
// UPDATED: Save to the globally scoped daily object
window.saveCurrentDailyData?.("leagueRoundState", leagueRoundState);
} catch (e) {
console.error("Failed to save league state:", e);
}
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
* --- UPDATED: Removed loadRoundState() ---
*/
function getLeagueMatchups(leagueName, teams) {
if (!leagueName || !teams || teams.length < 2) {
return [];
}

// loadRoundState(); // <-- THIS LINE IS REMOVED. State is loaded once on script load.

const state = leagueRoundState[leagueName] || { currentRound: 0 };
const fullSchedule = generateRoundRobin(teams);

if (fullSchedule.length === 0) {
return [];
}

const todayMatchups = fullSchedule[state.currentRound];

// Increment and save the round number for next time
const nextRound = (state.currentRound + 1) % fullSchedule.length;
leagueRoundState[leagueName] = { currentRound: nextRound };
saveRoundState(); // This updates the in-memory global object and saves to storage

return todayMatchups;
}

// --- Global Exposure and Initialization ---
window.getLeagueMatchups = getLeagueMatchups;

// IMPORTANT: Load state on script execution
// It will load the state for the current date set by calendar.js
loadRoundState();

})();
