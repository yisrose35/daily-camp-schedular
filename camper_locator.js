// =================================================================
// camper_locator.js — PATCHED: Real-Time Division-Aware Locator
//
// Features:
// - "Where are they?" Search Bar (Activity + Location + League Details)
// - Camper Database (View/Edit League Teams)
// - Integrated with Schedule & League Data
// - ★ REAL-TIME: Uses divisionTimes for accurate time-based lookups
// - ★ No more slot-index mismatches between divisions
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
        if (!window.AccessControl?.canEdit?.()) {
            console.warn('[CamperLocator] Save blocked - insufficient permissions');
            return;
        }
        const app1 = window.loadGlobalSettings?.().app1 || {};
        app1.camperRoster = camperRoster;
        window.saveGlobalSettings?.("app1", app1);
    }

    function loadRoster() {
        const app1 = window.loadGlobalSettings?.().app1 || {};
        camperRoster = app1.camperRoster || {};
    }

    // =============================================================
    // HELPER: TIME & SLOTS — ★★★ REAL-TIME DIVISION-AWARE ★★★
    // =============================================================

    /**
     * ★★★ NEW: Normalize a matchup entry — handles both string and object formats ★★★
     * Regular leagues store matchups as strings: "1 vs 4 @ Newcomb Cage (Newcomb)"
     * Specialty leagues store matchups as objects: { teamA, teamB, field, sport }
     */
    function normalizeMatchup(m) {
        if (typeof m === 'string') {
            const raw = m;
            let teamA = '', teamB = '', field = '', sport = '';
            const atParts = m.split(' @ ');
            const teamsPart = atParts[0] || '';
            const fieldPart = atParts[1] || '';
            const vsParts = teamsPart.split(/\s+vs\s+/i);
            teamA = (vsParts[0] || '').trim();
            teamB = (vsParts[1] || '').trim();
            const dashParts = teamB.split(/\s+[—–-]\s+/);
            if (dashParts.length > 1) { teamB = dashParts[0].trim(); sport = dashParts[1].trim(); }
            if (fieldPart) {
                const parenMatch = fieldPart.match(/^(.+?)\s*\((.+?)\)\s*$/);
                if (parenMatch) { field = parenMatch[1].trim(); sport = sport || parenMatch[2].trim(); }
                else { field = fieldPart.trim(); }
            }
            return { teamA, teamB, field, sport, raw };
        } else if (m && typeof m === 'object') {
            return { teamA: m.teamA || m.team1 || '', teamB: m.teamB || m.team2 || '', field: m.field || '', sport: m.sport || '', raw: m.display || `${m.teamA || m.team1 || '?'} vs ${m.teamB || m.team2 || '?'}` };
        }
        return { teamA: '', teamB: '', field: '', sport: '', raw: String(m) };
    }

    function findTeamMatchup(leagueData, team) {
        if (!leagueData?.matchups || !team) return null;
        const teamStr = String(team).toLowerCase().trim();
        for (const m of leagueData.matchups) {
            const norm = normalizeMatchup(m);
            const tA = norm.teamA.toLowerCase().trim();
            const tB = norm.teamB.toLowerCase().trim();
            if (tA === teamStr || tB === teamStr) return norm;
            if (tA.includes(teamStr) || tB.includes(teamStr) || teamStr.includes(tA) || teamStr.includes(tB)) return norm;
        }
        return null;
    }

    function buildAllMatchupsHtml(leagueData) {
        if (!leagueData?.matchups?.length) return '';
        return `<div style="margin-top:8px;">` + 
            leagueData.matchups.map(m => {
                const norm = normalizeMatchup(m);
                return `<div style="padding:3px 0;">${norm.teamA} vs ${norm.teamB} @ <strong>${norm.field}</strong>${norm.sport ? ' (' + norm.sport + ')' : ''}</div>`;
            }).join('') + `</div>`;
    }

    /**
     * ★★★ NEW: Get current time in minutes since midnight ★★★
     */
    function getCurrentTimeMinutes() {
        const now = new Date();
        return now.getHours() * 60 + now.getMinutes();
    }

    /**
     * ★★★ NEW: Find the correct division-specific slot index for a given time ★★★
     * Uses divisionTimes (per-division time structure) instead of unifiedTimes.
     * This is critical because different divisions have different slot structures.
     * 
     * @param {string} divisionName - The division to look up
     * @param {number} timeMinutes - Time in minutes since midnight
     * @returns {number} Division-specific slot index, or -1 if not found
     */
    function findDivisionSlotForTime(divisionName, timeMinutes) {
        const divSlots = window.divisionTimes?.[divisionName] || [];
        
        if (divSlots.length === 0) {
            // Fallback: try SchedulerCoreUtils
            if (window.SchedulerCoreUtils?.findSlotForTime) {
                return window.SchedulerCoreUtils.findSlotForTime(divisionName, timeMinutes);
            }
            return -1;
        }

        // Find the slot that CONTAINS the current time
        for (let i = 0; i < divSlots.length; i++) {
            const slot = divSlots[i];
            if (slot.startMin <= timeMinutes && timeMinutes < slot.endMin) {
                return i;
            }
        }

        // If before first slot, return first
        if (timeMinutes < divSlots[0].startMin) {
            return 0;
        }

        // If after last slot, return last
        if (timeMinutes >= divSlots[divSlots.length - 1].endMin) {
            return divSlots.length - 1;
        }

        return -1;
    }

    /**
     * ★★★ NEW: Get the time label for a division slot ★★★
     */
    function getDivisionSlotLabel(divisionName, slotIdx) {
        const divSlots = window.divisionTimes?.[divisionName] || [];
        const slot = divSlots[slotIdx];
        if (!slot) return "Unknown Time";
        
        return slot.label || `${minutesToTimeLabel(slot.startMin)} - ${minutesToTimeLabel(slot.endMin)}`;
    }

    /**
     * Helper: Convert minutes to time label (e.g. 570 -> "9:30 AM")
     */
    function minutesToTimeLabel(mins) {
        if (mins == null) return "??";
        let h = Math.floor(mins / 60);
        let m = mins % 60;
        const ap = h >= 12 ? "PM" : "AM";
        h = h % 12 || 12;
        return `${h}:${m.toString().padStart(2, '0')} ${ap}`;
    }

    /**
     * ★★★ KEPT for backward compat but no longer primary ★★★
     * Only used if divisionTimes is unavailable
     */
    function getCurrentSlotIndex() {
        const times = window.unifiedTimes || [];
        if (times.length === 0) return -1;

        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes();

        for (let i = 0; i < times.length; i++) {
            const t = times[i];
            const start = new Date(t.start);
            const sMin = start.getHours() * 60 + start.getMinutes();
            
            let eMin = sMin + (window.app1?.increments || 30);
            if (t.end) {
                const end = new Date(t.end);
                eMin = end.getHours() * 60 + end.getMinutes();
            }

            if (nowMin >= sMin && nowMin < eMin) return i;
        }
        return 0;
    }

    /**
     * ★★★ NEW: Parse a typed time string into minutes since midnight ★★★
     * Handles: "10:30 AM", "2:15 PM", "14:30", "9:00", "930", "230pm", etc.
     * Returns -1 if unparseable.
     */
    function parseTypedTime(str) {
        if (!str) return -1;
        str = str.trim().toUpperCase();
        
        // Detect AM/PM
        let isPM = false;
        let isAM = false;
        if (str.includes('PM') || str.includes('P.M')) { isPM = true; str = str.replace(/\s*(PM|P\.M\.?)/, ''); }
        if (str.includes('AM') || str.includes('A.M')) { isAM = true; str = str.replace(/\s*(AM|A\.M\.?)/, ''); }
        str = str.trim();
        
        let hours = 0, minutes = 0;
        
        if (str.includes(':')) {
            const parts = str.split(':');
            hours = parseInt(parts[0]);
            minutes = parseInt(parts[1]) || 0;
        } else {
            const num = parseInt(str);
            if (isNaN(num)) return -1;
            if (num <= 12) {
                hours = num;
                minutes = 0;
            } else if (num <= 2359) {
                hours = Math.floor(num / 100);
                minutes = num % 100;
            } else {
                return -1;
            }
        }
        
        if (isNaN(hours) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return -1;
        
        // Apply AM/PM
        if (isPM && hours < 12) hours += 12;
        if (isAM && hours === 12) hours = 0;
        
        // If no AM/PM specified and hour >= 1 and <= 6, assume PM (camp hours)
        if (!isPM && !isAM && hours >= 1 && hours <= 6) hours += 12;
        
        return hours * 60 + minutes;
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
                            <input id="loc-time-input" type="text" placeholder="e.g. 10:30 AM" 
                                   style="width:100%; padding:10px; font-size:1rem; border:1px solid #ccc; border-radius:8px;">
                        </div>

                        <button id="loc-now-btn" style="padding:10px 18px; background:#059669; color:white; font-weight:bold; font-size:1rem; border:none; border-radius:8px; cursor:pointer;">
                            🕒 Now
                        </button>

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
        const timeInput = document.getElementById("loc-time-input");
        const nowBtn = document.getElementById("loc-now-btn");
        const searchBtn = document.getElementById("loc-search-btn");
        resultContainer = document.getElementById("loc-result-display");
        listContainer = document.getElementById("loc-roster-body");
        const rosterFilter = document.getElementById("loc-filter-roster");

        // --- Event Listeners ---

        // 1. Search Button — uses typed time
        searchBtn.onclick = () => performSearch(searchInput.value, timeInput.value.trim() || "now");
        
        // 2. Now Button — always uses current time
        nowBtn.onclick = () => {
            timeInput.value = "";
            performSearch(searchInput.value, "now");
        };
        
        // 3. Enter key on either input
        searchInput.onkeyup = (e) => {
            if (e.key === "Enter") performSearch(searchInput.value, timeInput.value.trim() || "now");
            else showSuggestions(searchInput.value, suggestionsBox, searchInput);
        };
        timeInput.onkeyup = (e) => {
            if (e.key === "Enter") performSearch(searchInput.value, timeInput.value.trim() || "now");
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

    /**
     * ★★★ REWRITTEN: performSearch — Real-Time, Division-Aware ★★★
     * 
     * Instead of mapping to a unified slot index, we now:
     * 1. Determine the target time in MINUTES
     * 2. Use the camper's DIVISION to find the correct division-specific slot
     * 3. Look up the assignment by that division-specific slot index
     * 
     * This means a camper in Division 1 (with 30-min slots) and a camper in
     * Division 2 (with 45-min slots) both get the correct activity for the
     * requested time, even though their slot structures are completely different.
     */
    function performSearch(nameQuery, timeValue) {
        if (!nameQuery) return;
        
        // Reload roster to catch any updates from other tabs
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
        const bunk = camper.bunk;
        
        // ★★★ CRITICAL: Resolve the ACTUAL division key for divisionTimes ★★★
        // The roster stores the parent division name (e.g. "Juniors") but 
        // divisionTimes is keyed by grade-level division (e.g. "3rd Grade").
        // We need to find the actual key where this bunk exists.
        let division = null;
        
        // Method 1: Use SchedulerCoreUtils.getDivisionForBunk (most reliable)
        if (window.SchedulerCoreUtils?.getDivisionForBunk) {
            division = window.SchedulerCoreUtils.getDivisionForBunk(bunk);
        }
        
        // Method 2: Scan window.divisions directly
        if (!division || !window.divisionTimes?.[division]) {
            const divisions = window.divisions || {};
            for (const [divKey, divData] of Object.entries(divisions)) {
                if (divData.bunks && divData.bunks.some(b => String(b) === String(bunk))) {
                    division = divKey;
                    break;
                }
            }
        }
        
        // Method 3: Fall back to roster's stored division name
        if (!division) {
            division = camper.division;
        }
        
        console.log(`[CamperLocator] Resolved ${bunk} → division "${division}" (roster had "${camper.division}")`);
        
        // ★★★ STEP 1: Determine target time in minutes ★★★
        let targetTimeMin = 0;
        let timeLabel = "";
        
        if (timeValue === "now" || timeValue === "") {
            targetTimeMin = getCurrentTimeMinutes();
            timeLabel = `Right Now (${minutesToTimeLabel(targetTimeMin)})`;
        } else {
            // Parse typed time string (e.g. "10:30 AM", "2:15 PM", "14:30", "9:00")
            targetTimeMin = parseTypedTime(timeValue);
            if (targetTimeMin < 0) {
                resultContainer.style.display = 'block';
                resultContainer.innerHTML = `<h3 style="color:red; margin:0;">⚠️ Couldn't understand "${timeValue}"</h3><p>Try a format like <strong>10:30 AM</strong> or <strong>2:15 PM</strong>.</p>`;
                return;
            }
            timeLabel = minutesToTimeLabel(targetTimeMin);
        }

        // ★★★ STEP 2: Find assignment by REAL TIME — not slot index ★★★
        let slotIdx = -1;
        let slotTimeLabel = "";
        let assignment = null;
        
        const bunkAssignments = window.scheduleAssignments?.[bunk];
        const divSlots = window.divisionTimes?.[division] || [];
        
        if (bunkAssignments && divSlots.length > 0) {
            // PRIMARY: Scan divisionTimes for the slot whose time range contains targetTimeMin
            for (let i = 0; i < divSlots.length; i++) {
                const ds = divSlots[i];
                if (ds.startMin <= targetTimeMin && targetTimeMin < ds.endMin) {
                    slotIdx = i;
                    assignment = bunkAssignments[i] || null;
                    slotTimeLabel = getDivisionSlotLabel(division, i);
                    break;
                }
            }
            
            // SECONDARY: If no divisionTimes match, scan assignment metadata (_startMin/_endMin)
            if (slotIdx < 0) {
                for (let i = 0; i < bunkAssignments.length; i++) {
                    const a = bunkAssignments[i];
                    if (!a || a.continuation) continue;
                    const aStart = a._startMin ?? a._blockStart;
                    const aEnd = a._endMin;
                    if (aStart != null && aEnd != null && aStart <= targetTimeMin && targetTimeMin < aEnd) {
                        assignment = a;
                        slotIdx = i;
                        slotTimeLabel = `${minutesToTimeLabel(aStart)} - ${minutesToTimeLabel(aEnd)}`;
                        break;
                    }
                }
            }
            
            // TERTIARY: Handle multi-slot (continuation) blocks
            // If the found assignment is a continuation, walk backward to find the parent
            if (assignment && assignment.continuation && slotIdx >= 0) {
                for (let i = slotIdx - 1; i >= 0; i--) {
                    const a = bunkAssignments[i];
                    if (a && !a.continuation) {
                        assignment = a;
                        // Keep slotIdx as-is for league lookups (they key by first slot)
                        slotIdx = i;
                        break;
                    }
                }
            }
        }
        
        // FALLBACK: No divisionTimes available — use legacy unified approach
        if (slotIdx < 0 && bunkAssignments) {
            if (timeValue === "now" || timeValue === "") {
                slotIdx = getCurrentSlotIndex();
            }
            if (slotIdx >= 0) {
                assignment = bunkAssignments[slotIdx] || null;
            }
            console.warn(`[CamperLocator] No divisionTimes for "${division}", fell back to unified slot ${slotIdx}`);
        }
        
        console.log(`[CamperLocator] ${camperName} (${bunk}, ${division}) @ ${minutesToTimeLabel(targetTimeMin)} → slot ${slotIdx}, found:`, assignment?.field || assignment?._activity || 'none');
        
        // --- RENDER RESULT ---
        resultContainer.style.display = 'block';
        
        let locationHtml = "";
        let detailsHtml = "";

        // ★★★ NEW: Show the actual time slot this maps to ★★★
        const timeContext = slotTimeLabel ? 
            `<div style="font-size:0.8rem; color:#0284c7; margin-top:2px;">${slotTimeLabel}</div>` : '';

        if (!assignment) {
            // ★★★ First check: is the target time even within schedule hours? ★★★
            let isOutsideSchedule = false;
            if (divSlots.length > 0) {
                const scheduleStart = divSlots[0].startMin;
                const scheduleEnd = divSlots[divSlots.length - 1].endMin;
                if (targetTimeMin < scheduleStart || targetTimeMin >= scheduleEnd) {
                    isOutsideSchedule = true;
                }
            }
            
            if (isOutsideSchedule) {
                const scheduleStart = minutesToTimeLabel(divSlots[0].startMin);
                const scheduleEnd = minutesToTimeLabel(divSlots[divSlots.length - 1].endMin);
                locationHtml = `<span style="color:#999;">Outside Schedule Hours</span>`;
                detailsHtml = `${division}'s schedule runs from <strong>${scheduleStart}</strong> to <strong>${scheduleEnd}</strong>. The selected time is outside those hours.`;
            } else {
            // ★★★ BEFORE giving up, check if this is a LEAGUE slot ★★★
            // League blocks may not have individual bunk assignments in scheduleAssignments.
            // Check divisionTimes event type AND leagueAssignments directly.
            const divSlotInfo = divSlots[slotIdx];
            const slotEvent = (divSlotInfo?.event || '').toLowerCase();
            const slotType = (divSlotInfo?.type || '').toLowerCase();
            
            const isLeagueSlot = slotEvent.includes('league') || 
                                 slotEvent.includes('h2h') ||
                                 slotType === 'league' || 
                                 slotType === 'h2h' ||
                                 slotType === 'specialty_league';
            
            // Also check leagueAssignments directly for this division + slot
            // Scan ALL league entries and find the one whose time range contains targetTimeMin
            let leagueData = null;
            const la = window.leagueAssignments?.[division] || {};
            
            // First: exact slot index match
            if (la[slotIdx]) {
                leagueData = la[slotIdx];
            }
            
            // Second: scan all league entries, match by TIME not by slot index
            if (!leagueData) {
                for (const key of Object.keys(la)) {
                    const keyNum = parseInt(key);
                    if (isNaN(keyNum)) continue;
                    
                    const keySlot = divSlots[keyNum];
                    if (!keySlot) continue;
                    
                    // Check if the league block's divSlot time range contains our target
                    if (keySlot.startMin <= targetTimeMin && targetTimeMin < keySlot.endMin) {
                        leagueData = la[key];
                        break;
                    }
                    
                    // For multi-slot league blocks: check if the block SPANS our target time
                    // Walk forward from keyNum to find the end of the contiguous league block
                    let blockEndMin = keySlot.endMin;
                    for (let j = keyNum + 1; j < divSlots.length; j++) {
                        const nextEntry = bunkAssignments?.[j];
                        if (nextEntry && (nextEntry.continuation || nextEntry._h2h || 
                            String(nextEntry.field || '').toLowerCase().includes('league'))) {
                            blockEndMin = divSlots[j]?.endMin || blockEndMin;
                        } else {
                            break;
                        }
                    }
                    
                    if (keySlot.startMin <= targetTimeMin && targetTimeMin < blockEndMin) {
                        leagueData = la[key];
                        break;
                    }
                }
            }
            
            // Also scan bunkAssignments for ANY slot in this time range that has _h2h
            let foundLeagueAssignment = null;
            if (!leagueData && bunkAssignments) {
                for (let i = 0; i < divSlots.length; i++) {
                    const ds = divSlots[i];
                    if (ds.startMin <= targetTimeMin && targetTimeMin < ds.endMin) {
                        const a = bunkAssignments[i];
                        if (a && (a._h2h || String(a.field || '').toLowerCase().includes('league'))) {
                            foundLeagueAssignment = a;
                            slotIdx = i;
                            break;
                        }
                    }
                }
            }
            
            if (isLeagueSlot || leagueData || foundLeagueAssignment) {
                // This IS a league slot
                const team = camper.team;
                
                if (!team) {
                    locationHtml = `<span style="color:#d97706; font-weight:bold; font-size:1.4rem;">Leagues</span>`;
                    detailsHtml = `<strong>${bunk}</strong> is playing leagues at this time.<br>
                                   <strong>${camperName}</strong> has no team assigned yet — <a href="#" onclick="document.getElementById('loc-filter-roster').value='${camperName}'; document.getElementById('loc-filter-roster').focus(); document.getElementById('loc-filter-roster').dispatchEvent(new Event('keyup')); return false;">assign a team below</a> to see their exact field and matchup.`;
                    if (leagueData?.gameLabel) {
                        detailsHtml = `<strong>${leagueData.gameLabel}</strong> — ${bunk} is playing leagues at this time.<br>
                                       <strong>${camperName}</strong> has no team assigned yet — <a href="#" onclick="document.getElementById('loc-filter-roster').value='${camperName}'; document.getElementById('loc-filter-roster').focus(); document.getElementById('loc-filter-roster').dispatchEvent(new Event('keyup')); return false;">assign a team below</a> to see their exact field and matchup.`;
                    }
                } else {
                    // Has a team — find their matchup using normalized lookup
                    console.log(`[CamperLocator] League lookup — team: "${team}", leagueData:`, leagueData);
                    const match = findTeamMatchup(leagueData, team);
                    
                    if (match) {
                        locationHtml = `<span style="color:#059669; font-weight:bold; font-size:1.4rem;">${match.field} - ${match.sport || leagueData?.sport || 'League'}</span>`;
                        detailsHtml = `Team ${team}`;
                    } else {
                        // No team match — show ALL matchups
                        locationHtml = `<span style="color:#d97706; font-weight:bold; font-size:1.4rem;">Leagues</span>`;
                        detailsHtml = `<strong>${leagueData?.gameLabel || 'League Game'}</strong> — Team <strong>${team}</strong> not found in matchups.${buildAllMatchupsHtml(leagueData)}`;
                    }
                }
            } else if (divSlots.length === 0) {
                locationHtml = `<span style="color:#999;">No Schedule Generated</span>`;
                detailsHtml = "No schedule has been generated yet for this division. Generate a schedule first.";
            } else if (slotIdx < 0) {
                locationHtml = `<span style="color:#999;">Outside Schedule Hours</span>`;
                detailsHtml = `The selected time (${minutesToTimeLabel(targetTimeMin)}) is outside ${division}'s scheduled hours.`;
            } else {
                locationHtml = `<span style="color:#999;">No Activity Assigned</span>`;
                detailsHtml = `${bunk} does not have an activity assigned at this time slot. This may be a gap in the schedule.`;
            }
            } // end of isOutsideSchedule else
        } else {
            // Is it a League Game?
            const isLeague = assignment._h2h || (assignment.field && String(assignment.field).toLowerCase().includes("league"));
            
            if (isLeague) {
                const team = camper.team;
                
                if (!team) {
                    locationHtml = `<span style="color:#d97706;">Playing Leagues (Team Unknown)</span>`;
                    detailsHtml = `We know ${bunk} is playing leagues, but <strong>${camperName}</strong> has no team assigned.<br>
                                   <a href="#" onclick="document.getElementById('loc-filter-roster').value='${camperName}'; document.getElementById('loc-filter-roster').focus(); document.getElementById('loc-filter-roster').dispatchEvent(new Event('keyup')); return false;">Assign a team below</a> to see exact field.`;
                } else {
                    // ★★★ League lookup — normalized matchup handling ★★★
                    const leagueData = division 
                        ? window.leagueAssignments?.[division]?.[slotIdx]
                        : null;
                    
                    // Also check assignment's own _allMatchups as fallback
                    let effectiveLeagueData = leagueData;
                    if (!effectiveLeagueData?.matchups && assignment._allMatchups) {
                        effectiveLeagueData = { 
                            matchups: assignment._allMatchups, 
                            gameLabel: assignment._gameLabel, 
                            sport: assignment.sport 
                        };
                    }
                    
                    const match = findTeamMatchup(effectiveLeagueData, team);

                    if (match) {
                        locationHtml = `<span style="color:#059669; font-weight:bold; font-size:1.4rem;">${match.field} - ${match.sport || effectiveLeagueData?.sport || 'League'}</span>`;
                        detailsHtml = `Team ${team}`;
                    } else {
                        locationHtml = `<span style="color:#d97706; font-weight:bold; font-size:1.4rem;">Leagues</span>`;
                        detailsHtml = `<strong>${effectiveLeagueData?.gameLabel || 'League Game'}</strong> — Team <strong>${team}</strong> not found in matchups.${buildAllMatchupsHtml(effectiveLeagueData)}`;
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
                
                <div>
                    <h2 style="margin:0; color:#333;">${camperName}</h2>
                    <p style="margin:0; color:#666;">${camper.division}${division !== camper.division ? ' &bull; ' + division : ''} &bull; ${camper.bunk}</p>
                </div>
                <div style="margin-left:auto; text-align:right;">
                    <div style="font-size:0.9rem; color:#888; text-transform:uppercase; letter-spacing:1px; font-weight:bold;">${timeLabel}</div>
                    ${timeContext}
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
        
        if (countEl) countEl.textContent = `Showing ${filtered.length} of ${campers.length} campers`;

        filtered.forEach(name => {
            const data = camperRoster[name];
            const tr = document.createElement("tr");
            
            const teamOptions = teams.length > 0 ? 
                teams.map(t => `<option value="${t}" ${data.team === t ? 'selected' : ''}>${t}</option>`).join("") : 
                `<option disabled>No teams configured</option>`;

            tr.innerHTML = `
                <td style="font-weight:600;">${name}</td>
                <td>${data.division || "?"}</td>
                <td>${data.bunk || "?"}</td>
                <td>
                    <select onchange="window._setCamperTeam('${name.replace(/'/g, "\\'")}', this.value)" 
                            style="padding:4px 8px; border:1px solid #ccc; border-radius:4px;">
                        <option value="">— None —</option>
                        ${teamOptions}
                    </select>
                </td>
            `;
            listContainer.appendChild(tr);
        });
    }

    // =============================================================
    // TEAM HELPERS
    // =============================================================
    function getAllTeams() {
        const settings = window.loadGlobalSettings?.() || {};
        const teams = new Set();

        // Source 1: Regular leagues (settings.leagues)
        const regularLeagues = settings.leagues || {};
        Object.values(regularLeagues).forEach(league => {
            if (league && Array.isArray(league.teams)) {
                league.teams.forEach(t => teams.add(t));
            }
        });

        // Source 2: Specialty leagues (settings.specialtyLeagues)
        const specLeagues = settings.specialtyLeagues || {};
        Object.values(specLeagues).forEach(league => {
            if (league && Array.isArray(league.teams)) {
                league.teams.forEach(t => teams.add(t));
            }
        });

        // Source 3: Legacy fallback (app1.leagueTeams) — old format
        if (teams.size === 0) {
            const legacy = settings.app1?.leagueTeams || settings.leagueTeams || {};
            Object.values(legacy).forEach(divTeams => {
                if (Array.isArray(divTeams)) divTeams.forEach(t => teams.add(t));
            });
        }

        return [...teams].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    }

    window._setCamperTeam = function(name, team) {
        if (camperRoster[name]) {
            camperRoster[name].team = team || null;
            saveRoster();
        }
    };

})();
