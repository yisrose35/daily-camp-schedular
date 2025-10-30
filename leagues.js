// -------------------- Leagues.js --------------------

// Structure:
// leagues = {
//   "League Name": {
//     divisions: ["5th Grade", "6th Grade"],
//     sports: ["Basketball"],
//     teams: ["Lions", "Tigers"]
//   }
// }

function initLeaguesTab() {
  const leaguesContainer = document.getElementById("leaguesContainer");
  leaguesContainer.innerHTML = "";

  // -------------------- Add New League --------------------
  const addLeagueDiv = document.createElement("div");
  addLeagueDiv.style.marginBottom = "15px";

  const newLeagueInput = document.createElement("input");
  newLeagueInput.placeholder = "Enter new league name";
  newLeagueInput.style.marginRight = "8px";

  const addLeagueBtn = document.createElement("button");
  addLeagueBtn.textContent = "Add League";
  addLeagueBtn.onclick = () => {
    const name = newLeagueInput.value.trim();
    if (name !== "" && !leagues[name]) {
      leagues[name] = { divisions: [], sports: [], teams: [] };
      newLeagueInput.value = "";
      saveLeagues();
      initLeaguesTab();
    }
  };
  newLeagueInput.addEventListener("keypress", e => {
    if (e.key === "Enter") addLeagueBtn.click();
  });

  addLeagueDiv.appendChild(newLeagueInput);
  addLeagueDiv.appendChild(addLeagueBtn);
  leaguesContainer.appendChild(addLeagueDiv);

  // -------------------- Render Each League --------------------
  Object.keys(leagues).forEach(leagueName => {
    const leagueData = leagues[leagueName];

    const section = document.createElement("div");
    section.className = "league-section";
    section.style.border = "1px solid #ccc";
    section.style.padding = "10px";
    section.style.marginBottom = "12px";
    section.style.borderRadius = "8px";
    section.style.background = "#fafafa";

    // Header with name + delete
    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.alignItems = "center";

    const title = document.createElement("h3");
    title.textContent = leagueName;
    header.appendChild(title);

    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "🗑️";
    deleteBtn.title = "Delete League";
    deleteBtn.onclick = () => {
      if (confirm(`Delete ${leagueName}?`)) {
        delete leagues[leagueName];
        saveLeagues();
        initLeaguesTab();
      }
    };
    header.appendChild(deleteBtn);
    section.appendChild(header);

    // -------------------- Division Push Buttons --------------------
    const divTitle = document.createElement("p");
    divTitle.textContent = "Divisions in this League:";
    section.appendChild(divTitle);

    const divContainer = document.createElement("div");
    divContainer.style.display = "flex";
    divContainer.style.flexWrap = "wrap";
    divContainer.style.gap = "6px";

    Object.keys(divisions).forEach(divName => {
      const divBtn = document.createElement("button");
      divBtn.textContent = divName;
      divBtn.style.padding = "4px 8px";
      divBtn.style.borderRadius = "5px";
      divBtn.style.cursor = "pointer";
      divBtn.style.border = "1px solid #333";

      const active = leagueData.divisions.includes(divName);
      const divColor = divisions[divName]?.color || "#ddd";
      divBtn.style.backgroundColor = active ? divColor : "white";
      divBtn.style.color = active ? "white" : "black";

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

    // -------------------- Sports Selection --------------------
    const sportsTitle = document.createElement("p");
    sportsTitle.textContent = "League Sports:";
    section.appendChild(sportsTitle);

    const sportsContainer = document.createElement("div");
    const sportsList = ["Basketball", "Hockey", "Volleyball", "Soccer", "Kickball", "Punchball", "Baseball"];
    sportsList.forEach(sport => {
      const btn = document.createElement("button");
      btn.textContent = sport;
      btn.style.margin = "2px";
      btn.style.padding = "4px 8px";
      btn.style.borderRadius = "5px";
      btn.style.cursor = "pointer";
      btn.style.border = "1px solid #333";
      btn.style.backgroundColor = leagueData.sports.includes(sport) ? "#007BFF" : "white";
      btn.style.color = leagueData.sports.includes(sport) ? "white" : "black";
      btn.onclick = () => {
        const idx = leagueData.sports.indexOf(sport);
        if (idx >= 0) leagueData.sports.splice(idx, 1);
        else leagueData.sports.push(sport);
        saveLeagues();
        initLeaguesTab();
      };
      sportsContainer.appendChild(btn);
    });

    const customSportInput = document.createElement("input");
    customSportInput.placeholder = "Other sport";
    customSportInput.onkeypress = e => {
      if (e.key === "Enter" && customSportInput.value.trim() !== "") {
        leagueData.sports.push(customSportInput.value.trim());
        customSportInput.value = "";
        saveLeagues();
        initLeaguesTab();
      }
    };
    sportsContainer.appendChild(customSportInput);
    section.appendChild(sportsContainer);

    // -------------------- Teams --------------------
    const teamTitle = document.createElement("p");
    teamTitle.textContent = "Teams:";
    section.appendChild(teamTitle);

    const teamInput = document.createElement("input");
    teamInput.placeholder = "Enter team name";
    teamInput.style.marginRight = "8px";
    teamInput.onkeypress = e => {
      if (e.key === "Enter" && teamInput.value.trim() !== "") {
        leagueData.teams.push(teamInput.value.trim());
        teamInput.value = "";
        saveLeagues();
        initLeaguesTab();
      }
    };
    section.appendChild(teamInput);

    const addTeamBtn = document.createElement("button");
    addTeamBtn.textContent = "Add Team";
    addTeamBtn.onclick = () => {
      if (teamInput.value.trim() !== "") {
        leagueData.teams.push(teamInput.value.trim());
        teamInput.value = "";
        saveLeagues();
        initLeaguesTab();
      }
    };
    section.appendChild(addTeamBtn);

    const teamListContainer = document.createElement("div");
    teamListContainer.style.marginTop = "6px";
    teamListContainer.style.display = "flex";
    teamListContainer.style.flexWrap = "wrap";
    teamListContainer.style.gap = "6px";

    leagueData.teams.forEach(team => {
      const teamBtn = document.createElement("button");
      teamBtn.textContent = team;
      teamBtn.style.padding = "4px 8px";
      teamBtn.style.border = "1px solid #333";
      teamBtn.style.borderRadius = "5px";
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

// -------------------- Storage --------------------
function saveLeagues() {
  localStorage.setItem("leagues", JSON.stringify(leagues));
}

// -------------------- Init --------------------
document.addEventListener("DOMContentLoaded", () => {
  const stored = localStorage.getItem("leagues");
  if (stored) leagues = JSON.parse(stored);
  if (document.getElementById("leaguesContainer")) initLeaguesTab();
});
