// -------------------- Leagues.js --------------------
// Handles the Leagues tab UI and logic

console.log("Leagues.js loaded");

// Make sure global leagues object exists
if (typeof leagues === "undefined") {
  var leagues = {};
}

// Initialize Leagues Tab
function initLeaguesTab() {
  const container = document.getElementById("leagues");
  if (!container) return;

  container.innerHTML = `
    <h2>Leagues</h2>
    <p>Set up league teams for each division.</p>
    <div id="leagueDivisionList"></div>
  `;

  renderLeagueDivisions();
}

// Render divisions and allow team name inputs
function renderLeagueDivisions() {
  const list = document.getElementById("leagueDivisionList");
  if (!list) return;

  list.innerHTML = "";

  // Use divisions from app1.js
  Object.keys(divisions).forEach(divName => {
    if (!leagues[divName]) {
      leagues[divName] = { teams: [], enabled: false, sports: [] };
    }

    const divBox = document.createElement("div");
    divBox.className = "league-division-box";
    divBox.style.border = `2px solid ${divisions[divName].color || "#000"}`;
    divBox.style.padding = "10px";
    divBox.style.marginBottom = "15px";
    divBox.style.borderRadius = "8px";

    divBox.innerHTML = `
      <h3 style="color:${divisions[divName].color || "#000"}">${divName}</h3>
      <input type="text" id="teamInput-${divName}" placeholder="Enter team name" />
      <button onclick="addTeamToDivision('${divName}')">Add Team</button>
      <div id="teamList-${divName}" class="team-list"></div>
    `;

    list.appendChild(divBox);
    renderTeamList(divName);
  });
}

// Add a team name to the selected division
function addTeamToDivision(divName) {
  const input = document.getElementById(`teamInput-${divName}`);
  if (!input) return;

  const teamName = input.value.trim();
  if (teamName === "") return;

  if (!leagues[divName]) leagues[divName] = { teams: [], enabled: false, sports: [] };
  leagues[divName].teams.push(teamName);
  input.value = "";

  renderTeamList(divName);
  saveLeagues();
}

// Render the team list for a given division
function renderTeamList(divName) {
  const container = document.getElementById(`teamList-${divName}`);
  if (!container) return;

  const teams = leagues[divName]?.teams || [];
  if (teams.length === 0) {
    container.innerHTML = `<p style="color:#888;">No teams added yet.</p>`;
    return;
  }

  container.innerHTML = `
    <ul>
      ${teams.map(t => `<li>${t}</li>`).join("")}
    </ul>
  `;
}

// Save to localStorage (for persistence)
function saveLeagues() {
  localStorage.setItem("leagues", JSON.stringify(leagues));
}

// Load saved leagues if any
function loadLeagues() {
  const saved = localStorage.getItem("leagues");
  if (saved) leagues = JSON.parse(saved);
}

// Initialize when ready
document.addEventListener("DOMContentLoaded", () => {
  loadLeagues();
  initLeaguesTab();
});

