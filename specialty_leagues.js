

// ============================================================================
// specialty_leagues.js — FULL THEMED VERSION (EMERALD CAMP THEME)
// ----------------------------------------------------------------------------
// VISUAL ONLY — ZERO LOGIC CHANGES
// Matches the entire scheduling suite theme:
//  • setup-grid / setup-card / master-list
//  • emerald pills & buttons
//  • detail-pane gradient
//  • unified chip/toggle/button styles
// ----------------------------------------------------------------------------
// Mounts to:  #specialty-leagues
// ============================================================================

(function() {
'use strict';

// =============================================================
// STATE
// =============================================================
let specialtyLeagues = {};
let activeLeagueId = null;
let activeTab = null; // "standings" or "games"

// DOM refs
let listEl = null;
let detailPaneEl = null;

// =============================================================
// LOAD + SAVE
// =============================================================
function loadData() {
    const g = window.loadGlobalSettings?.() || {};
    specialtyLeagues = g.specialtyLeagues || {};
}

function saveData() {
    window.saveGlobalSettings?.("specialtyLeagues", specialtyLeagues);
}

function uid() {
    return "sl_" + Math.random().toString(36).substring(2, 8);
}

// =============================================================
// EDITABLE LABEL
// =============================================================
function makeEditable(el, save) {
    el.ondblclick = () => {
        const old = el.textContent;
        const input = document.createElement("input");
        input.type = "text";
        input.value = old;
        input.style.padding = "4px 6px";
        input.style.fontSize = "0.95rem";

        el.replaceWith(input);
        input.focus();

        function done() {
            const val = input.value.trim();
            if (val && val !== old) save(val);
            el.textContent = val || old;
            input.replaceWith(el);
        }

        input.onblur = done;
        input.onkeyup = ev => ev.key === "Enter" && done();
    };
}

// =============================================================
// INIT TAB
// =============================================================
window.initSpecialtyLeagues = function() {
    const container = document.getElementById("specialty-leagues");
    if (!container) return;

    loadData();

    // =========================================================
    // MAIN TEMPLATE (THEMED)
    // =========================================================
    container.innerHTML = `
        <div class="setup-grid">

            <section class="setup-card setup-card-wide">
                <div class="setup-card-header">
                    <span class="setup-step-pill">Specialty Leagues</span>
                    <div class="setup-card-text">
                        <h3>Manage Specialty Leagues</h3>
                        <p>Configure teams, sports, fields, standings & more.</p>
                    </div>
                </div>

                <div style="display:flex; flex-wrap:wrap; gap:20px; margin-top:18px;">

                    <!-- LEFT -->
                    <div style="flex:1; min-width:260px;">
                        <div class="setup-subtitle">Add New Specialty League</div>

                        <div class="setup-field-row" style="margin-top:10px;">
                            <input id="sl-add-input" placeholder="Ex: Basketball League">
                            <button id="sl-add-btn">Add</button>
                        </div>

                        <div class="setup-subtitle" style="margin-top:20px;">All Specialty Leagues</div>
                        <div id="sl-master-list" class="master-list"
                             style="margin-top:10px; max-height:440px; overflow:auto;"></div>
                    </div>

                    <!-- RIGHT -->
                    <div style="flex:1.5; min-width:320px;">
                        <div class="setup-subtitle">League Details</div>
                        <div id="sl-detail-pane" class="detail-pane"
                             style="margin-top:10px; min-height:360px;">
                             <p class="muted">
                                 Select a specialty league to edit its details.
                             </p>
                        </div>
                    </div>

                </div>
            </section>
        </div>

        <style>
            /* =============================================================
               THEMED COMPONENTS (GREEN / EMERALD CORE)
               ============================================================= */

            /* Master-list items */
            .master-list .list-item {
                padding: 10px 10px;
                border-radius: 14px;
                margin-bottom: 6px;
                cursor: pointer;
                display: flex;
                justify-content: space-between;
                align-items: center;
                background: #FFFFFF;
                border: 1px solid #E5E7EB;
                box-shadow: 0 4px 10px rgba(15,23,42,0.05);
                transition: background 0.15s, transform 0.08s, box-shadow 0.15s;
            }
            .master-list .list-item:hover {
                background: #F3F4F6;
                transform: translateY(-1px);
            }
            .master-list .list-item.selected {
                background: radial-gradient(circle at top left, #ECFDF5 0, #FFFFFF 70%);
                border-color: #00C896;
                box-shadow: 0 0 0 1px rgba(0,200,150,0.55);
                font-weight: 600;
            }

            /* Chips (divisions, fields, teams) */
            .sl-chip {
                padding: 4px 10px;
                border-radius: 999px;
                border: 1px solid #D1D5DB;
                font-size: 0.85rem;
                cursor: pointer;
                user-select: none;
                background:#F3F4F6;
                transition: 0.15s;
            }
            .sl-chip.active {
                background:#00C896;
                color:white;
                border-color:#00C896;
            }

            /* Tab buttons (Standings / Games) */
            .sl-tab-btn {
                padding: 8px 14px;
                border-radius: 999px;
                border:none;
                cursor:pointer;
                font-size:0.9rem;
                transition:0.15s;
            }
            .sl-tab-btn.active {
                background:#00C896;
                color:white;
            }
            .sl-tab-btn.inactive {
                background:#E5E7EB;
                color:#111827;
            }

            /* Match rows */
            .sl-match-row {
                display:flex;
                align-items:center;
                gap:12px;
                padding:10px;
                margin-bottom:8px;
                background:#F9FAFB;
                border:1px solid #E5E7EB;
                border-radius:10px;
            }

        </style>
    `;

    // DOM refs after injection
    listEl = document.getElementById("sl-master-list");
    detailPaneEl = document.getElementById("sl-detail-pane");

    // ADD NEW
    const addInput = document.getElementById("sl-add-input");
    const addBtn   = document.getElementById("sl-add-btn");

    const addLeague = () => {
        const name = addInput.value.trim();
        if (!name) return;

        const id = uid();
        specialtyLeagues[id] = {
            id,
            name,
            divisions: [],
            sport: null,
            fields: [],
            teams: [],
            enabled: true,
            standings: {},
            games: []
        };

        saveData();
        activeLeagueId = id;
        addInput.value = "";

        renderMasterList();
        renderDetailPane();
    };

    addBtn.onclick = addLeague;
    addInput.onkeyup = e => e.key === "Enter" && addLeague();

    renderMasterList();
    if (activeLeagueId && specialtyLeagues[activeLeagueId]) {
        renderDetailPane();
    }
};

// =============================================================
// LEFT COLUMN — MASTER LIST
// =============================================================
function renderMasterList() {
    listEl.innerHTML = "";

    const items = Object.values(specialtyLeagues)
        .sort((a,b) => a.name.localeCompare(b.name));

    if (items.length === 0) {
        listEl.innerHTML = `<p class="muted">No specialty leagues yet.</p>`;
        return;
    }

    items.forEach(l => {
        const el = document.createElement("div");
        el.className = "list-item";
        if (l.id === activeLeagueId) el.classList.add("selected");

        el.onclick = () => {
            activeLeagueId = l.id;
            renderMasterList();
            renderDetailPane();
        };

        const nameEl = document.createElement("span");
        nameEl.className = "list-item-name";
        nameEl.textContent = l.name;
        el.appendChild(nameEl);

        // ENABLE/DISABLE TOGGLE
        const tog = document.createElement("label");
        tog.className = "switch list-item-toggle";
        tog.onclick = e => e.stopPropagation();

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = l.enabled;
        cb.onchange = () => {
            l.enabled = cb.checked;
            saveData();
        };

        const slider = document.createElement("span");
        slider.className = "slider";

        tog.append(cb, slider);
        el.appendChild(tog);

        listEl.appendChild(el);
    });
}

// =============================================================
// RIGHT COLUMN — DETAIL PANE
// =============================================================
function renderDetailPane() {
    if (!activeLeagueId || !specialtyLeagues[activeLeagueId]) {
        detailPaneEl.innerHTML = `<p class="muted">Select a specialty league to edit.</p>`;
        return;
    }

    const league = specialtyLeagues[activeLeagueId];
    detailPaneEl.innerHTML = "";

    // ---------------------------------------------------------
    // HEADER
    // ---------------------------------------------------------
    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.alignItems = "center";
    header.style.borderBottom = "2px solid #E5E7EB";
    header.style.paddingBottom = "12px";
    header.style.marginBottom = "16px";

    const title = document.createElement("h3");
    title.textContent = league.name;
    title.style.margin = "0";
    title.style.fontWeight = "600";
    title.title = "Double-click to rename";
    makeEditable(title, newName => {
        league.name = newName;
        saveData();
        renderMasterList();
    });

    const btnWrap = document.createElement("div");

    const standingsBtn = document.createElement("button");
    standingsBtn.textContent = "Standings & Games";
    standingsBtn.style.background = "#00C896";
    standingsBtn.style.color = "white";
    standingsBtn.style.border = "none";
    standingsBtn.style.padding = "6px 14px";
    standingsBtn.style.borderRadius = "999px";
    standingsBtn.style.cursor = "pointer";
    standingsBtn.style.marginRight = "10px";

    const delBtn = document.createElement("button");
    delBtn.textContent = "Delete";
    delBtn.style.background = "#DC2626";
    delBtn.style.color = "white";
    delBtn.style.border = "none";
    delBtn.style.padding = "6px 14px";
    delBtn.style.borderRadius = "999px";
    delBtn.style.cursor = "pointer";

    delBtn.onclick = () => {
        if (confirm(`Delete "${league.name}"?`)) {
            delete specialtyLeagues[league.id];
            activeLeagueId = null;
            saveData();
            renderMasterList();
            renderDetailPane();
        }
    };

    btnWrap.append(standingsBtn, delBtn);

    header.append(title, btnWrap);
    detailPaneEl.appendChild(header);

    // ---------------------------------------------------------
    // STANDINGS BOX (TOGGLE)
    // ---------------------------------------------------------
    const standingsBox = document.createElement("div");
    standingsBox.style.display = activeTab === "standings" ? "block" : "none";
    standingsBox.style.marginBottom = "20px";
    standingsBox.style.padding = "18px";
    standingsBox.style.background = "#FFFFFF";
    standingsBox.style.border = "1px solid #E5E7EB";
    standingsBox.style.borderRadius = "14px";
    detailPaneEl.appendChild(standingsBox);

    standingsBtn.onclick = () => {
        activeTab = activeTab === "standings" ? null : "standings";
        renderDetailPane();
    };

    if (activeTab === "standings") {
        renderStandingsUI(league, standingsBox);
    }

    // ---------------------------------------------------------
    // DIVISIONS
    // ---------------------------------------------------------
    const divSec = document.createElement("div");
    divSec.innerHTML = `<strong>Divisions:</strong>`;
    const divChips = document.createElement("div");
    divChips.style.display = "flex";
    divChips.style.flexWrap = "wrap";
    divChips.style.gap = "6px";
    divChips.style.marginTop = "8px";

    (window.availableDivisions || []).forEach(div => {
        const active = league.divisions.includes(div);
        const chip = document.createElement("span");
        chip.className = "sl-chip" + (active ? " active" : "");
        chip.textContent = div;

        chip.onclick = () => {
            if (active)
                league.divisions = league.divisions.filter(x => x !== div);
            else
                league.divisions.push(div);

            saveData();
            renderDetailPane();
        };

        divChips.appendChild(chip);
    });

    divSec.appendChild(divChips);
    detailPaneEl.appendChild(divSec);

    // ---------------------------------------------------------
    // SPORT
    // ---------------------------------------------------------
    const sportSec = document.createElement("div");
    sportSec.style.marginTop = "20px";
    sportSec.innerHTML = `<strong>Sport:</strong>`;

    const sportSel = document.createElement("select");
    sportSel.style.marginTop = "6px";
    sportSel.style.padding = "6px 10px";
    sportSel.style.borderRadius = "8px";
    sportSel.style.border = "1px solid #D1D5DB";

    sportSel.innerHTML = `<option value="">-- Select --</option>`;
    (window.getAllGlobalSports?.() || []).forEach(s => {
        const opt = document.createElement("option");
        opt.value = s;
        opt.textContent = s;
        if (league.sport === s) opt.selected = true;
        sportSel.appendChild(opt);
    });

    sportSel.onchange = () => {
        league.sport = sportSel.value || null;
        league.fields = []; // clear fields if sport changed
        saveData();
        renderDetailPane();
    };

    sportSec.appendChild(sportSel);
    detailPaneEl.appendChild(sportSec);

    // ---------------------------------------------------------
    // FIELDS (after choosing sport)
    // ---------------------------------------------------------
    if (league.sport) {
        const fieldSec = document.createElement("div");
        fieldSec.style.marginTop = "20px";
        fieldSec.innerHTML = `<strong>Fields for ${league.sport}:</strong>`;

        const fieldChips = document.createElement("div");
        fieldChips.style.display = "flex";
        fieldChips.style.flexWrap = "wrap";
        fieldChips.style.gap = "6px";
        fieldChips.style.marginTop = "6px";

        const allFields = window.loadGlobalSettings?.().app1.fields || [];
        const relevant = allFields.filter(
            f => f.activities && f.activities.includes(league.sport)
        );

        if (relevant.length === 0) {
            fieldChips.innerHTML = `<span class="muted">No fields support this sport.</span>`;
        } else {
            relevant.forEach(f => {
                const active = league.fields.includes(f.name);
                const chip = document.createElement("span");
                chip.className = "sl-chip" + (active ? " active" : "");
                chip.textContent = f.name;

                chip.onclick = () => {
                    if (active)
                        league.fields = league.fields.filter(x => x !== f.name);
                    else
                        league.fields.push(f.name);

                    saveData();
                    renderDetailPane();
                };

                fieldChips.appendChild(chip);
            });
        }

        fieldSec.appendChild(fieldChips);
        detailPaneEl.appendChild(fieldSec);
    }

    // ---------------------------------------------------------
    // TEAMS
    // ---------------------------------------------------------
    const teamSec = document.createElement("div");
    teamSec.style.marginTop = "20px";
    teamSec.innerHTML = `<strong>Teams:</strong>`;

    const teamChips = document.createElement("div");
    teamChips.style.display = "flex";
    teamChips.style.flexWrap = "wrap";
    teamChips.style.gap = "6px";
    teamChips.style.marginTop = "8px";

    league.teams.forEach(t => {
        const chip = document.createElement("span");
        chip.className = "sl-chip active";
        chip.textContent = `${t} ✖`;

        chip.onclick = () => {
            league.teams = league.teams.filter(x => x !== t);
            delete league.standings[t];
            saveData();
            renderDetailPane();
        };

        teamChips.appendChild(chip);
    });

    teamSec.appendChild(teamChips);

    const addTeam = document.createElement("input");
    addTeam.placeholder = "Add team (Press Enter)";
    addTeam.style.marginTop = "10px";
    addTeam.style.padding = "6px 10px";
    addTeam.style.borderRadius = "8px";
    addTeam.style.border = "1px solid #D1D5DB";
    addTeam.style.width = "200px";

    addTeam.onkeyup = e => {
        if (e.key !== "Enter") return;
        const t = addTeam.value.trim();
        if (!t) return;
        if (!league.teams.includes(t)) {
            league.teams.push(t);
            league.standings[t] = { w:0, l:0, t:0 };
            saveData();
        }
        addTeam.value = "";
        renderDetailPane();
    };

    teamSec.appendChild(addTeam);
    detailPaneEl.appendChild(teamSec);
}

// =============================================================
// STANDINGS UI
// =============================================================
function renderStandingsUI(league, container) {
    container.innerHTML = "";

    // Tabs
    const tabNav = document.createElement("div");
    tabNav.style.marginBottom = "15px";

    const btnStd = document.createElement("button");
    btnStd.className = "sl-tab-btn " + (activeTab === "standings" ? "active" : "inactive");
    btnStd.textContent = "Standings";

    const btnGames = document.createElement("button");
    btnGames.className = "sl-tab-btn " + (activeTab === "games" ? "active" : "inactive");
    btnGames.textContent = "Games";

    tabNav.append(btnStd, btnGames);
    container.appendChild(tabNav);

    const content = document.createElement("div");
    container.appendChild(content);

    btnStd.onclick = () => {
        activeTab = "standings";
        renderDetailPane();
    };

    btnGames.onclick = () => {
        activeTab = "games";
        renderDetailPane();
    };

    if (activeTab === "games") {
        renderGamesEditor(league, content);
    } else {
        content.innerHTML = renderStandingsTable(league);
    }
}

// =============================================================
// STANDINGS TABLE
// =============================================================
function renderStandingsTable(league) {
    // Reset stats
    league.teams.forEach(t => {
        league.standings[t] = { w:0, l:0, t:0 };
    });

    // Recalc from games
    (league.games || []).forEach(g => {
        g.matches?.forEach(m => {
            if (m.winner === "tie") {
                league.standings[m.teamA].t++;
                league.standings[m.teamB].t++;
            } else {
                league.standings[m.winner].w++;
                const lose = m.winner === m.teamA ? m.teamB : m.teamA;
                league.standings[lose].l++;
            }
        });
    });

    const sorted = [...league.teams].sort(
        (a,b) => league.standings[b].w - league.standings[a].w
    );

    let html = `
        <table style="width:100%; border-collapse:collapse;">
            <thead>
                <tr style="background:#F3F4F6;">
                    <th style="text-align:left; padding:8px;">Team</th>
                    <th style="text-align:center;">W</th>
                    <th style="text-align:center;">L</th>
                    <th style="text-align:center;">T</th>
                </tr>
            </thead>
            <tbody>
    `;

    sorted.forEach(t => {
        const s = league.standings[t];
        html += `
            <tr>
                <td style="padding:8px; border-bottom:1px solid #E5E7EB;">${t}</td>
                <td style="text-align:center;">${s.w}</td>
                <td style="text-align:center;">${s.l}</td>
                <td style="text-align:center;">${s.t}</td>
            </tr>
        `;
    });

    html += "</tbody></table>";
    return html;
}

// =============================================================
// GAME EDITOR (placeholder)
// =============================================================
function renderGamesEditor(league, wrapper) {
    wrapper.innerHTML = `
        <p class="muted" style="font-size:0.9rem;">
            Game entry system for specialty leagues will be added soon.
        </p>
    `;
}
window.masterSpecialtyLeagues = specialtyLeagues;

})();
