// =================================================================
// leagues.js — THEMED VERSION (FIXED: CONSTANT REFERENCE + SYNTAX)
// =================================================================
(function () {
    'use strict';
    console.log("🏆 leagues.js loaded");
    
    // -------------------------------------------------------------
    // GLOBAL LEAGUE STORAGE
    // -------------------------------------------------------------
    // GCM FIX: Use const so the reference never changes
    const leaguesByName = {}; 
    
    // Bind to window immediately
    window.leaguesByName = leaguesByName;
    window.masterLeagues = leaguesByName; 
    let leagueRoundState = {};
    window.leagueRoundState = leagueRoundState;
    
    // -------------------------------------------------------------
    // UI STATE
    // -------------------------------------------------------------
    let selectedLeagueName = null;
    let listEl = null;
    let detailPaneEl = null;
    
    function getPlaceSuffix(n) {
        const s = ['th', 'st', 'nd', 'rd'];
        const v = n % 100;
        return s[(v - 20) % 10] || s[v] || s[0];
    }
    
    // -------------------------------------------------------------
    // LOAD + SAVE
    // -------------------------------------------------------------
    function loadRoundState() {
        try {
            const global = window.loadGlobalSettings?.() || {};
            leagueRoundState = global.leagueRoundState || {};
            window.leagueRoundState = leagueRoundState;
        } catch (e) {
            console.error("Failed to load league round state:", e);
            leagueRoundState = {};
            window.leagueRoundState = leagueRoundState;
        }
    }
    
    function saveLeaguesData() {
        window.saveGlobalSettings?.('leaguesByName', leaguesByName);
        // Fix #1: Force sync to cloud to ensure persistence
        window.forceSyncToCloud?.();
    }
    
    function loadLeaguesData() {
        const global = window.loadGlobalSettings?.() || {};
        const loadedData = global.leaguesByName || {};
        
        // GCM FIX: Don't replace the object. Clear and refill it.
        // 1. Remove old keys
        Object.keys(leaguesByName).forEach(function(k) { delete leaguesByName[k]; });
        
        // 2. Add new keys
        Object.assign(leaguesByName, loadedData);
        
        // 3. Ensure defaults
        Object.keys(leaguesByName).forEach(function(leagueName) {
            var l = leaguesByName[leagueName];
            
            // FIX: Add name property
            if (!l.name) l.name = leagueName;
            
            l.divisions = l.divisions || [];
            l.sports = l.sports || [];
            l.teams = l.teams || [];
            l.enabled = l.enabled !== false;
            l.standings = l.standings || {};
            l.games = l.games || [];
            // Scheduling priority: 'sport_variety' (default) or 'matchup_variety'
            l.schedulingPriority = l.schedulingPriority || 'sport_variety';
            (l.teams || []).forEach(function(team) {
                l.standings[team] = l.standings[team] || { w: 0, l: 0, t: 0 };
            });
        });
        
        console.log("Leagues Loaded via Mutation:", Object.keys(leaguesByName));
    }
    
    // -------------------------------------------------------------
    // INLINE EDIT HELPER
    // -------------------------------------------------------------
    function makeEditable(el, saveCallback) {
        el.ondblclick = function(e) {
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
            var finish = function() {
                const newVal = input.value.trim();
                if (newVal && newVal !== oldText) saveCallback(newVal);
                el.textContent = newVal || oldText;
                input.replaceWith(el);
            };
            input.onblur = finish;
            input.onkeyup = function(ev) {
                if (ev.key === 'Enter') finish();
            };
        };
    }
    
    // -------------------------------------------------------------
    // TIME HELPERS
    // -------------------------------------------------------------
    function parseTimeToMinutes(str) {
        if (!str || typeof str !== "string") return null;
        var s = str.trim().toLowerCase();
        var mer = null;
        if (s.endsWith("am") || s.endsWith("pm")) {
            mer = s.endsWith("am") ? "am" : "pm";
            s = s.replace(/am|pm/g, "").trim();
        }
        var m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
        if (!m) return null;
        var hh = parseInt(m[1], 10);
        var mm = parseInt(m[2], 10);
        if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
        if (mer) {
            if (hh === 12) hh = mer === "am" ? 0 : 12;
            else if (mer === "pm") hh += 12;
        }
        return hh * 60 + mm;
    }
    
    function minutesToTimeLabel(min) {
        var h24 = Math.floor(min / 60);
        var m = String(min % 60).padStart(2, "0");
        var ap = h24 >= 12 ? "PM" : "AM";
        var h12 = h24 % 12 || 12;
        return h12 + ":" + m + " " + ap;
    }
    
    function findSlotIndexForTime(targetMin) {
        var times = window.unifiedTimes || [];
        var INCREMENT_MINS = window.INCREMENT_MINS || 30;
        for (var i = 0; i < times.length; i++) {
            var d = new Date(times[i].start);
            var slotStart = d.getHours() * 60 + d.getMinutes();
            var slotEnd;
            if (times[i].end) {
                var e = new Date(times[i].end);
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
    
    // =================================================================
    // INIT — MOUNT ON #leagues
    // =================================================================
    window.initLeagues = function () {
        var container = document.getElementById('leagues');
        if (!container) return;
        
        loadLeaguesData();
        loadRoundState();
        
        container.innerHTML = 
            '<div class="setup-grid">' +
                '<section class="setup-card setup-card-wide">' +
                    '<div class="setup-card-header">' +
                        '<span class="setup-step-pill">Leagues</span>' +
                        '<div class="setup-card-text">' +
                            '<h3>Manage Leagues, Teams & Standings</h3>' +
                            '<p>Configure divisions, add teams, and enter results to track standings.</p>' +
                        '</div>' +
                    '</div>' +
                    '<div style="display:flex; flex-wrap:wrap; gap:20px; margin-top:10px;">' +
                        '<div style="flex:1; min-width:260px;">' +
                            '<div class="setup-subtitle">All Leagues</div>' +
                            '<p style="font-size:0.8rem; color:#6b7280; margin-top:4px;">' +
                                'Select a league to edit. Double-click the title in the details pane to rename.' +
                            '</p>' +
                            '<div class="setup-field-row" style="margin-top:10px;">' +
                                '<input id="new-league-input" placeholder="New League Name (e.g. Senior Basketball)">' +
                                '<button id="add-league-btn" style="background: #00C896; color: white; border-color: #00C896; font-weight:600;">Add League</button>' +
                            '</div>' +
                            '<div id="league-master-list" class="master-list" style="margin-top:10px; max-height:440px; overflow:auto;"></div>' +
                        '</div>' +
                        '<div style="flex:1.4; min-width:320px;">' +
                            '<div class="setup-subtitle">League Details</div>' +
                            '<div id="league-detail-pane" class="detail-pane" style="margin-top:8px; min-height:380px;">' +
                                '<p class="muted">Select a league from the left to configure divisions, teams, and view standings.</p>' +
                            '</div>' +
                        '</div>' +
                    '</div>' +
                '</section>' +
            '</div>' +
            '<style>' +
                '.master-list { border-radius: 18px; border: 1px solid #E5E7EB; background: #F7F9FA; padding: 8px 6px; box-shadow: 0 10px 24px rgba(15,23,42,0.04); }' +
                '.master-list .list-item { padding: 10px 10px; border-radius: 14px; margin-bottom: 6px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; background: #FFFFFF; border: 1px solid #E5E7EB; box-shadow: 0 4px 10px rgba(15,23,42,0.05); transition: background 0.15s, box-shadow 0.15s, transform 0.08s; }' +
                '.master-list .list-item:hover { background: #F3F4F6; box-shadow: 0 8px 18px rgba(15, 23, 42, 0.10); transform: translateY(-1px); }' +
                '.master-list .list-item.selected { background: radial-gradient(circle at top left, #ECFDF5 0, #FFFFFF 70%); border-color: #00C896; box-shadow: 0 0 0 1px rgba(0, 200, 150, 0.55); font-weight: 600; }' +
                '.master-list .list-item-name { font-size: 0.88rem; font-weight: 500; color: #111827; }' +
                '.detail-pane { border-radius: 18px; border: 1px solid #E5E7EB; padding: 18px 20px; background: linear-gradient(135deg, #F7F9FA 0%, #FFFFFF 55%, #F7F9FA 100%); box-shadow: 0 18px 40px rgba(15,23,42,0.06); }' +
                '.league-section-card { border-radius: 16px; border: 1px solid #E5E7EB; background: #FFFFFF; padding: 12px 14px; box-shadow: 0 10px 22px rgba(15, 23, 42, 0.05); margin-bottom: 12px; }' +
                '.league-section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; color: #6B7280; }' +
                '.league-section-title { font-weight: 600; }' +
                '.chips { display: flex; flex-wrap: wrap; gap: 6px; }' +
                '.chip { padding: 4px 10px; border-radius: 999px; border: 1px solid #d1d5db; cursor: pointer; font-size: 0.8rem; background: #f8fafc; transition: all 0.15s ease; }' +
                '.chip.active { background: #00C896; border-color: #00C896; color: #fff; box-shadow: 0 3px 8px rgba(0, 200, 150, 0.35); }' +
                '.group-header { background: #ECFDF5; padding: 8px 12px; font-weight: 700; font-size: 0.85rem; color: #064E3B; border-radius: 8px; margin-top: 15px; margin-bottom: 8px; border-left: 4px solid #00C896; }' +
                '.match-row { transition: background 0.15s ease, transform 0.12s ease; }' +
                '.match-row:hover { background: #F3F4F6 !important; transform: translateX(2px); }' +
                '.muted { color: #6B7280; font-size: 0.86rem; }' +
                '.priority-toggle { display: flex; gap: 0; border-radius: 8px; overflow: hidden; border: 1px solid #D1D5DB; }' +
                '.priority-toggle-btn { padding: 8px 12px; font-size: 0.8rem; border: none; background: #F9FAFB; color: #6B7280; cursor: pointer; transition: all 0.15s ease; flex: 1; text-align: center; }' +
                '.priority-toggle-btn:first-child { border-right: 1px solid #D1D5DB; }' +
                '.priority-toggle-btn.active { background: #00C896; color: white; font-weight: 600; }' +
                '.priority-toggle-btn:hover:not(.active) { background: #F3F4F6; }' +
            '</style>';
        
        listEl = document.getElementById('league-master-list');
        detailPaneEl = document.getElementById('league-detail-pane');
        var addInput = document.getElementById('new-league-input');
        var addBtn = document.getElementById('add-league-btn');
        
        var addLeague = function() {
            var name = addInput.value.trim();
            if (!name) return;
            if (leaguesByName[name]) {
                alert('League exists!');
                return;
            }
            leaguesByName[name] = {
                name: name,
                teams: [],
                sports: [],
                divisions: [],
                standings: {},
                games: [],
                enabled: true,
                schedulingPriority: 'sport_variety'
            };
            saveLeaguesData();
            addInput.value = '';
            selectedLeagueName = name;
            renderMasterList();
            renderDetailPane();
        };
        
        addBtn.onclick = addLeague;
        addInput.onkeyup = function(e) { if (e.key === 'Enter') addLeague(); };
        
        renderMasterList();
        if (selectedLeagueName && leaguesByName[selectedLeagueName]) {
            renderDetailPane();
        }
        
        console.log("🏆 leagues.js initialized");
    };
    
    // =================================================================
    // MASTER LIST RENDER
    // =================================================================
    function renderMasterList() {
        listEl.innerHTML = '';
        var keys = Object.keys(leaguesByName).sort();
        if (keys.length === 0) {
            listEl.innerHTML = '<p class="muted">No leagues yet.</p>';
            return;
        }
        keys.forEach(function(name) {
            var item = leaguesByName[name];
            var el = document.createElement('div');
            el.className = 'list-item';
            if (name === selectedLeagueName) el.classList.add('selected');
            el.onclick = function() {
                selectedLeagueName = name;
                renderMasterList();
                renderDetailPane();
            };
            el.innerHTML = '<span class="list-item-name">' + name + '</span>';
            
            var tog = document.createElement('label');
            tog.className = 'switch';
            tog.onclick = function(e) { e.stopPropagation(); };
            
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = item.enabled;
            cb.onchange = function() {
                item.enabled = cb.checked;
                saveLeaguesData();
            };
            
            var slider = document.createElement('span');
            slider.className = 'slider';
            tog.append(cb, slider);
            el.appendChild(tog);
            listEl.appendChild(el);
        });
    }
    
    // =================================================================
    // DETAIL PANE
    // =================================================================
    function renderDetailPane() {
        if (!selectedLeagueName || !leaguesByName[selectedLeagueName]) {
            detailPaneEl.innerHTML = '<p class="muted">Select a league.</p>';
            return;
        }
        var league = leaguesByName[selectedLeagueName];
        detailPaneEl.innerHTML = '';
        
        // --- HEADER ---
        var header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '15px',
            borderBottom: '2px solid #E5E7EB',
            paddingBottom: '10px'
        });
        
        var title = document.createElement('h3');
        title.style.margin = '0';
        title.style.fontSize = '1.1rem';
        title.textContent = selectedLeagueName;
        title.title = "Double-click to rename";
        
        makeEditable(title, function(newName) {
            if (newName && !leaguesByName[newName]) {
                leaguesByName[newName] = league;
                delete leaguesByName[selectedLeagueName];
                selectedLeagueName = newName;
                saveLeaguesData();
                renderMasterList();
                renderDetailPane();
            }
        });
        
        var btnGroup = document.createElement('div');
        btnGroup.style.display = 'flex';
        btnGroup.style.gap = '8px';
        
        // NEUTRAL BUTTON
        var editConfigBtn = document.createElement('button');
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
        
        // DELETE BUTTON
        var delBtn = document.createElement('button');
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
        delBtn.onmouseenter = function() { delBtn.style.background = '#FEE2E2'; };
        delBtn.onmouseleave = function() { delBtn.style.background = '#FFFFFF'; };
        delBtn.onclick = function() {
            if (confirm("Delete league \"" + selectedLeagueName + "\"?")) {
                delete leaguesByName[selectedLeagueName];
                selectedLeagueName = null;
                saveLeaguesData();
                renderMasterList();
                detailPaneEl.innerHTML = '<p class="muted">Select a league.</p>';
            }
        };
        
        btnGroup.append(editConfigBtn, delBtn);
        header.append(title, btnGroup);
        detailPaneEl.appendChild(header);
        
        // --- CONFIG CONTAINER (Hidden by default) ---
        var configContainer = document.createElement('div');
        Object.assign(configContainer.style, {
            display: 'none',
            marginBottom: '20px',
            animation: 'fadeIn 0.2s ease-in-out'
        });
        renderConfigSections(league, configContainer);
        detailPaneEl.appendChild(configContainer);
        
        editConfigBtn.onclick = function() {
            var hidden = configContainer.style.display === 'none';
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
        
        // --- MAIN CONTENT (Standings/Results) ---
        var mainContent = document.createElement('div');
        renderGameResultsUI(league, mainContent);
        detailPaneEl.appendChild(mainContent);
    }
    
    // =================================================================
    // CONFIG SECTIONS (Cards)
    // =================================================================
    function renderConfigSections(league, container) {
        container.innerHTML = '';
        
        // CARD 0: SCHEDULING PRIORITY
        var priorityCard = document.createElement('div');
        priorityCard.className = 'league-section-card';
        priorityCard.innerHTML = 
            '<div class="league-section-header">' +
                '<span class="league-section-title">Scheduling Priority</span>' +
                '<span>How to schedule games</span>' +
            '</div>';
        
        var priorityDesc = document.createElement('p');
        priorityDesc.style.fontSize = '0.8rem';
        priorityDesc.style.color = '#6B7280';
        priorityDesc.style.margin = '0 0 10px 0';
        priorityDesc.textContent = 'Choose what the scheduler prioritizes when assigning games:';
        priorityCard.appendChild(priorityDesc);
        
        var priorityToggle = document.createElement('div');
        priorityToggle.className = 'priority-toggle';
        
        var sportBtn = document.createElement('button');
        sportBtn.className = 'priority-toggle-btn' + (league.schedulingPriority === 'sport_variety' ? ' active' : '');
        sportBtn.innerHTML = '<strong>Sport Variety</strong><br><span style="font-size:0.7rem; opacity:0.85;">Play all sports before repeating</span>';
        sportBtn.onclick = function() {
            league.schedulingPriority = 'sport_variety';
            saveLeaguesData();
            renderConfigSections(league, container);
        };
        
        var matchupBtn = document.createElement('button');
        matchupBtn.className = 'priority-toggle-btn' + (league.schedulingPriority === 'matchup_variety' ? ' active' : '');
        matchupBtn.innerHTML = '<strong>Matchup Variety</strong><br><span style="font-size:0.7rem; opacity:0.85;">Play all teams before repeating</span>';
        matchupBtn.onclick = function() {
            league.schedulingPriority = 'matchup_variety';
            saveLeaguesData();
            renderConfigSections(league, container);
        };
        
        priorityToggle.append(sportBtn, matchupBtn);
        priorityCard.appendChild(priorityToggle);
        
        var priorityNote = document.createElement('p');
        priorityNote.style.fontSize = '0.75rem';
        priorityNote.style.color = '#9CA3AF';
        priorityNote.style.margin = '8px 0 0 0';
        priorityNote.style.fontStyle = 'italic';
        if (league.schedulingPriority === 'sport_variety') {
            priorityNote.textContent = 'Teams will rotate through all available sports. Team matchups may repeat if needed to ensure sport variety.';
        } else {
            priorityNote.textContent = 'Teams will play all opponents before rematches. Sports may repeat if needed to ensure matchup variety.';
        }
        priorityCard.appendChild(priorityNote);
        
        container.appendChild(priorityCard);
        
        // CARD 1: DIVISIONS
        var divCard = document.createElement('div');
        divCard.className = 'league-section-card';
        divCard.innerHTML = 
            '<div class="league-section-header">' +
                '<span class="league-section-title">Divisions</span>' +
                '<span>Who plays?</span>' +
            '</div>';
        
        var divChips = document.createElement('div');
        divChips.className = 'chips';
        (window.availableDivisions || []).forEach(function(divName) {
            var isActive = league.divisions.includes(divName);
            var chip = document.createElement('span');
            chip.className = 'chip' + (isActive ? ' active' : '');
            chip.textContent = divName;
            chip.onclick = function() {
                if (isActive) league.divisions = league.divisions.filter(function(d) { return d !== divName; });
                else league.divisions.push(divName);
                saveLeaguesData();
                renderConfigSections(league, container);
            };
            divChips.appendChild(chip);
        });
        divCard.appendChild(divChips);
        container.appendChild(divCard);
        
        // CARD 2: SPORTS
        var sportCard = document.createElement('div');
        sportCard.className = 'league-section-card';
        sportCard.innerHTML = 
            '<div class="league-section-header">' +
                '<span class="league-section-title">Sports</span>' +
                '<span>Activity Type</span>' +
            '</div>';
        
        var sportChips = document.createElement('div');
        sportChips.className = 'chips';
        (window.getAllGlobalSports?.() || []).forEach(function(act) {
            var isActive = league.sports.includes(act);
            var chip = document.createElement('span');
            chip.className = 'chip' + (isActive ? ' active' : '');
            chip.textContent = act;
            chip.onclick = function() {
                if (isActive) league.sports = league.sports.filter(function(s) { return s !== act; });
                else league.sports.push(act);
                saveLeaguesData();
                renderConfigSections(league, container);
            };
            sportChips.appendChild(chip);
        });
        sportCard.appendChild(sportChips);
        container.appendChild(sportCard);
        
        // CARD 3: TEAMS
        var teamCard = document.createElement('div');
        teamCard.className = 'league-section-card';
        teamCard.innerHTML = 
            '<div class="league-section-header">' +
                '<span class="league-section-title">Teams</span>' +
                '<span>Roster</span>' +
            '</div>';
        
        var teamList = document.createElement('div');
        teamList.className = 'chips';
        league.teams.forEach(function(team) {
            var chip = document.createElement('span');
            chip.className = 'chip active';
            chip.innerHTML = team + ' <span style="opacity:0.6; margin-left:4px;">&times;</span>';
            chip.onclick = function() {
                league.teams = league.teams.filter(function(t) { return t !== team; });
                delete league.standings[team];
                saveLeaguesData();
                renderConfigSections(league, container);
            };
            teamList.appendChild(chip);
        });
        teamCard.appendChild(teamList);
        
        var teamInput = document.createElement('input');
        teamInput.placeholder = 'Type team name & press Enter...';
        teamInput.style.marginTop = '10px';
        teamInput.style.width = '100%';
        teamInput.onkeyup = function(e) {
            if (e.key === 'Enter' && teamInput.value.trim()) {
                var t = teamInput.value.trim();
                if (!league.teams.includes(t)) {
                    league.teams.push(t);
                    league.standings[t] = { w: 0, l: 0, t: 0 };
                    saveLeaguesData();
                    renderConfigSections(league, container);
                    var newInput = container.querySelectorAll('input');
                    if(newInput.length) newInput[newInput.length - 1].focus();
                }
            }
        };
        teamCard.appendChild(teamInput);
        container.appendChild(teamCard);
    }
    
    // =================================================================
    // GAME RESULTS VIEW
    // =================================================================
    function renderGameResultsUI(league, container) {
        container.innerHTML = '';
        
        var tabNav = document.createElement('div');
        tabNav.style.marginBottom = '15px';
        tabNav.style.display = 'flex';
        tabNav.style.gap = '8px';
        tabNav.innerHTML = 
            '<button id="tab-standings" class="active">Current Standings</button>' +
            '<button id="tab-games">Game Results / History</button>';
        container.appendChild(tabNav);
        
        var standingsDiv = document.createElement('div');
        var gamesDiv = document.createElement('div');
        gamesDiv.style.display = 'none';
        container.appendChild(standingsDiv);
        container.appendChild(gamesDiv);
        
        var btnStd = tabNav.querySelector('#tab-standings');
        var btnGms = tabNav.querySelector('#tab-games');
        
        var setTab = function(activeBtn, inactiveBtn) {
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
        
        btnStd.onclick = function() {
            standingsDiv.style.display = 'block';
            gamesDiv.style.display = 'none';
            setTab(btnStd, btnGms);
            renderStandingsTable(league, standingsDiv);
        };
        
        btnGms.onclick = function() {
            standingsDiv.style.display = 'none';
            gamesDiv.style.display = 'block';
            setTab(btnGms, btnStd);
            renderGameEntryUI(league, gamesDiv);
        };
        
        renderStandingsTable(league, standingsDiv);
    }
    
    // =================================================================
    // STANDINGS TABLE
    // =================================================================
    function renderStandingsTable(league, container) {
        container.innerHTML = '';
        if (!league.teams || league.teams.length === 0) {
            container.innerHTML = '<p class="muted" style="text-align:center; padding:20px;">No teams in this league. Edit Setup to add teams.</p>';
            return;
        }
        
        recalcStandings(league);
        
        var sortedTeams = [...league.teams].sort(function(a, b) {
            var sA = league.standings[a] || { w: 0, l: 0, t: 0 };
            var sB = league.standings[b] || { w: 0, l: 0, t: 0 };
            if (sA.w !== sB.w) return sB.w - sA.w;
            if (sA.l !== sB.l) return sA.l - sB.l;
            if (sA.t !== sB.t) return sB.t - sA.t;
            return a.localeCompare(b);
        });
        
        var html = 
            '<table style="width:100%; border-collapse:separate; border-spacing:0; border:1px solid #E5E7EB; border-radius:12px; overflow:hidden;">' +
                '<thead style="background:#F9FAFB;">' +
                    '<tr>' +
                        '<th style="text-align:left; padding:12px 16px; border-bottom:1px solid #E5E7EB; color:#6B7280; font-size:0.75rem; text-transform:uppercase;">Place</th>' +
                        '<th style="text-align:left; padding:12px 16px; border-bottom:1px solid #E5E7EB; color:#6B7280; font-size:0.75rem; text-transform:uppercase;">Team</th>' +
                        '<th style="padding:12px; border-bottom:1px solid #E5E7EB; text-align:center; color:#6B7280; font-size:0.75rem; text-transform:uppercase;">W</th>' +
                        '<th style="padding:12px; border-bottom:1px solid #E5E7EB; text-align:center; color:#6B7280; font-size:0.75rem; text-transform:uppercase;">L</th>' +
                        '<th style="padding:12px; border-bottom:1px solid #E5E7EB; text-align:center; color:#6B7280; font-size:0.75rem; text-transform:uppercase;">T</th>' +
                    '</tr>' +
                '</thead>' +
                '<tbody style="background:white;">';
        
        sortedTeams.forEach(function(team, idx) {
            var stats = league.standings[team] || { w: 0, l: 0, t: 0 };
            var borderBottom = idx < sortedTeams.length - 1 ? '1px solid #F3F4F6' : 'none';
            html += 
                '<tr>' +
                    '<td style="padding:12px 16px; border-bottom:' + borderBottom + '; font-weight:600; color:#111827;">' + (idx + 1) + getPlaceSuffix(idx + 1) + '</td>' +
                    '<td style="padding:12px 16px; border-bottom:' + borderBottom + '; font-weight:500;">' + team + '</td>' +
                    '<td style="padding:12px; border-bottom:' + borderBottom + '; text-align:center; color:#059669; font-weight:600;">' + stats.w + '</td>' +
                    '<td style="padding:12px; border-bottom:' + borderBottom + '; text-align:center; color:#DC2626;">' + stats.l + '</td>' +
                    '<td style="padding:12px; border-bottom:' + borderBottom + '; text-align:center; color:#6B7280;">' + stats.t + '</td>' +
                '</tr>';
        });
        
        html += '</tbody></table>';
        container.innerHTML = html;
    }
    
    // =================================================================
    // GAME ENTRY + IMPORT
    // =================================================================
    function renderGameEntryUI(league, container) {
        container.innerHTML = '';
        
        var controls = document.createElement('div');
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
        
        var select = document.createElement('select');
        select.style.flex = "1";
        select.innerHTML = '<option value="new">-- Enter New Game Results --</option>';
        (league.games || []).forEach(function(g, idx) {
            var label = g.name || ('Game ' + (idx + 1));
            select.innerHTML += '<option value="' + idx + '">' + label + ' (' + g.date + ')</option>';
        });
        
        var importBtn = document.createElement('button');
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
        
        var matchContainer = document.createElement('div');
        matchContainer.style.maxHeight = '420px';
        matchContainer.style.overflowY = 'auto';
        matchContainer.style.padding = '4px';
        
        container.appendChild(controls);
        container.appendChild(matchContainer);
        
        var saveBtn = document.createElement('button');
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
        saveBtn.onclick = function() { saveGameResults(league, select.value, matchContainer); };
        container.appendChild(saveBtn);
        
        importBtn.onclick = function() { importGamesFromSchedule(league, matchContainer); };
        
        select.onchange = function() {
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
            var game = leagueObj.games[gameIdx];
            if (!game) return;
            
            var groupedMatches = {};
            game.matches.forEach(function(m) {
                var label = m.timeLabel || 'Matchups';
                if (!groupedMatches[label]) groupedMatches[label] = [];
                groupedMatches[label].push(m);
            });
            
            var labels = Object.keys(groupedMatches).sort(function(a, b) {
                return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
            });
            
            labels.forEach(function(label) {
                var header = document.createElement('div');
                header.className = 'group-header';
                header.textContent = label;
                target.appendChild(header);
                
                groupedMatches[label].forEach(function(m) {
                    addMatchRow(target, m.teamA, m.teamB, m.scoreA, m.scoreB, saveButton, label);
                });
            });
        }
    }
    
    function addMatchRow(target, teamA, teamB, scoreA, scoreB, saveButton, timeLabel) {
        scoreA = scoreA || '';
        scoreB = scoreB || '';
        timeLabel = timeLabel || '';
        
        var row = document.createElement('div');
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
        
        row.innerHTML = 
            '<strong style="flex:1; text-align:right; font-size:0.9rem;">' + teamA + '</strong>' +
            '<input type="number" class="score-a" value="' + scoreA + '" style="width:50px; text-align:center; padding:6px; font-weight:bold; border-color:#9CA3AF;">' +
            '<span style="color:#6B7280; font-size:0.8rem; font-weight:bold;">VS</span>' +
            '<input type="number" class="score-b" value="' + scoreB + '" style="width:50px; text-align:center; padding:6px; font-weight:bold; border-color:#9CA3AF;">' +
            '<strong style="flex:1; font-size:0.9rem;">' + teamB + '</strong>';
        
        row.dataset.teamA = teamA;
        row.dataset.teamB = teamB;
        if (timeLabel) row.dataset.timeLabel = timeLabel;
        target.appendChild(row);
        if (saveButton) saveButton.style.display = 'block';
    }
    
    // =================================================================
    // IMPORT FROM SCHEDULE
    // =================================================================
    function importGamesFromSchedule(league, target) {
        target.innerHTML = '';
        
        var daily = window.loadCurrentDailyData?.() || {};
        var skeleton = daily.manualSkeleton || [];
        var assignments = daily.scheduleAssignments || {};
        
        // Fix #2: Load fresh from settings instead of window cache
        var globalSettings = window.loadGlobalSettings?.() || {};
        var divisions = globalSettings.app1?.divisions || window.divisions || {};
        
        var saveButton = target.parentElement.querySelector('[data-role="save-game-results"]');
        
        if (!league.teams || league.teams.length === 0) {
            target.innerHTML = '<p class="muted" style="text-align:center; margin-top:20px;">Add teams to this league first.</p>';
            return;
        }
        
        var relevantBlocks = skeleton.filter(function(block) {
            return league.divisions.includes(block.division) &&
                   block.event.toLowerCase().includes("league game");
        });
        
        if (relevantBlocks.length === 0) {
            target.innerHTML = '<p class="muted" style="text-align:center; margin-top:20px;">No "League Game" blocks found for: ' + league.divisions.join(", ") + '.</p>';
            return;
        }
        
        var gamesFound = {};
        
        relevantBlocks.forEach(function(block) {
            var startMin = parseTimeToMinutes(block.startTime);
            var slotIdx = findSlotIndexForTime(startMin);
            if (slotIdx === -1) return;
            
            var divBunks = divisions[block.division]?.bunks || [];
            if (divBunks.length === 0) return;
            
            var representativeBunk = divBunks[0];
            var entry = assignments[representativeBunk]?.[slotIdx];
            if (!entry) return;
            
            var headerLabel = block.event;
            var rawText = (typeof entry.field === 'string') ? entry.field : (entry.sport || "");
            var textMatch = rawText.match(/(?:Game|Match)\s*(\d+)/i) || headerLabel.match(/(?:Game|Match)\s*(\d+)/i);
            var hiddenMatch = entry._gameLabel || entry.gameLabel;
            
            if (textMatch) {
                headerLabel = "League Game " + textMatch[1];
            } else if (hiddenMatch) {
                headerLabel = "League Game " + hiddenMatch.replace(/^\D+/g, '');
            } else {
                if (headerLabel.trim().toLowerCase() === "league game") {
                    headerLabel = headerLabel + " (" + minutesToTimeLabel(startMin) + ")";
                }
            }
            
            var linesToScan = [];
            if (entry._allMatchups && Array.isArray(entry._allMatchups) && entry._allMatchups.length > 0) {
                linesToScan = entry._allMatchups;
            } else if (typeof entry.field === 'string') {
                linesToScan = entry.field.split('\n');
            } else if (entry.sport) {
                linesToScan = [entry.sport];
            }
            
            linesToScan.forEach(function(line) {
                var m = line.match(/^(.*?)\s+vs\.?\s+(.*?)(?:\s*[@\(]|$)/i);
                if (m) {
                    var tA = m[1].trim();
                    var tB = m[2].trim();
                    if (league.teams.includes(tA) && league.teams.includes(tB)) {
                        if (!gamesFound[headerLabel]) gamesFound[headerLabel] = [];
                        
                        var exists = gamesFound[headerLabel].some(function(g) {
                            return (g.teamA === tA && g.teamB === tB) ||
                                   (g.teamA === tB && g.teamB === tA);
                        });
                        
                        if (!exists) {
                            gamesFound[headerLabel].push({ teamA: tA, teamB: tB });
                        }
                    }
                }
            });
        });
        
        var groupNames = Object.keys(gamesFound).sort(function(a, b) {
            return a.localeCompare(b, undefined, { numeric: true });
        });
        
        if (groupNames.length === 0) {
            target.innerHTML = '<p class="muted" style="text-align:center; padding:10px;">Found League blocks, but no valid matchups (Team A vs Team B) matching your roster.</p>';
            return;
        }
        
        groupNames.forEach(function(label) {
            var header = document.createElement('div');
            header.className = 'group-header';
            header.textContent = label;
            target.appendChild(header);
            
            gamesFound[label].forEach(function(m) {
                addMatchRow(target, m.teamA, m.teamB, '', '', saveButton, label);
            });
        });
        
        if (saveButton) saveButton.style.display = 'block';
    }
    
    // =================================================================
    // SAVE GAME RESULTS
    // =================================================================
    function saveGameResults(league, gameId, container) {
        var rows = container.querySelectorAll('.match-row');
        var results = [];
        
        rows.forEach(function(row) {
            var tA = row.dataset.teamA;
            var tB = row.dataset.teamB;
            var tLabel = row.dataset.timeLabel || '';
            var sA = parseInt(row.querySelector('.score-a').value, 10) || 0;
            var sB = parseInt(row.querySelector('.score-b').value, 10) || 0;
            
            var winner = null;
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
            var firstLabel = results[0].timeLabel || ('Game Set ' + (league.games.length + 1));
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
        saveLeaguesData();
        alert('Results saved and standings updated!');
        renderDetailPane();
    }
    
    // =================================================================
    // RECALC STANDINGS
    // =================================================================
    function recalcStandings(league) {
        league.teams.forEach(function(t) {
            league.standings[t] = { w: 0, l: 0, t: 0 };
        });
        
        (league.games || []).forEach(function(g) {
            (g.matches || []).forEach(function(m) {
                if (m.winner === 'tie') {
                    if (league.standings[m.teamA]) league.standings[m.teamA].t++;
                    if (league.standings[m.teamB]) league.standings[m.teamB].t++;
                } else if (m.winner) {
                    if (league.standings[m.winner]) league.standings[m.winner].w++;
                    var loser = m.winner === m.teamA ? m.teamB : m.teamA;
                    if (league.standings[loser]) league.standings[loser].l++;
                }
            });
        });
    }
    
    // =================================================================
    // FINAL LOAD — SAFE EXPORTS
    // =================================================================
    window.loadLeagueGlobals = function () {
        try {
            loadLeaguesData();
            loadRoundState();
        } catch (e) {
            console.error("League load error:", e);
        }
    };
    
    // Auto-load on script run
    window.loadLeagueGlobals();
    
    console.log("🏆 leagues.js: window.initLeagues ready");
})();
