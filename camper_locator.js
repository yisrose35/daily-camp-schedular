// =================================================================
// camper_locator.js
//
// Features:
// - "Where are they?" Search Bar (Activity + Location + League Details)
// - Camper Database (View/Edit League Teams)
// - Integrated with Schedule & League Data
// =================================================================

(function() {
    'use strict';

    // =============================================================
    // STATE & STORAGE
    // =============================================================
    let camperRoster = {}; // { "Name": { division, bunk, team } }
    let listContainer = null;
    let resultContainer = null;

    // Persist Roster Updates (Teams)
    function saveRoster() {
        const app1 = window.loadGlobalSettings?.().app1 || {};
        app1.camperRoster = camperRoster;
        window.saveGlobalSettings?.("app1", app1);
    }

    function loadRoster() {
        const app1 = window.loadGlobalSettings?.().app1 || {};
        camperRoster = app1.camperRoster || {};
    }

    // =============================================================
    // HELPER: TIME & SLOTS
    // =============================================================
    function getCurrentSlotIndex() {
        const times = window.unifiedTimes || [];
        if (times.length === 0) return -1;

        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes();

        // Find the slot that contains the current time
        for (let i = 0; i < times.length; i++) {
            const t = times[i];
            const start = new Date(t.start);
            const sMin = start.getHours() * 60 + start.getMinutes();
            
            // Assume 30 min slots if end is missing, or use actual end
            let eMin = sMin + (window.app1?.increments || 30);
            if (t.end) {
                const end = new Date(t.end);
                eMin = end.getHours() * 60 + end.getMinutes();
            }

            if (nowMin >= sMin && nowMin < eMin) return i;
        }
        return 0; // Default to first slot if out of bounds (or morning)
    }

    function getTimeOptions() {
        const times = window.unifiedTimes || [];
        if (times.length === 0) return `<option value="0">No Times Generated</option>`;
        
        let html = `<option value="now">🕒 Right Now</option>`;
        times.forEach((t, idx) => {
            html += `<option value="${idx}">${t.label}</option>`;
        });
        return html;
    }

    // =============================================================
    // INITIALIZER
    // =============================================================
    window.initCamperLocator = function() {
        const container = document.getElementById("camper-locator");
        if (!container) return;

        // Always reload roster fresh from storage
        loadRoster();
        const camperCount = Object.keys(camperRoster).length;
        console.log("🔍 Camper Locator loaded", camperCount, "campers");

        container.innerHTML = `
            <div class="setup-grid">
                
                <section class="setup-card setup-card-wide" style="background: linear-gradient(135deg, #fff 0%, #f0f9ff 100%); border-color: #bae6fd;">
                    <div class="setup-card-header">
                        <span class="setup-step-pill" style="background:#0284c7; color:white;">Locator</span>
                        <div class="setup-card-text">
                            <h3 style="color:#0c4a6e;">Where is a camper?</h3>
                            <p>Instantly locate any child based on their bunk's schedule.</p>
                        </div>
                    </div>

                    <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:end; margin-top:15px;">
                        <div style="flex:2; min-width:250px; position:relative;">
                            <label style="font-weight:600; font-size:0.9rem; color:#444;">Camper Name</label>
                            <input id="loc-search-input" placeholder="Start typing name (e.g. Moshe)..." 
                                   style="width:100%; padding:10px; font-size:1.1rem; border:2px solid #0284c7; border-radius:8px;">
                            <div id="loc-search-suggestions" style="display:none; position:absolute; background:white; border:1px solid #ccc; max-height:200px; overflow-y:auto; width:100%; z-index:1000; border-radius:0 0 8px 8px; box-shadow:0 4px 10px rgba(0,0,0,0.1);"></div>
                        </div>

                        <div style="flex:1; min-width:150px;">
                            <label style="font-weight:600; font-size:0.9rem; color:#444;">Time</label>
                            <select id="loc-time-select" style="width:100%; padding:10px; font-size:1rem; border:1px solid #ccc; border-radius:8px;">
                                ${getTimeOptions()}
                            </select>
                        </div>

                        <button id="loc-search-btn" style="padding:10px 24px; background:#0284c7; color:white; font-weight:bold; font-size:1rem; border:none; border-radius:8px; cursor:pointer;">
                            Find 🔍
                        </button>
                    </div>

                    <div id="loc-result-display" style="margin-top:20px; padding:20px; background:white; border-radius:12px; border:1px solid #e0f2fe; min-height:80px; display:none;">
                    </div>
                </section>

                <section class="setup-card setup-card-wide">
                    <div class="setup-card-header">
                        <span class="setup-step-pill">Database</span>
                        <div class="setup-card-text">
                            <h3>Camper Database & Teams</h3>
                            <p>Manage roster details and assign League Teams for accurate tracking.</p>
                        </div>
                    </div>

                    <div style="margin-bottom:15px; display:flex; gap:15px; align-items:center; flex-wrap:wrap;">
                        <input id="loc-filter-roster" placeholder="Filter by name, division, or bunk..." style="padding:8px 12px; width:280px; border:1px solid #ccc; border-radius:6px;">
                        <span id="loc-roster-count" style="color:#666; font-size:0.9rem;"></span>
                    </div>

                    <div style="max-height:600px; overflow-y:auto; border:1px solid #eee; border-radius:8px;">
                        <table class="report-table" style="margin:0;">
                            <thead style="position:sticky; top:0; z-index:10; background:white;">
                                <tr>
                                    <th style="cursor:pointer;" onclick="window._sortCamperRoster('name')">Camper Name ↕</th>
                                    <th style="cursor:pointer;" onclick="window._sortCamperRoster('division')">Division ↕</th>
                                    <th style="cursor:pointer;" onclick="window._sortCamperRoster('bunk')">Bunk ↕</th>
                                    <th>Assigned Team</th>
                                </tr>
                            </thead>
                            <tbody id="loc-roster-body"></tbody>
                        </table>
                    </div>
                </section>

            </div>
        `;

        // References
        const searchInput = document.getElementById("loc-search-input");
        const suggestionsBox = document.getElementById("loc-search-suggestions");
        const timeSelect = document.getElementById("loc-time-select");
        const searchBtn = document.getElementById("loc-search-btn");
        resultContainer = document.getElementById("loc-result-display");
        listContainer = document.getElementById("loc-roster-body");
        const rosterFilter = document.getElementById("loc-filter-roster");

        // --- Event Listeners ---

        // 1. Search Button
        searchBtn.onclick = () => performSearch(searchInput.value, timeSelect.value);
        searchInput.onkeyup = (e) => {
            if (e.key === "Enter") performSearch(searchInput.value, timeSelect.value);
            else showSuggestions(searchInput.value, suggestionsBox, searchInput);
        };

        // 2. Hide suggestions on click away
        document.addEventListener('click', (e) => {
            if (e.target !== searchInput) suggestionsBox.style.display = 'none';
        });

        // 3. Roster Filter (debounced)
        let filterTimeout = null;
        rosterFilter.onkeyup = () => {
            clearTimeout(filterTimeout);
            filterTimeout = setTimeout(() => renderRoster(rosterFilter.value), 150);
        };

        // Initial Render - show ALL campers
        renderRoster();
    };

    // =============================================================
    // SORTING STATE
    // =============================================================
    let sortField = 'name';
    let sortDirection = 'asc';
    
    window._sortCamperRoster = function(field) {
        if (sortField === field) {
            sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            sortField = field;
            sortDirection = 'asc';
        }
        const filter = document.getElementById("loc-filter-roster")?.value || "";
        renderRoster(filter);
    };

    // =============================================================
    // SEARCH LOGIC
    // =============================================================
    function showSuggestions(query, box, input) {
        if (!query || query.length < 2) {
            box.style.display = 'none';
            return;
        }
        const matches = Object.keys(camperRoster).filter(n => n.toLowerCase().includes(query.toLowerCase()));
        
        if (matches.length === 0) {
            box.style.display = 'none';
            return;
        }

        box.innerHTML = matches.slice(0, 15).map(name => 
            `<div class="suggestion-item" style="padding:10px 12px; cursor:pointer; border-bottom:1px solid #eee;">${name} <span style="color:#888; font-size:0.85rem;">(${camperRoster[name].bunk})</span></div>`
        ).join("");
        
        box.style.display = 'block';

        // Add click handlers
        box.querySelectorAll('.suggestion-item').forEach(div => {
            div.onclick = () => {
                const name = div.textContent.split(' (')[0].trim();
                input.value = name;
                box.style.display = 'none';
                document.getElementById("loc-search-btn").click();
            };
            div.onmouseover = () => div.style.backgroundColor = "#f0f9ff";
            div.onmouseout = () => div.style.backgroundColor = "white";
        });
    }

    function performSearch(nameQuery, timeValue) {
        if (!nameQuery) return;
        
        // Fix #1: Reload roster to catch any updates from other tabs
        loadRoster();
        
        // Find exact match or best guess
        const keys = Object.keys(camperRoster);
        const exact = keys.find(k => k.toLowerCase() === nameQuery.toLowerCase());
        const partial = keys.find(k => k.toLowerCase().includes(nameQuery.toLowerCase()));
        
        const camperName = exact || partial;

        if (!camperName) {
            resultContainer.style.display = 'block';
            resultContainer.innerHTML = `<h3 style="color:red; margin:0;">🚫 Camper "${nameQuery}" not found.</h3><p>Please check the roster database below or import campers via Setup tab.</p>`;
            return;
        }

        const camper = camperRoster[camperName];
        
        // Determine Slot
        let slotIdx = 0;
        let timeLabel = "";
        
        if (timeValue === "now") {
            slotIdx = getCurrentSlotIndex();
            timeLabel = "Right Now";
        } else {
            slotIdx = parseInt(timeValue);
            timeLabel = window.unifiedTimes[slotIdx]?.label || "Selected Time";
        }

        // Get Schedule
        const assignment = window.scheduleAssignments?.[camper.bunk]?.[slotIdx];
        
        // --- RENDER RESULT ---
        resultContainer.style.display = 'block';
        
        let locationHtml = "";
        let detailsHtml = "";
        let icon = "📍";

        if (!assignment) {
            locationHtml = `<span style="color:#999;">Unknown / Free Time</span>`;
            detailsHtml = "No schedule data found for this time.";
        } else {
            // Is it a League Game?
            const isLeague = assignment._h2h || (assignment.field && String(assignment.field).toLowerCase().includes("league"));
            
            if (isLeague) {
                icon = "🏆";
                const team = camper.team;
                
                if (!team) {
                    locationHtml = `<span style="color:#d97706;">Playing Leagues (Team Unknown)</span>`;
                    detailsHtml = `We know ${camper.bunk} is playing leagues, but <strong>${camperName}</strong> has no team assigned.<br>
                                   <a href="#" onclick="document.getElementById('loc-filter-roster').value='${camperName}'; document.getElementById('loc-filter-roster').focus(); document.getElementById('loc-filter-roster').dispatchEvent(new Event('keyup')); return false;">Assign a team below</a> to see exact field.`;
                } else {
                    // Fix #2: Added null check for camper.division
                    const leagueData = camper.division 
                        ? window.leagueAssignments?.[camper.division]?.[slotIdx]
                        : null;
                        
                    let match = null;
                    
                    if (leagueData && leagueData.matchups) {
                        match = leagueData.matchups.find(m => m.teamA === team || m.teamB === team);
                    }

                    if (match) {
                        locationHtml = `<span style="color:#059669; font-weight:bold; font-size:1.4rem;">${match.field}</span>`;
                        detailsHtml = `Playing <strong>${leagueData.sport || "League"}</strong><br>
                                       Matchup: <strong>${match.teamA}</strong> vs <strong>${match.teamB}</strong>`;
                    } else {
                        locationHtml = `<span>League (Bye or Break)</span>`;
                        detailsHtml = `Team <strong>${team}</strong> does not have a match scheduled at this time.`;
                    }
                }
            } else {
                // Standard Activity
                const activityName = assignment.sport || assignment._activity || "Activity";
                const fieldName = (typeof assignment.field === 'object') ? assignment.field.name : assignment.field;
                
                locationHtml = `<span style="color:#0284c7; font-weight:bold; font-size:1.4rem;">${fieldName}</span>`;
                detailsHtml = `Activity: <strong>${activityName}</strong>`;
            }
        }

        resultContainer.innerHTML = `
            <div style="display:flex; align-items:center; gap:20px; flex-wrap:wrap;">
                <div style="font-size:3rem;">${icon}</div>
                <div>
                    <h2 style="margin:0; color:#333;">${camperName}</h2>
                    <p style="margin:0; color:#666;">${camper.division} &bull; ${camper.bunk}</p>
                </div>
                <div style="margin-left:auto; text-align:right;">
                    <div style="font-size:0.9rem; color:#888; text-transform:uppercase; letter-spacing:1px; font-weight:bold;">${timeLabel}</div>
                    ${locationHtml}
                </div>
            </div>
            <div style="margin-top:15px; padding-top:15px; border-top:1px solid #eee; color:#555;">
                ${detailsHtml}
            </div>
        `;
    }

    // =============================================================
    // ROSTER TABLE RENDERER - NOW SHOWS ALL CAMPERS
    // =============================================================
    function renderRoster(filter = "") {
        listContainer.innerHTML = "";
        
        const campers = Object.keys(camperRoster);
        const teams = getAllTeams();
        const countEl = document.getElementById("loc-roster-count");
        
        // Filter campers
        let filtered = campers;
        if (filter) {
            const lowerFilter = filter.toLowerCase();
            filtered = campers.filter(name => {
                const data = camperRoster[name];
                return name.toLowerCase().includes(lowerFilter) ||
                       (data.division || "").toLowerCase().includes(lowerFilter) ||
                       (data.bunk || "").toLowerCase().includes(lowerFilter);
            });
        }
        
        // Sort campers
        filtered.sort((a, b) => {
            let valA, valB;
            if (sortField === 'name') {
                valA = a.toLowerCase();
                valB = b.toLowerCase();
            } else if (sortField === 'division') {
                valA = (camperRoster[a].division || "").toLowerCase();
                valB = (camperRoster[b].division || "").toLowerCase();
            } else if (sortField === 'bunk') {
                valA = (camperRoster[a].bunk || "").toLowerCase();
                valB = (camperRoster[b].bunk || "").toLowerCase();
            }
            
            if (sortDirection === 'asc') {
                return valA.localeCompare(valB, undefined, { numeric: true });
            } else {
                return valB.localeCompare(valA, undefined, { numeric: true });
            }
        });

        // Update count display
        if (countEl) {
            if (filter) {
                countEl.textContent = `Showing ${filtered.length} of ${campers.length} campers`;
            } else {
                countEl.textContent = `${campers.length} campers total`;
            }
        }

        // Show message if no campers
        if (campers.length === 0) {
            listContainer.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:30px; color:#666;">
                <strong>No campers in database.</strong><br><br>
                Import campers via CSV in the <strong>Setup tab</strong>.<br>
                Use format: Division, Bunk Name, Camper Name
            </td></tr>`;
            return;
        }

        if (filtered.length === 0) {
            listContainer.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:20px; color:#666;">No campers match "${filter}"</td></tr>`;
            return;
        }

        // Build team options once
        let teamOptions = `<option value="">-- Assign Team --</option>`;
        teams.forEach(t => {
            teamOptions += `<option value="${t}">${t}</option>`;
        });

        // Render ALL filtered campers (no limit!)
        const fragment = document.createDocumentFragment();
        
        filtered.forEach(name => {
            const data = camperRoster[name];
            const row = document.createElement("tr");

            // Build options with current selection
            let currentOptions = teamOptions.replace(
                `value="${data.team}"`,
                `value="${data.team}" selected`
            );

            row.innerHTML = `
                <td style="font-weight:600;">${name}</td>
                <td>${data.division || "-"}</td>
                <td>${data.bunk || "-"}</td>
                <td>
                    <select class="team-selector" data-name="${name}" style="padding:4px 8px; border-radius:4px; border:1px solid #ccc; width:100%; max-width:200px;">
                        ${currentOptions}
                    </select>
                </td>
            `;

            fragment.appendChild(row);
        });
        
        listContainer.appendChild(fragment);

        // Add Listeners for team selectors
        listContainer.querySelectorAll(".team-selector").forEach(sel => {
            sel.onchange = (e) => {
                const camperName = e.target.dataset.name;
                const newTeam = e.target.value;
                camperRoster[camperName].team = newTeam;
                saveRoster();
            };
        });
    }

    // Get all teams from the League System to populate dropdowns
    function getAllTeams() {
        const teams = new Set();
        // 1. Regular Leagues
        const leagues = window.masterLeagues || {};
        Object.values(leagues).forEach(l => {
            if (l.teams) l.teams.forEach(t => teams.add(t));
        });
        // 2. Specialty Leagues
        const special = window.masterSpecialtyLeagues || {};
        Object.values(special).forEach(l => {
            if (l.teams) l.teams.forEach(t => teams.add(t));
        });
        return Array.from(teams).sort();
    }

})();
