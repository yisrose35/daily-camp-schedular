// ============================================================================
// specialty_leagues.js — FULL THEMED VERSION (EMERALD CAMP THEME)
// ----------------------------------------------------------------------------
// UX/UI CLONE OF leagues.js
// ----------------------------------------------------------------------------
// Mounts to:  #specialty-leagues
// ============================================================================

(function() {
    'use strict';

    // =============================================================
    // STATE & GLOBALS
    // =============================================================
    let specialtyLeagues = {};
    window.specialtyLeagues = specialtyLeagues; // Expose globally

    // UI State
    let activeLeagueId = null;
    let listEl = null;
    let detailPaneEl = null;

    // =============================================================
    // HELPERS
    // =============================================================
    function uid() {
        return "sl_" + Math.random().toString(36).substring(2, 8);
    }

    function getPlaceSuffix(n) {
        const s = ['th', 'st', 'nd', 'rd'];
        const v = n % 100;
        return s[(v - 20) % 10] || s[v] || s[0];
    }

    // Time Helpers (for schedule import)
    function parseTimeToMinutes(str) {
        if (!str || typeof str !== "string") return null;
        let s = str.trim().toLowerCase();
        let mer = null;
        if (s.endsWith("am") || s.endsWith("pm")) {
            mer = s.endsWith("am") ? "am" : "pm";
            s = s.replace(/am|pm/g, "").trim();
        }
        const m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
        if (!m) return null;
        let hh = parseInt(m[1], 10);
        const mm = parseInt(m[2], 10);
        if (Number.isNaN(hh) || Number.isNaN(mm)) return null;

        if (mer) {
            if (hh === 12) hh = mer === "am" ? 0 : 12;
            else if (mer === "pm") hh += 12;
        } else {
            // Assume PM for afternoon hours (1-6)
            if (hh >= 1 && hh <= 6) hh += 12;
        }
        return hh * 60 + mm;
    }

    function minutesToTimeLabel(min) {
        const h24 = Math.floor(min / 60);
        const m = String(min % 60).padStart(2, "0");
        const ap = h24 >= 12 ? "PM" : "AM";
        const h12 = h24 % 12 || 12;
        return `${h12}:${m} ${ap}`;
    }

    function findSlotIndexForTime(targetMin) {
        const times = window.unifiedTimes || [];
        const INCREMENT_MINS = window.INCREMENT_MINS || 30;

        for (let i = 0; i < times.length; i++) {
            const d = new Date(times[i].start);
            const slotStart = d.getHours() * 60 + d.getMinutes();
            let slotEnd;

            if (times[i].end) {
                const e = new Date(times[i].end);
                slotEnd = e.getHours() * 60 + e.getMinutes();
            } else {
                slotEnd = slotStart + INCREMENT_MINS;
            }

            if (targetMin >= slotStart && targetMin < slotEnd) {
                return i;
            }
        }
        return -1;
    }

    function makeEditable(el, saveCallback) {
        el.ondblclick = (e) => {
            e.stopPropagation();
            const oldText = el.textContent;
            const input = document.createElement('input');
            input.type = 'text';
            input.value = oldText;
            Object.assign(input.style, {
                fontSize: 'inherit',
                fontWeight: 'inherit',
                width: '100%',
                boxSizing: 'border-box'
            });

            el.replaceWith(input);
            input.focus();

            const finish = () => {
                const newVal = input.value.trim();
                if (newVal && newVal !== oldText) saveCallback(newVal);
                el.textContent = newVal || oldText;
                input.replaceWith(el);
            };

            input.onblur = finish;
            input.onkeyup = (ev) => {
                if (ev.key === 'Enter') finish();
            };
        };
    }

    // =============================================================
    // LOAD + SAVE
    // =============================================================
    function loadData() {
        const g = window.loadGlobalSettings?.() || {};
        const loaded = g.specialtyLeagues || {};
        
        // Clear and fill
        Object.keys(specialtyLeagues).forEach(k => delete specialtyLeagues[k]);
        Object.assign(specialtyLeagues, loaded);

        // Ensure defaults
        Object.values(specialtyLeagues).forEach(l => {
            l.divisions = l.divisions || [];
            l.sport = l.sport || null; // Single sport usually for specialty
            l.fields = l.fields || [];
            l.teams = l.teams || [];
            l.enabled = l.enabled !== false;
            l.standings = l.standings || {};
            l.games = l.games || [];
            
            // Ensure standing entries exist for all teams
            l.teams.forEach(t => {
                if (!l.standings[t]) l.standings[t] = { w: 0, l: 0, t: 0 };
            });
        });

        // Ensure ALL teams have standing entries
        Object.values(specialtyLeagues).forEach(l => {
            if (!l.standings) l.standings = {};
            
            (l.teams || []).forEach(t => {
                if (!l.standings[t]) {
                    l.standings[t] = { w: 0, l: 0, t: 0 };
                }
            });
        });
    }

    function saveData() {
        window.saveGlobalSettings?.("specialtyLeagues", specialtyLeagues);
        
        // ⭐ Trigger cloud sync
        if (typeof window.forceSyncToCloud === 'function') {
            clearTimeout(window._specialtyLeaguesSyncTimeout);
            window._specialtyLeaguesSyncTimeout = setTimeout(() => {
                window.forceSyncToCloud();
            }, 500);
        }
    }

    // =============================================================
    // INIT TAB
    // =============================================================
    window.initSpecialtyLeagues = function() {
        const container = document.getElementById("specialty-leagues");
        if (!container) return;

        loadData();

        // ---------------------------------------------------------
        // MAIN TEMPLATE
        // ---------------------------------------------------------
        container.innerHTML = `
            <div class="setup-grid">
                <section class="setup-card setup-card-wide">
                    <div class="setup-card-header">
                        <span class="setup-step-pill">Specialty Leagues</span>
                        <div class="setup-card-text">
                            <h3>Manage Specialty Leagues</h3>
                            <p>Configure themed tournaments, one-off cups, and activity-specific leagues.</p>
                        </div>
                    </div>

                    <div style="display:flex; flex-wrap:wrap; gap:20px; margin-top:10px;">
                        <!-- LEFT COL: MASTER LIST -->
                        <div style="flex:1; min-width:260px;">
                            <div class="setup-subtitle">All Leagues</div>
                            <p style="font-size:0.8rem; color:#6b7280; margin-top:4px;">
                                Select a league to edit. Double-click title to rename.
                            </p>
                            
                            <div class="setup-field-row" style="margin-top:10px;">
                                <input id="sl-add-input" placeholder="Name (e.g. 3v3 Basketball)">
                                <button id="sl-add-btn" style="background: #00C896; color: white; border-color: #00C896; font-weight:600;">Add</button>
                            </div>

                            <div id="sl-master-list" class="master-list"
                                 style="margin-top:10px; max-height:440px; overflow:auto;"></div>
                        </div>

                        <!-- RIGHT COL: DETAIL PANE -->
                        <div style="flex:1.4; min-width:320px;">
                            <div class="setup-subtitle">League Details</div>
                            <div id="sl-detail-pane" class="detail-pane"
                                 style="margin-top:8px; min-height:380px;">
                                 <p class="muted">
                                    Select a specialty league to edit configuration and view standings.
                                 </p>
                            </div>
                        </div>
                    </div>
                </section>
            </div>

            <style>
                /* Reuse League Styles for consistency */
                .master-list {
                    border-radius: 18px;
                    border: 1px solid #E5E7EB;
                    background: #F7F9FA;
                    padding: 8px 6px;
                    box-shadow: 0 10px 24px rgba(15,23,42,0.04);
                }
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
                    transition: background 0.15s, box-shadow 0.15s, transform 0.08s;
                }
                .master-list .list-item:hover {
                    background: #F3F4F6;
                    box-shadow: 0 8px 18px rgba(15, 23, 42, 0.10);
                    transform: translateY(-1px);
                }
                .master-list .list-item.selected {
                    background: radial-gradient(circle at top left, #ECFDF5 0, #FFFFFF 70%);
                    border-color: #00C896;
                    box-shadow: 0 0 0 1px rgba(0, 200, 150, 0.55);
                    font-weight: 600;
                }
                .master-list .list-item-name {
                    font-size: 0.88rem;
                    font-weight: 500;
                    color: #111827;
                }
                
                .detail-pane {
                    border-radius: 18px;
                    border: 1px solid #E5E7EB;
                    padding: 18px 20px;
                    background: linear-gradient(135deg, #F7F9FA 0%, #FFFFFF 55%, #F7F9FA 100%);
                    box-shadow: 0 18px 40px rgba(15,23,42,0.06);
                }
                
                .league-section-card {
                    border-radius: 16px;
                    border: 1px solid #E5E7EB;
                    background: #FFFFFF;
                    padding: 12px 14px;
                    box-shadow: 0 10px 22px rgba(15, 23, 42, 0.05);
                    margin-bottom: 12px;
                }
                .league-section-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    margin-bottom: 8px;
                    font-size: 0.78rem;
                    text-transform: uppercase;
                    letter-spacing: 0.06em;
                    color: #6B7280;
                }
                .league-section-title { font-weight: 600; }
                
                .chips { display: flex; flex-wrap: wrap; gap: 6px; }
                .chip {
                    padding: 4px 10px;
                    border-radius: 999px;
                    border: 1px solid #d1d5db;
                    cursor: pointer;
                    font-size: 0.8rem;
                    background: #f8fafc;
                    transition: all 0.15s ease;
                }
                .chip.active {
                    background: #00C896;
                    border-color: #00C896;
                    color: #fff;
                    box-shadow: 0 3px 8px rgba(0, 200, 150, 0.35);
                }

                .group-header {
                    background: #ECFDF5;
                    padding: 8px 12px;
                    font-weight: 700;
                    font-size: 0.85rem;
                    color: #064E3B;
                    border-radius: 8px;
                    margin-top: 15px;
                    margin-bottom: 8px;
                    border-left: 4px solid #00C896;
                }
                .muted { color: #6B7280; font-size: 0.86rem; }
            </style>
        `;

        // References
        listEl = document.getElementById("sl-master-list");
        detailPaneEl = document.getElementById("sl-detail-pane");
        const addInput = document.getElementById("sl-add-input");
        const addBtn   = document.getElementById("sl-add-btn");

        // Add Logic
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
    // MASTER LIST
    // =============================================================
    function renderMasterList() {
        listEl.innerHTML = "";
        const items = Object.values(specialtyLeagues).sort((a,b) => a.name.localeCompare(b.name));

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

            el.innerHTML = `<span class="list-item-name">${l.name}</span>`;

            // Toggle
            const tog = document.createElement("label");
            tog.className = "switch";
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
    // DETAIL PANE
    // =============================================================
    function renderDetailPane() {
        if (!activeLeagueId || !specialtyLeagues[activeLeagueId]) {
            detailPaneEl.innerHTML = `<p class="muted">Select a league.</p>`;
            return;
        }

        const league = specialtyLeagues[activeLeagueId];
        detailPaneEl.innerHTML = "";

        // --- HEADER ---
        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '15px',
            borderBottom: '2px solid #E5E7EB',
            paddingBottom: '10px'
        });

        const title = document.createElement('h3');
        title.style.margin = '0';
        title.style.fontSize = '1.1rem';
        title.textContent = league.name;
        title.title = "Double-click to rename";
        makeEditable(title, (newName) => {
            league.name = newName;
            saveData();
            renderMasterList();
        });

        const btnGroup = document.createElement('div');
        btnGroup.style.display = 'flex';
        btnGroup.style.gap = '8px';

        // EDIT SETUP BTN
        const editConfigBtn = document.createElement('button');
        editConfigBtn.textContent = 'Edit Setup';
        Object.assign(editConfigBtn.style, {
            background: '#FFFFFF',
            color: '#111827',
            border: '1px solid #D1D5DB',
            borderRadius: '999px',
            fontWeight: '500',
            cursor: 'pointer',
            padding: '6px 14px'
        });

        // DELETE BTN
        const delBtn = document.createElement('button');
        delBtn.textContent = 'Delete';
        Object.assign(delBtn.style, {
            background: '#FFFFFF',
            color: '#DC2626',
            border: '1px solid #FECACA',
            borderRadius: '999px',
            cursor: 'pointer',
            fontWeight: '600',
            fontSize: '0.85rem',
            padding: '6px 14px',
            boxShadow: '0 4px 10px rgba(220,38,38,0.18)'
        });
        delBtn.onmouseenter = () => { delBtn.style.background = '#FEE2E2'; };
        delBtn.onmouseleave = () => { delBtn.style.background = '#FFFFFF'; };
        delBtn.onclick = () => {
            if (confirm(`Delete "${league.name}"?`)) {
                delete specialtyLeagues[league.id];
                activeLeagueId = null;
                saveData();
                renderMasterList();
                renderDetailPane();
            }
        };

        btnGroup.append(editConfigBtn, delBtn);
        header.append(title, btnGroup);
        detailPaneEl.appendChild(header);

        // --- CONFIG CONTAINER (Hidden by default) ---
        const configContainer = document.createElement('div');
        Object.assign(configContainer.style, {
            display: 'none',
            marginBottom: '20px',
            animation: 'fadeIn 0.2s ease-in-out'
        });

        renderConfigSections(league, configContainer);
        detailPaneEl.appendChild(configContainer);

        editConfigBtn.onclick = () => {
            const hidden = configContainer.style.display === 'none';
            if (hidden) {
                configContainer.style.display = 'block';
                editConfigBtn.textContent = 'Close Setup';
                editConfigBtn.style.background = '#F3F4F6';
            } else {
                configContainer.style.display = 'none';
                editConfigBtn.textContent = 'Edit Setup';
                editConfigBtn.style.background = '#FFFFFF';
            }
        };

        // --- MAIN CONTENT ---
        const mainContent = document.createElement('div');
        renderGameResultsUI(league, mainContent);
        detailPaneEl.appendChild(mainContent);
    }

    // =============================================================
    // CONFIG SECTIONS (Cards)
    // =============================================================
    function renderConfigSections(league, container) {
        container.innerHTML = '';

        // CARD 1: DIVISIONS
        const divCard = document.createElement('div');
        divCard.className = 'league-section-card';
        divCard.innerHTML = `
            <div class="league-section-header">
                <span class="league-section-title">Divisions</span>
                <span>Participants</span>
            </div>
        `;
        const divChips = document.createElement('div');
        divChips.className = 'chips';
        (window.availableDivisions || []).forEach((divName) => {
            const isActive = league.divisions.includes(divName);
            const chip = document.createElement('span');
            chip.className = 'chip' + (isActive ? ' active' : '');
            chip.textContent = divName;
            chip.onclick = () => {
                if (isActive) league.divisions = league.divisions.filter(d => d !== divName);
                else league.divisions.push(divName);
                saveData();
                renderConfigSections(league, container);
            };
            divChips.appendChild(chip);
        });
        divCard.appendChild(divChips);
        container.appendChild(divCard);

        // CARD 2: SPORT (Single Select usually, but allows switching)
        const sportCard = document.createElement('div');
        sportCard.className = 'league-section-card';
        sportCard.innerHTML = `
            <div class="league-section-header">
                <span class="league-section-title">Sport / Activity</span>
                <span>Select One</span>
            </div>
        `;
        const sportChips = document.createElement('div');
        sportChips.className = 'chips';
        (window.getAllGlobalSports?.() || []).forEach((act) => {
            const isActive = league.sport === act;
            const chip = document.createElement('span');
            chip.className = 'chip' + (isActive ? ' active' : '');
            chip.textContent = act;
            chip.onclick = () => {
                // Toggle off or set new
                league.sport = isActive ? null : act;
                // Clear fields if sport changes
                if(!isActive) league.fields = []; 
                saveData();
                renderConfigSections(league, container);
            };
            sportChips.appendChild(chip);
        });
        sportCard.appendChild(sportChips);
        container.appendChild(sportCard);

        // CARD 3: FIELDS (Dependent on Sport)
        if (league.sport) {
            const fieldCard = document.createElement('div');
            fieldCard.className = 'league-section-card';
            fieldCard.innerHTML = `
                <div class="league-section-header">
                    <span class="league-section-title">Fields</span>
                    <span>For Schedule Import</span>
                </div>
            `;
            const fieldChips = document.createElement('div');
            fieldChips.className = 'chips';
            
            const allFields = window.loadGlobalSettings?.().app1.fields || [];
            const relevantFields = allFields.filter(f => f.activities && f.activities.includes(league.sport));
            
            if (relevantFields.length === 0) {
                fieldChips.innerHTML = `<span class="muted">No fields found for ${league.sport}.</span>`;
            } else {
                relevantFields.forEach(f => {
                    const isActive = league.fields.includes(f.name);
                    const chip = document.createElement('span');
                    chip.className = 'chip' + (isActive ? ' active' : '');
                    chip.textContent = f.name;
                    chip.onclick = () => {
                        if (isActive) league.fields = league.fields.filter(x => x !== f.name);
                        else league.fields.push(f.name);
                        saveData();
                        renderConfigSections(league, container);
                    };
                    fieldChips.appendChild(chip);
                });
            }
            fieldCard.appendChild(fieldChips);
            container.appendChild(fieldCard);
        }

        // CARD 4: TEAMS
        const teamCard = document.createElement('div');
        teamCard.className = 'league-section-card';
        teamCard.innerHTML = `
            <div class="league-section-header">
                <span class="league-section-title">Teams</span>
                <span>Roster</span>
            </div>
        `;
        const teamList = document.createElement('div');
        teamList.className = 'chips';
        league.teams.forEach(team => {
            const chip = document.createElement('span');
            chip.className = 'chip active';
            chip.innerHTML = `${team} <span style="opacity:0.6; margin-left:4px;">&times;</span>`;
            chip.onclick = () => {
                league.teams = league.teams.filter(t => t !== team);
                delete league.standings[team];
                saveData();
                renderConfigSections(league, container);
            };
            teamList.appendChild(chip);
        });
        teamCard.appendChild(teamList);

        const teamInput = document.createElement('input');
        teamInput.placeholder = 'Type team name & press Enter...';
        teamInput.style.marginTop = '10px';
        teamInput.style.width = '100%';
        teamInput.onkeyup = e => {
            if (e.key === 'Enter' && teamInput.value.trim()) {
                const t = teamInput.value.trim();
                if (!league.teams.includes(t)) {
                    league.teams.push(t);
                    league.standings[t] = { w: 0, l: 0, t: 0 };
                    saveData();
                    renderConfigSections(league, container);
                    const inputs = container.querySelectorAll('input');
                    if(inputs.length) inputs[inputs.length - 1].focus();
                }
            }
        };
        teamCard.appendChild(teamInput);
        container.appendChild(teamCard);
    }

    // =============================================================
    // MAIN UI: STANDINGS VS GAMES
    // =============================================================
    function renderGameResultsUI(league, container) {
        container.innerHTML = '';
        const tabNav = document.createElement('div');
        tabNav.style.marginBottom = '15px';
        tabNav.style.display = 'flex';
        tabNav.style.gap = '8px';
        tabNav.innerHTML = `
            <button id="sl-tab-standings" class="active">Current Standings</button>
            <button id="sl-tab-games">Game Results / History</button>
        `;
        container.appendChild(tabNav);

        const standingsDiv = document.createElement('div');
        const gamesDiv = document.createElement('div');
        gamesDiv.style.display = 'none';
        container.appendChild(standingsDiv);
        container.appendChild(gamesDiv);

        const btnStd = tabNav.querySelector('#sl-tab-standings');
        const btnGms = tabNav.querySelector('#sl-tab-games');

        // Style helper
        const setTab = (activeBtn, inactiveBtn) => {
            Object.assign(activeBtn.style, {
                 background: '#00C896',
                 color: 'white',
                 borderColor: '#00C896',
                borderRadius: '999px',
                padding: '8px 16px',
                boxShadow: '0 3px 8px rgba(0, 200, 150, 0.35)'
            });
            Object.assign(inactiveBtn.style, {
                 background: '#F3F4F6',
                 color: '#111827',
                 borderColor: '#D1D5DB',
                borderRadius: '999px',
                padding: '8px 16px',
                boxShadow: 'none'
            });
        };

        setTab(btnStd, btnGms);

        btnStd.onclick = () => {
            standingsDiv.style.display = 'block';
            gamesDiv.style.display = 'none';
            setTab(btnStd, btnGms);
            renderStandingsTable(league, standingsDiv);
        };

        btnGms.onclick = () => {
            standingsDiv.style.display = 'none';
            gamesDiv.style.display = 'block';
            setTab(btnGms, btnStd);
            renderGameEntryUI(league, gamesDiv);
        };

        renderStandingsTable(league, standingsDiv);
    }

    // =============================================================
    // STANDINGS TABLE
    // =============================================================
    function renderStandingsTable(league, container) {
        container.innerHTML = '';
        if (!league.teams || league.teams.length === 0) {
            container.innerHTML = '<p class="muted" style="text-align:center; padding:20px;">No teams. Edit Setup to add teams.</p>';
            return;
        }

        recalcStandings(league);

        const sortedTeams = [...league.teams].sort((a, b) => {
            const sA = league.standings[a] || { w: 0, l: 0, t: 0 };
            const sB = league.standings[b] || { w: 0, l: 0, t: 0 };
            if (sA.w !== sB.w) return sB.w - sA.w;
            if (sA.l !== sB.l) return sA.l - sB.l;
            if (sA.t !== sB.t) return sB.t - sA.t;
            return a.localeCompare(b);
        });

        let html = `
            <table style="width:100%; border-collapse:separate; border-spacing:0; border:1px solid #E5E7EB; border-radius:12px; overflow:hidden;">
                <thead style="background:#F9FAFB;">
                    <tr>
                        <th style="text-align:left; padding:12px 16px; border-bottom:1px solid #E5E7EB; color:#6B7280; font-size:0.75rem; text-transform:uppercase;">Place</th>
                        <th style="text-align:left; padding:12px 16px; border-bottom:1px solid #E5E7EB; color:#6B7280; font-size:0.75rem; text-transform:uppercase;">Team</th>
                        <th style="padding:12px; border-bottom:1px solid #E5E7EB; text-align:center; color:#6B7280; font-size:0.75rem; text-transform:uppercase;">W</th>
                        <th style="padding:12px; border-bottom:1px solid #E5E7EB; text-align:center; color:#6B7280; font-size:0.75rem; text-transform:uppercase;">L</th>
                        <th style="padding:12px; border-bottom:1px solid #E5E7EB; text-align:center; color:#6B7280; font-size:0.75rem; text-transform:uppercase;">T</th>
                    </tr>
                </thead>
                <tbody style="background:white;">
        `;

        sortedTeams.forEach((team, idx) => {
            const stats = league.standings[team] || { w: 0, l: 0, t: 0 };
            const borderBottom = idx < sortedTeams.length - 1 ? '1px solid #F3F4F6' : 'none';
            html += `
                <tr>
                    <td style="padding:12px 16px; border-bottom:${borderBottom}; font-weight:600; color:#111827;">${idx + 1}${getPlaceSuffix(idx + 1)}</td>
                    <td style="padding:12px 16px; border-bottom:${borderBottom}; font-weight:500;">${team}</td>
                    <td style="padding:12px; border-bottom:${borderBottom}; text-align:center; color:#059669; font-weight:600;">${stats.w}</td>
                    <td style="padding:12px; border-bottom:${borderBottom}; text-align:center; color:#DC2626;">${stats.l}</td>
                    <td style="padding:12px; border-bottom:${borderBottom}; text-align:center; color:#6B7280;">${stats.t}</td>
                </tr>
            `;
        });
        html += `</tbody></table>`;
        container.innerHTML = html;
    }

    // =============================================================
    // GAME ENTRY
    // =============================================================
    function renderGameEntryUI(league, container) {
        container.innerHTML = '';

        const controls = document.createElement('div');
        Object.assign(controls.style, {
            marginBottom: '15px',
            padding: '12px',
            background: '#F9FAFB',
            borderRadius: '12px',
            border: '1px solid #E5E7EB',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '10px',
            alignItems: 'center'
        });

        const select = document.createElement('select');
        select.style.flex = "1";
        select.innerHTML = `<option value="new">-- Enter New Game Results --</option>`;
        (league.games || []).forEach((g, idx) => {
            const label = g.name || `Game ${idx + 1}`;
            select.innerHTML += `<option value="${idx}">${label} (${g.date})</option>`;
        });

        const importBtn = document.createElement('button');
        importBtn.textContent = "Import Today's Schedule";
        Object.assign(importBtn.style, {
            background: '#00C896',
            color: 'white',
            borderColor: '#00C896',
            boxShadow: '0 2px 4px rgba(0, 200, 150, 0.3)',
            fontWeight: '600'
        });

        controls.appendChild(select);
        controls.appendChild(importBtn);

        const matchContainer = document.createElement('div');
        matchContainer.style.maxHeight = '420px';
        matchContainer.style.overflowY = 'auto';
        matchContainer.style.padding = '4px';

        container.appendChild(controls);
        container.appendChild(matchContainer);

        const saveBtn = document.createElement('button');
        saveBtn.textContent = 'Save Game Results';
        Object.assign(saveBtn.style, {
            marginTop: '15px',
            width: '100%',
            background: '#00C896',
            color: 'white',
            borderColor: '#00C896',
            display: 'none',
            fontWeight: '600',
            boxShadow: '0 3px 8px rgba(0, 200, 150, 0.35)'
        });
        saveBtn.dataset.role = 'save-game-results';
        saveBtn.onclick = () => saveGameResults(league, select.value, matchContainer);

        container.appendChild(saveBtn);

        importBtn.onclick = () => importGamesFromSchedule(league, matchContainer);

        select.onchange = () => {
            matchContainer.innerHTML = '';
            if (select.value === 'new') {
                importBtn.style.display = 'inline-block';
                saveBtn.style.display = 'none';
            } else {
                importBtn.style.display = 'none';
                saveBtn.style.display = 'inline-block';
                loadExistingGame(league, select.value, matchContainer, saveBtn);
            }
        };

        function loadExistingGame(leagueObj, gameIdx, target, saveButton) {
            const game = leagueObj.games[gameIdx];
            if (!game) return;
            const groupedMatches = {};
            game.matches.forEach((m) => {
                const label = m.timeLabel || 'Matchups';
                if (!groupedMatches[label]) groupedMatches[label] = [];
                groupedMatches[label].push(m);
            });

            const labels = Object.keys(groupedMatches).sort((a, b) => {
                return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
            });

            labels.forEach((label) => {
                const header = document.createElement('div');
                header.className = 'group-header';
                header.textContent = label;
                target.appendChild(header);
                groupedMatches[label].forEach((m) => {
                    addMatchRow(target, m.teamA, m.teamB, m.scoreA, m.scoreB, saveButton, label);
                });
            });
        }
    }

    function addMatchRow(target, teamA, teamB, scoreA = '', scoreB = '', saveButton, timeLabel = '') {
        const row = document.createElement('div');
        row.className = 'match-row';
        Object.assign(row.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            marginBottom: '8px',
            padding: '10px 12px',
            background: '#FFFFFF',
            border: '1px solid #E5E7EB',
            borderRadius: '10px',
            boxShadow: '0 2px 4px rgba(0,0,0,0.02)'
        });

        row.innerHTML = `
            <strong style="flex:1; text-align:right; font-size:0.9rem;">${teamA}</strong>
            <input type="number" class="score-a" value="${scoreA}"
                   style="width:50px; text-align:center; padding:6px; font-weight:bold; border-color:#9CA3AF;">
            <span style="color:#6B7280; font-size:0.8rem; font-weight:bold;">VS</span>
            <input type="number" class="score-b" value="${scoreB}"
                   style="width:50px; text-align:center; padding:6px; font-weight:bold; border-color:#9CA3AF;">
            <strong style="flex:1; font-size:0.9rem;">${teamB}</strong>
        `;

        row.dataset.teamA = teamA;
        row.dataset.teamB = teamB;
        if (timeLabel) row.dataset.timeLabel = timeLabel;

        target.appendChild(row);
        if (saveButton) saveButton.style.display = 'block';
    }

    // =============================================================
    // IMPORT LOGIC (SPECIALTY SPECIFIC)
    // =============================================================
    function importGamesFromSchedule(league, target) {
        target.innerHTML = '';
        
        const daily = window.loadCurrentDailyData?.() || {};
        const skeleton = daily.manualSkeleton || [];
        const assignments = daily.scheduleAssignments || {};
        const divisions = window.divisions || {};
        
        const saveButton = target.parentElement.querySelector('[data-role="save-game-results"]');

        if (!league.teams || league.teams.length === 0) {
            target.innerHTML = `<p class="muted" style="text-align:center; margin-top:20px;">Add teams to this league first.</p>`;
            return;
        }

        const gamesFound = {};

        // 1. Iterate over skeleton blocks
        skeleton.forEach(block => {
            // Must match division
            if (!league.divisions.includes(block.division)) return;

            // Get assignments
            const startMin = parseTimeToMinutes(block.startTime);
            const slotIdx = findSlotIndexForTime(startMin);
            if (slotIdx === -1) return;

            const divBunks = divisions[block.division]?.bunks || [];
            if (divBunks.length === 0) return;
            const representativeBunk = divBunks[0];
            
            const entry = assignments[representativeBunk]?.[slotIdx];
            if (!entry) return;

            // CRITERIA FOR SPECIALTY LEAGUES:
            // 1. Entry Sport matches League Sport
            // 2. Entry Field matches one of League Fields
            const entrySport = (entry.sport || "").trim();
            const entryField = (typeof entry.field === 'string' ? entry.field : "").trim();

            const matchSport = league.sport && entrySport === league.sport;
            const matchField = league.fields.includes(entryField);

            if (!matchSport && !matchField) return;

            // Found a block!
            let headerLabel = `${block.event} (${minutesToTimeLabel(startMin)})`;

            // Scan for Teams
            let linesToScan = [];
            if (entry._allMatchups && Array.isArray(entry._allMatchups) && entry._allMatchups.length > 0) {
                linesToScan = entry._allMatchups;
            } else if (entryField) {
                linesToScan = entryField.split('\n');
            } else if (entrySport) {
                linesToScan = [entrySport];
            }

            linesToScan.forEach(line => {
                // Regex for "Team A vs Team B"
                const m = line.match(/^(.*?)\s+vs\.?\s+(.*?)(?:\s*[@\(]|$)/i);
                if (m) {
                    const tA = m[1].trim();
                    const tB = m[2].trim();

                    if (league.teams.includes(tA) && league.teams.includes(tB)) {
                        if (!gamesFound[headerLabel]) gamesFound[headerLabel] = [];
                        
                        const exists = gamesFound[headerLabel].some(g =>
                             (g.teamA === tA && g.teamB === tB) ||
                             (g.teamA === tB && g.teamB === tA)
                        );
                        
                        if (!exists) {
                            gamesFound[headerLabel].push({ teamA: tA, teamB: tB });
                        }
                    }
                }
            });
        });

        const groupNames = Object.keys(gamesFound).sort((a,b) =>
             a.localeCompare(b, undefined, {numeric: true})
        );

        if (groupNames.length === 0) {
            target.innerHTML = `<p class="muted" style="text-align:center; padding:10px;">
                Found valid blocks for ${league.sport || 'sport'} or fields, but no roster matchups (A vs B) found.
            </p>`;
            return;
        }

        groupNames.forEach(label => {
            const header = document.createElement('div');
            header.className = 'group-header';
            header.textContent = label;
            target.appendChild(header);
            gamesFound[label].forEach(m => {
                addMatchRow(target, m.teamA, m.teamB, '', '', saveButton, label);
            });
        });

        if (saveButton) saveButton.style.display = 'block';
    }

    // =============================================================
    // SAVE RESULTS
    // =============================================================
    function saveGameResults(league, gameId, container) {
        const rows = container.querySelectorAll('.match-row');
        const results = [];
        rows.forEach(row => {
            const tA = row.dataset.teamA;
            const tB = row.dataset.teamB;
            const tLabel = row.dataset.timeLabel || '';
            const sA = parseInt(row.querySelector('.score-a').value, 10) || 0;
            const sB = parseInt(row.querySelector('.score-b').value, 10) || 0;

            let winner = null;
            if (sA > sB) winner = tA;
            else if (sB > sA) winner = tB;
            else winner = 'tie';

            results.push({
                teamA: tA,
                teamB: tB,
                scoreA: sA,
                scoreB: sB,
                winner: winner,
                timeLabel: tLabel
            });
        });

        if (results.length === 0) return;

        if (gameId === 'new') {
            const firstLabel = results[0].timeLabel || `Match Set ${league.games.length + 1}`;
            league.games.push({
                id: Date.now(),
                date: window.currentScheduleDate || new Date().toLocaleDateString(),
                name: firstLabel,
                matches: results
            });
        } else {
            league.games[gameId].matches = results;
        }

        recalcStandings(league);
        saveData();
        alert('Results saved and standings updated!');
        renderDetailPane();
    }

    // =============================================================
    // RECALC STANDINGS
    // =============================================================
    function recalcStandings(league) {
        league.teams.forEach(t => {
            league.standings[t] = { w: 0, l: 0, t: 0 };
        });

        (league.games || []).forEach(g => {
            (g.matches || []).forEach(m => {
                if (m.winner === 'tie') {
                    if (league.standings[m.teamA]) league.standings[m.teamA].t++;
                    if (league.standings[m.teamB]) league.standings[m.teamB].t++;
                } else if (m.winner) {
                    if (league.standings[m.winner]) league.standings[m.winner].w++;
                    const loser = m.winner === m.teamA ? m.teamB : m.teamA;
                    if (league.standings[loser]) league.standings[loser].l++;
                }
            });
        });
    }

})();
