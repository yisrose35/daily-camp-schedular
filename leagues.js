// -------------------- Leagues.js --------------------
// (UPDATED to use calendar.js save/load)

// Internal store keyed by LEAGUE NAME for UI/storage
var leaguesByName = {}; // <-- CHANGED TO VAR
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
    l.sports    = Array.isArray(l.sports)    ? l.sports    : [];
    l.teams     = Array.isArray(l.teams)     ? l.teams     : [];
    leaguesByName[name] = l;
  });
  window.leaguesByName = leaguesByName; // publish full map
  publishDivisionToggleMap();
}

// -------------------- UI --------------------
function initLeaguesTab() {
  const leaguesContainer = document.getElementById("leaguesContainer");
  if (!leaguesContainer) return;
  leaguesContainer.innerHTML = "";
  
  const addLeagueDiv = document.createElement("div");
  addLeagueDiv.style.marginBottom = "15px";
  
  const newLeagueInput = document.createElement("input");
  newLeagueInput.placeholder = "Enter new league name";
  newLeagueInput.
