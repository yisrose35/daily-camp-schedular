// leagues.js
// Classic version — fixed sports list and per-division league toggle.
// Exposes window.initLeaguesTab() for index.html to call when "Leagues" tab is opened.

(function () {
  // -------------------- Globals & Setup --------------------
  window.leagues = window.leagues || {};  // { divisionName: { enabled, sports[] } }
  window.leagueSports = ["Basketball","Football","Baseball","Hockey","Volleyball","Soccer","Lacrosse"];

  const STORAGE_KEY = "leaguesData";

  // -------------------- Helpers --------------------
  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(window.leagues));
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") window.leagues = parsed;
      }
    } catch (e) {
      console.warn("Failed to load leagues data:", e);
    }
  }

  // -------------------- UI Rendering --------------------
  function render() {
    const container = document.getElementById("leaguesContainer");
    if (!container) return;
    container.innerHTML = "";

    const divs = Array.isArray(window.availableDivisions)
      ? window.availableDivisions
      : [];

    if (divs.length === 0) {
      container.innerHTML = `<div class="muted">No divisions available. Add divisions in Setup first.</div>`;
      return;
    }

    divs.forEach((divName) => {
      // Ensure data object
      if (!window.leagues[divName])
        window.leagues[divName] = { enabled: false, sports: [] };
      const data = window.leagues[divName];

      // Card container
      const card = document.createElement("div");
      card.className = "league-card";

      // Division name
      const title = document.createElement("h4");
      title.textContent = divName;
      title.style.marginTop = "0";
      card.appendChild(title);

      // League enable toggle
      const toggleRow = document.createElement("div");
      toggleRow.style.display = "flex";
      toggleRow.style.alignItems = "center";
      toggleRow.style.marginBottom = "6px";

      const label = document.createElement("label");
      label.className = "switch";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!data.enabled;
      const slider = document.createElement("span");
      slider.className = "slider";
      label.appendChild(input);
      label.appendChild(slider);

      const text = document.createElement("span");
      text.textContent = "League Enabled";
      text.style.marginLeft = "10px";
      text.style.fontSize = "0.9em";
      text.style.color = "#475569";

      toggleRow.appendChild(label);
      toggleRow.appendChild(text);
      card.appendChild(toggleRow);

      // Sports push buttons
      const sportsWrap = document.createElement("div");
      sportsWrap.className = "chips";
      sportsWrap.style.marginTop = "6px";

      window.leagueSports.forEach((sport) => {
        const btn = document.createElement("button");
        btn.className = "bunk-button push";
        btn.textContent = sport;
        if (data.sports.includes(sport)) btn.classList.add("active");

        btn.addEventListener("click", () => {
          if (!input.checked) {
            alert("Enable the league first to select sports.");
            return;
          }
          const arr = window.leagues[divName].sports;
          if (btn.classList.contains("active")) {
            btn.classList.remove("active");
            const idx = arr.indexOf(sport);
            if (idx > -1) arr.splice(idx, 1);
          } else {
            btn.classList.add("active");
            arr.push(sport);
          }
          save();
        });

        sportsWrap.appendChild(btn);
      });
      card.appendChild(sportsWrap);

      // Behavior for main toggle
      input.addEventListener("change", () => {
        window.leagues[divName].enabled = input.checked;
        save();
        window.updateTable?.();
        // Slight dimming if disabled
        sportsWrap.style.opacity = input.checked ? "1" : "0.55";
      });

      sportsWrap.style.opacity = data.enabled ? "1" : "0.55";

      container.appendChild(card);
    });
  }

  // -------------------- Public API --------------------
  function initLeaguesTab() {
    load();
    render();
  }

  // Re-render on divisions update
  window.onDivisionsChanged = window.onDivisionsChanged || function () {};
  const prev = window.onDivisionsChanged;
  window.onDivisionsChanged = function () {
    prev();
    render();
  };

  // Export
  window.initLeaguesTab = initLeaguesTab;
})();
