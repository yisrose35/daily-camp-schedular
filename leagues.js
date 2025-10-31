// -------------------- Leagues.js --------------------

// Internal store keyed by LEAGUE NAME for UI/storage
let leaguesByName = {};
// app2 expects window.leagues keyed by DIVISION NAME -> { enabled: boolean }
// app2 now ALSO expects window.leaguesByName to get team lists

// -------------------- Helpers --------------------
function publishDivisionToggleMap() {
  // Build { "5th Grade": {enabled:true}, ... } for divisions that appear in ANY enabled league
  const divMap = {};
  Object.values(leaguesByName).forEach(lg => {
    if (lg?.enabled && Array.isArray(lg.divisions)) {
      lg.divisions.forEach(d => { if (d) divMap[d] = { enabled: true }; });
    }
  });
  window.leagues = divMap;
}

function saveLeagues() {
  localStorage.setItem("leagues", JSON.stringify(leaguesByName));
  // --- ADDED ---
  // Ensure the global variable for app2.js is always up-to-date
  window.leaguesByName = leaguesByName; 
  // -------------
  publishDivisionToggleMap();
}

function loadLeagues() {
  const stored = localStorage.getItem("leagues");
  leaguesByName = stored ? (JSON.parse(stored) || {}) : {};
  Object.keys(leaguesByName).forEach(name => {
    const l = leaguesByName[name] || {};
    if (typeof l.enabled === "undefined") l.enabled = false;
    l.divisions = Array.isArray(l.divisions) ? l.divisions : [];
    l.sports = Array.isArray(l.sports) ? l.sports : [];
    l.teams = Array.isArray(l.teams) ? l.teams : [];
    leaguesByName[name] = l;
  });
  // --- ADDED ---
  // Expose the loaded data globally for app2.js
  window.leaguesByName = leaguesByName;
  // -------------
  publishDivisionToggleMap();
}

// -------------------- UI --------------------
function initLeaguesTab() {
  const leaguesContainer = document.getElementById("leaguesContainer");
  if (!leaguesContainer) return;
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

  // -------------------- Render Each League --------------------
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

    // Header
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

    // Enabled slider toggle
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

    // -------------------- Division Push Buttons --------------------
    const divTitle = document.createElement("p");
    divTitle.textContent = "Divisions in this League:";
    divTitle.style.marginBottom = "6px";
    section.appendChild(divTitle);

    const divContainer = document.createElement("div");
    divContainer.className = "division-push-buttons";
    divContainer.style.display = "flex";
    divContainer.style.flexWrap = "wrap";
    divContainer.style.gap = "6px";

    const sourceDivs = Array.isArray(window.availableDivisions) && window.availableDivisions.length > 0
      ? window.availableDivisions
      : Object.keys(window.divisions || {});

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

      divBtn.onmouseenter = () => {
        if (!active) divBtn.style.backgroundColor = "#f3f3f3";
      };
      divBtn.onmouseleave = () => {
        if (!active) divBtn.style.backgroundColor = "white";
      };

      divBtn.onclick = () => {
        const idx = leagueData.divisions.indexOf(divName);
        if (idx >= 0) leagueData.divisions.splice(idx, 1);
        else leagueData.divisions.push(divName);
        saveLeagues();
        initLeaguesTab();
      };

      divContainer.appendChild(divBtn);
GistID: 7617c6a5124022a101f35fd63273010b
    });
    section.appendChild(divContainer);

    // -------------------- Sports Selection --------------------
    const sportsTitle = document.createElement("p");
    sportsTitle.textContent = "League Sports:";
    sportsTitle.style.margin = "10px 0 6px";
    section.appendChild(sportsTitle);

    const sportsContainer = document.createElement("div");
    const sportsList = ["Basketball", "Hockey", "Volleyball", "Soccer", "Kickball", "Punchball", "Baseball"];
    sportsList.forEach(sport => {
      const btn = document.createElement("button");
      btn.textContent = sport;
      const active = leagueData.sports.includes(sport);
      btn.style.margin = "2px";
      btn.style.padding = "6px 10px";
      btn.style.borderRadius = "20px";
      btn.style.cursor = "pointer";
      btn.style.border = "2px solid #007BFF";
      btn.style.backgroundColor = active ? "#007BFF" : "white";
      btn.style.color = active ? "white" : "black";
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
    customSportInput.style.marginLeft = "6px";
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
    teamTitle.style.margin = "10px 0 6px";
    section.appendChild(teamTitle);

    const teamInput = document.createElement("input");
    teamInput.placeholder = "Enter team name";
    teamInput.style.marginRight = "8px";
    teamInput.onkeypress = e => {
      if (e.key === "Enter" && teamInput.value.trim() !== "") {
GistID: 7617c6a5124022a101f35fd63273010b
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

s    const teamListContainer = document.createElement("div");
    teamListContainer.style.marginTop = "6px";
    teamListContainer.style.display = "flex";
    teamListContainer.style.flexWrap = "wrap";
    teamListContainer.style.gap = "6px";

    (leagueData.teams || []).forEach(team => {
      const teamBtn = document.createElement("button");
      teamBtn.textContent = team;
      teamBtn.style.padding = "6px 10px";
GistID: 7617c6a5124022a101f35fd63273010b
      teamBtn.style.border = "1px solid #333";
      teamBtn.style.borderRadius = "20px";
      teamBtn.style.cursor = "pointer";
      teamBtn.style.backgroundColor = "#f9f9f9";
GistID: 7617c6a5124022a101f35fd63273010b
      teamBtn.onclick = () => {
        if (confirm(`Remove ${team} from ${leagueName}?`)) {
  S         leagueData.teams = leagueData.teams.filter(t => t !== team);
          saveLeagues();
          initLeaguesTab();
        }
      };
      teamListContainer.appendChild(teamBtn);
GistID: 7617c6a5124022a101f35fd63273010b
    });
    section.appendChild(teamListContainer);

    leaguesContainer.appendChild(section);
  });
}

// -------------------- Init --------------------
document.addEventListener("DOMContentLoaded", () => {
GistID: 7617c6a5124022a101f35fd63273010b
  loadLeagues();
  // Expose the init function globally so app1/index can call it
  window.initLeaguesTab = initLeaguesTab;
  // Initial render if the tab is already active (rare, but safe)
  if (document.getElementById("leaguesContainer")?.parentElement?.classList.contains("active")) {
GistID: 7617c6a5124022a101f35fd63273010b
    initLeaguesTab();
  }
});

