// -------------------- Leagues.js --------------------
// (UPDATED to use calendar.js save/load)
//
// UPDATED:
// - `initLeaguesTab`:
//   - Removed hard-coded `sportsList`.
//   - Now calls `window.getAllGlobalSports()` to get the master list.
//   - "Other sport" input now calls `window.addGlobalSport()`
//     to register the sport globally before re-rendering the tab.
// -----------------------------------------------------------------

// Internal store keyed by LEAGUE NAME for UI/storage
let leaguesByName = {};
// app2 expects window.leagues keyed by DIVISION NAME -> { enabled: boolean }
// app2 also reads window.leaguesByName (full map)

// -------------------- Helpers --------------------
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

function loadLeagues() {
// UPDATED: Load from global settings
// Relies on calendar.js migration logic to find "leagues" key once
const stored = window.loadGlobalSettings?.().leaguesByName;

leaguesByName = stored || {};
Object.keys(leaguesByName).forEach(name => {
const l = leaguesByName[name] || {};
if (typeof l.enabled === "undefined") l.enabled = false;
l.divisions = Array.isArray(l.divisions) ? l.divisions : [];
l.sports = Array.isArray(l.sports) ? l.sports : [];
l.teams = Array.isArray(l.teams) ? l.teams : [];
leaguesByName[name] = l;
});
window.leaguesByName = leaguesByName; // publish full map
publishDivisionToggleMap();
}

// -------------------- UI --------------------
/**
 * UPDATED FUNCTION
 * - Fixes the bug where the custom sport input had no "Add" button.
 * - NEW: Renders buttons for ALL saved sports (including custom ones).
 * - NEW: All sport buttons now toggle (add/remove) on click.
 */
function initLeaguesTab() {
  const leaguesContainer = document.getElementById("leaguesContainer");
  if (!leaguesContainer) return;
  leaguesContainer.innerHTML = "";

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
      leaguesByName[name] = { enabled: false, divisions: [], sports: [], teams: [] };
      newLeagueInput.value = "";
      saveLeagues();
      initLeaguesTab();
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
        initLeaguesTab();
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
        initLeaguesTab();
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
        initLeaguesTab(); // Re-render
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
      initLeaguesTab(); 
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
          saveLeagues();
          initLeaguesTab();
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
        saveLeagues();
        initLeaguesTab();
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
        if (confirm(`Remove ${team} from ${leagueName}?`)) {
          leagueData.teams = leagueData.teams.filter(t => t !== team);
          saveLeagues();
          initLeaguesTab();
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
function initLeagues() {
// loadLeagues() is already called at the top level of this file.
if (document.getElementById("leaguesContainer")) initLeaguesTab();
}
window.initLeagues = initLeagues;
// =============================================
// ===== END OF NEW INIT FUNCTION =====
// =============================================

/**
* =============================================================
* LEAGUE SCHEDULING CORE (league_scheduling.js)
* (UPDATED to use calendar.js save/load)
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
*/
function getLeagueMatchups(leagueName, teams) {
if (!leagueName || !teams || teams.length < 2) {
return [];
}

loadRoundState();

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

// IMPORTANT: Load state on script execution
// It will load the state for the current date set by calendar.js
loadRoundState();

})();
