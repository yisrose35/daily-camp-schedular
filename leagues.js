// leagues.js
// Leagues UI: enable per-division leagues, pick sports via push buttons, and add custom sports.
// Exposes: window.initLeaguesTab()

(function () {
  // ---------- Persistence ----------
  const LS_LEAGUES = "leaguesData";
  const LS_SPORTS  = "leagueSportsList";

  // Default sports if none saved yet
  const DEFAULT_SPORTS = ["Basketball","Football","Baseball","Hockey","Volleyball","Soccer","Lacrosse"];

  // Globals the rest of the app expects
  window.leagues = window.leagues || {};          // { [division]: { enabled:boolean, sports:string[] } }
  window.leagueSports = window.leagueSports || []; // catalog list

  function loadSports() {
    try {
      const raw = localStorage.getItem(LS_SPORTS);
      const arr = raw ? JSON.parse(raw) : null;
      window.leagueSports = Array.isArray(arr) && arr.length ? arr : DEFAULT_SPORTS.slice();
    } catch {
      window.leagueSports = DEFAULT_SPORTS.slice();
    }
  }
  function saveSports() {
    localStorage.setItem(LS_SPORTS, JSON.stringify(window.leagueSports));
  }

  function loadLeagues() {
    try {
      const raw = localStorage.getItem(LS_LEAGUES);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === "object") window.leagues = obj;
      }
    } catch (e) {
      console.warn("Failed to load leagues:", e);
    }
  }
  function saveLeagues() {
    localStorage.setItem(LS_LEAGUES, JSON.stringify(window.leagues));
  }

  // ---------- DOM ----------
  let container; // #leaguesContainer

  function ensureMount() {
    container = document.getElementById("leaguesContainer");
    if (!container) {
      container = document.createElement("div");
      container.id = "leaguesContainer";
      document.body.appendChild(container);
    }
  }

  // ---------- Sports Catalog (add/remove) ----------
  function renderSportsCatalog(parent) {
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.style.marginBottom = "10px";

    const title = document.createElement("div");
    title.innerHTML = `<strong>Sports Catalog</strong> <span class="muted small"> • Used for all divisions</span>`;
    panel.appendChild(title);

    // Input row
    const row = document.createElement("div");
    row.className = "row";
    row.style.marginTop = "6px";

    const colIn = document.createElement("div");
    colIn.className = "col";
    const input = document.createElement("input");
    input.id = "leagueSportInput";
    input.placeholder = "Add a sport (e.g., Dodgeball)";
    colIn.appendChild(input);

    const colBtn = document.createElement("div");
    colBtn.className = "col";
    const addBtn = document.createElement("button");
    addBtn.className = "primary";
    addBtn.textContent = "Add Sport";
    addBtn.style.alignSelf = "flex-start";

    addBtn.addEventListener("click", () => {
      const name = (input.value || "").trim();
      if (!name) return;
      // prevent duplicates (case-insensitive)
      const exists = window.leagueSports.some(s => s.toLowerCase() === name.toLowerCase());
      if (exists) {
        input.value = "";
        return;
      }
      window.leagueSports.push(name);
      window.leagueSports.sort((a,b)=>a.localeCompare(b));
      saveSports();
      input.value = "";
      render(); // re-render entire leagues area to show the new sport
    });

    colBtn.appendChild(addBtn);
    row.appendChild(colIn);
    row.appendChild(colBtn);
    panel.appendChild(row);

    // Current sports list (chips with optional removal for custom sports)
    const list = document.createElement("div");
    list.className = "chips";
    list.style.marginTop = "8px";

    window.leagueSports.forEach(sport => {
      const chip = document.createElement("span");
      chip.className = "bunk-button";
      chip.textContent = sport;

      // Allow removing any sport that is not part of defaults (so we don't nuke core ones accidentally)
      if (!DEFAULT_SPORTS.map(x=>x.toLowerCase()).includes(sport.toLowerCase())) {
        const x = document.createElement("button");
        x.textContent = "×";
        x.title = "Remove from catalog";
        x.style.marginLeft = "6px";
        x.style.padding = "0 6px";
        x.style.borderRadius = "50%";
        x.style.border = "1px solid var(--line)";
        x.style.background = "#fff";
        x.style.cursor = "pointer";
        x.addEventListener("click", () => {
          // remove from catalog
          window.leagueSports = window.leagueSports.filter(s => s !== sport);
          saveSports();
          // also remove from any divisions that had it selected
          Object.keys(window.leagues).forEach(div => {
            const arr = window.leagues[div]?.sports || [];
            const i = arr.indexOf(sport);
            if (i > -1) arr.splice(i,1);
          });
          saveLeagues();
          render();
        });
        chip.appendChild(x);
      }

      list.appendChild(chip);
    });

    panel.appendChild(list);
    parent.appendChild(panel);
  }

  // ---------- Divisions UI ----------
  function render() {
    if (!container) return;
    container.innerHTML = "";

    // Catalog manager
    renderSportsCatalog(container);

    const divs = Array.isArray(window.availableDivisions) ? window.availableDivisions : [];
    if (divs.length === 0) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = "No divisions available. Add divisions in Setup first.";
      container.appendChild(empty);
      return;
    }

    divs.forEach(divName => {
      // Ensure object exists
      if (!window.leagues[divName]) window.leagues[divName] = { enabled: false, sports: [] };
      const leagueData = window.leagues[divName];

      const card = document.createElement("div");
      card.className = "league-card";

      const header = document.createElement("div");
      header.style.display = "flex";
      header.style.alignItems = "center";
      header.style.justifyContent = "space-between";

      const title = document.createElement("h4");
      title.textContent = divName;
      title.style.margin = "0";
      header.appendChild(title);

      // Slider toggle (Enable league)
      const toggleWrap = document.createElement("label");
      toggleWrap.className = "switch";
      const toggleInput = document.createElement("input");
      toggleInput.type = "checkbox";
      toggleInput.checked = !!leagueData.enabled;
      const slider = document.createElement("span");
      slider.className = "slider";
      toggleWrap.appendChild(toggleInput);
      toggleWrap.appendChild(slider);

      toggleInput.addEventListener("change", () => {
        leagueData.enabled = toggleInput.checked;
        saveLeagues();
        window.updateTable?.();
        // light visual cue: disabled cards look dimmer
        sportsWrap.style.opacity = leagueData.enabled ? "1" : "0.55";
      });

      header.appendChild(toggleWrap);
      card.appendChild(header);

      // Sports push buttons
      const sportsWrap = document.createElement("div");
      sportsWrap.className = "chips";
      sportsWrap.style.marginTop = "8px";
      sportsWrap.style.opacity = leagueData.enabled ? "1" : "0.55";

      const catalog = window.leagueSports || [];
      catalog.forEach(sport => {
        const btn = document.createElement("button");
        btn.className = "bunk-button push";
        btn.textContent = sport;
        if (leagueData.sports.includes(sport)) btn.classList.add("active");

        btn.addEventListener("click", () => {
          if (!leagueData.enabled) {
            alert("Enable the league first to select sports.");
            return;
          }
          const arr = leagueData.sports;
          const active = btn.classList.contains("active");
          if (active) {
            btn.classList.remove("active");
            const idx = arr.indexOf(sport);
            if (idx > -1) arr.splice(idx, 1);
          } else {
            btn.classList.add("active");
            if (!arr.includes(sport)) arr.push(sport);
          }
          saveLeagues();
        });

        sportsWrap.appendChild(btn);
      });

      card.appendChild(sportsWrap);
      container.appendChild(card);
    });
  }

  // ---------- Public ----------
  function initLeaguesTab() {
    ensureMount();
    loadSports();
    loadLeagues();
    render();
  }

  // Re-render when divisions change
  window.onDivisionsChanged = (window.onDivisionsChanged || function(){});
  const prev = window.onDivisionsChanged;
  window.onDivisionsChanged = function () {
    prev();
    render();
  };

  window.initLeaguesTab = initLeaguesTab;
})();
