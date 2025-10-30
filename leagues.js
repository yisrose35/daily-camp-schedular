// leagues.js
// Controls division league toggles, sport selection, and unique time slot reservation.
// Exposes window.initLeaguesTab() and integrates with app2.js (reserveLeagueRows).

(function(){
  // Globals expected: availableDivisions, divisions, leagueSports, leagues
  window.leagues = window.leagues || {};

  // -------------------- DOM Elements --------------------
  let container;

  function ensureMount(){
    container = document.getElementById("leaguesContainer");
    if(!container){
      container = document.createElement("div");
      container.id = "leaguesContainer";
      document.body.appendChild(container);
    }
  }

  // -------------------- Helpers --------------------
  function render(){
    if(!container) return;
    container.innerHTML = "";

    const divs = Array.isArray(window.availableDivisions) ? window.availableDivisions : [];
    if(divs.length === 0){
      container.innerHTML = `<div class="muted">No divisions available. Add divisions in Setup first.</div>`;
      return;
    }

    divs.forEach(divName=>{
      const leagueData = window.leagues[divName] || { enabled:false, sports:[] };
      const card = document.createElement("div");
      card.className = "league-card";

      const title = document.createElement("h4");
      title.textContent = divName;
      card.appendChild(title);

      // Toggle switch
      const toggleLabel = document.createElement("label");
      toggleLabel.className = "switch";
      toggleLabel.style.marginBottom = "6px";
      const toggleInput = document.createElement("input");
      toggleInput.type = "checkbox";
      toggleInput.checked = !!leagueData.enabled;
      const slider = document.createElement("span");
      slider.className = "slider";
      toggleLabel.appendChild(toggleInput);
      toggleLabel.appendChild(slider);

      const lbl = document.createElement("span");
      lbl.textContent = "League Enabled";
      lbl.style.marginLeft = "10px";
      lbl.style.fontSize = "0.9em";
      lbl.style.color = "#475569";

      const toggleWrap = document.createElement("div");
      toggleWrap.style.display = "flex";
      toggleWrap.style.alignItems = "center";
      toggleWrap.appendChild(toggleLabel);
      toggleWrap.appendChild(lbl);
      card.appendChild(toggleWrap);

      // Sports section
      const sportsWrap = document.createElement("div");
      sportsWrap.className = "chips";
      sportsWrap.style.marginTop = "6px";
      (window.leagueSports || []).forEach(sport=>{
        const btn = document.createElement("button");
        btn.className = "bunk-button push";
        btn.textContent = sport;
        if(leagueData.sports.includes(sport)) btn.classList.add("active");
        btn.addEventListener("click", ()=>{
          if(!toggleInput.checked){
            alert("Enable the league first to select sports.");
            return;
          }
          const arr = window.leagues[divName].sports;
          if(btn.classList.contains("active")){
            btn.classList.remove("active");
            const idx = arr.indexOf(sport);
            if(idx>-1) arr.splice(idx,1);
          } else {
            btn.classList.add("active");
            arr.push(sport);
          }
          save();
        });
        sportsWrap.appendChild(btn);
      });
      card.appendChild(sportsWrap);

      // Event handlers
      toggleInput.addEventListener("change", ()=>{
        window.leagues[divName].enabled = toggleInput.checked;
        save();
        window.updateTable?.();
      });

      // Ensure object exists in global leagues
      if(!window.leagues[divName]){
        window.leagues[divName] = { enabled:false, sports:[] };
      }

      container.appendChild(card);
    });
  }

  // -------------------- Persistence --------------------
  function save(){
    localStorage.setItem("leaguesData", JSON.stringify(window.leagues));
  }

  function load(){
    try{
      const raw = localStorage.getItem("leaguesData");
      if(raw){
        const parsed = JSON.parse(raw);
        if(parsed && typeof parsed === "object") window.leagues = parsed;
      }
    } catch(e){
      console.warn("Failed to load leagues:", e);
    }
  }

  // -------------------- Public API --------------------
  function initLeaguesTab(){
    ensureMount();
    load();
    render();
  }

  // Refresh UI when divisions change
  window.onDivisionsChanged = (window.onDivisionsChanged || function(){});
  const prevHandler = window.onDivisionsChanged;
  window.onDivisionsChanged = function(){
    prevHandler();
    render();
  };

  window.initLeaguesTab = initLeaguesTab;
})();

