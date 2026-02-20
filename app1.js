// =================================================================
// app1.js — v5.2: Grades Are The Scheduling Units (Clean UI)
//
// THEME: Modern Pro Camp (Emerald/White)
// VERSION: 5.2 - Cleaned UI: removed redundant elements, fixed selected border
// 
// KEY CONCEPT:
//   Division (e.g. "Juniors")    = organizational parent group
//   Grade    (e.g. "1st Grade")  = the SCHEDULING UNIT (columns in builder)
//   Bunk     (e.g. "1A", "1B")   = individual groups within a grade
//
// v5.2 CHANGES vs v5.1:
// - Removed "🏕️ Camp Scheduler" page title
// - Removed redundant static intro card ("Configure Your Camp Structure")
// - Fixed green selection ring clipping (outline instead of box-shadow)
// - Updated panel headers: "Divisions" → "Grades", cleaned descriptions
// - Simplified Campistry Me link banner
// - Removed legacy "All Divisions" subtitle (parent-division groups replace it)
// - Cleaned up detail pane (removed redundant color row)
// =================================================================
(function () {
    "use strict";
    
    // ==================== CONSTANTS ====================
    const VERSION = "5.2";
    const DEBOUNCE_MS = 150;
    const DEFAULT_BUNK_SIZE = 0;
    
    const DEFAULT_COLORS = Object.freeze([
        "#00C896", "#6366F1", "#F59E0B", "#EF4444",
        "#8B5CF6", "#3B82F6", "#10B981", "#EC4899",
        "#F97316", "#14B8A6", "#84CC16", "#A855F7",
        "#06B6D4", "#F43F5E", "#22C55E", "#FBBF24"
    ]);
    
    const DEFAULT_SPORTS = Object.freeze([
        "Baseball", "Basketball", "Football", "Hockey", "Kickball",
        "Lacrosse", "Newcomb", "Punchball", "Soccer", "Volleyball"
    ]);
    
    const DEFAULT_DURATIONS = Object.freeze({
        "General Activity": 60,
        "Sports Slot": 60,
        "Special Activity": 60,
        "Swim": 60,
        "League Game": 60,
        "Specialty League": 60
    });

    // ==================== STATE ====================
    const state = {
        bunks: [],
        divisions: {},
        specialActivities: [],
        availableDivisions: [],
        selectedDivision: null,
        bunkMetaData: {},
        sportMetaData: {},
        allSports: [...DEFAULT_SPORTS],
        savedSkeletons: {},
        skeletonAssignments: {},
        divisionGroups: {}
    };

    // ==================== UTILITIES ====================
    
    function deepClone(obj) {
        if (obj === null || obj === undefined) return obj;
        try { return structuredClone(obj); }
        catch { return JSON.parse(JSON.stringify(obj)); }
    }
    
    function debounce(fn, delay = DEBOUNCE_MS) {
        let timeoutId;
        return function (...args) {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => fn.apply(this, args), delay);
        };
    }
    
    function safeGet(obj, path, defaultVal = null) {
        if (!obj || !path) return defaultVal;
        const keys = path.split('.');
        let result = obj;
        for (const key of keys) {
            if (result === null || result === undefined) return defaultVal;
            result = result[key];
        }
        return result ?? defaultVal;
    }
    
    function parseTimeToMinutes(str) {
        if (!str || typeof str !== "string") return null;
        let s = str.trim().toLowerCase();
        let meridiem = null;
        if (s.endsWith("am") || s.endsWith("pm")) {
            meridiem = s.endsWith("am") ? "am" : "pm";
            s = s.replace(/am|pm/gi, "").trim();
        }
        const match = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
        if (!match) return null;
        let hours = parseInt(match[1], 10);
        const minutes = parseInt(match[2], 10);
        if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
        if (meridiem) {
            if (hours === 12) hours = meridiem === "am" ? 0 : 12;
            else if (meridiem === "pm" && hours < 12) hours += 12;
        }
        return hours * 60 + minutes;
    }
    
    function compareBunks(a, b) {
        return String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true, sensitivity: "base" });
    }
    
    function sortBunksInPlace(arr) {
        if (!Array.isArray(arr)) return;
        arr.sort(compareBunks);
    }
    
    function escapeHtml(str) {
        if (!str) return "";
        const div = document.createElement("div");
        div.textContent = str;
        return div.innerHTML;
    }

    // ==================== SYNC SPINE ====================
    
    function syncSpine() {
        window.setGlobalDivisions?.(deepClone(state.divisions));
        window.setGlobalBunks?.(deepClone(state.bunks));
    }

    // ==================== COLOR MANAGEMENT ====================
    
    function getColorIndex() {
        const settings = window.loadGlobalSettings?.() || {};
        return settings.divisionColorIndex || 0;
    }
    
    function setColorIndex(index) {
        window.saveGlobalSettings?.('divisionColorIndex', index);
    }
    
    function getNextDivisionColor() {
        const index = getColorIndex();
        const color = DEFAULT_COLORS[index % DEFAULT_COLORS.length];
        setColorIndex(index + 1);
        return color;
    }
    
    function getNextUniqueDivisionColor(divisionsObj = state.divisions) {
        const usedColors = new Set(
            Object.values(divisionsObj || {}).map(d => d?.color).filter(Boolean)
        );
        const startIndex = getColorIndex();
        for (let i = 0; i < DEFAULT_COLORS.length; i++) {
            const index = (startIndex + i) % DEFAULT_COLORS.length;
            const color = DEFAULT_COLORS[index];
            if (!usedColors.has(color)) {
                setColorIndex(index + 1);
                return color;
            }
        }
        return getNextDivisionColor();
    }

    // ==================== STYLES ====================
    
    function ensureSharedSetupStyles() {
        if (document.getElementById("setup-shared-styles")) return;
        
        const style = document.createElement("style");
        style.id = "setup-shared-styles";
        style.textContent = `
            /* ===== Global Setup / Detail Pane Shell (Modern Pro Camp) ===== */
            .detail-pane {
                border-radius: 18px;
                border: 1px solid #E5E7EB;
                padding: 18px 20px;
                background: linear-gradient(135deg, #F7F9FA 0%, #FFFFFF 55%, #F7F9FA 100%);
                min-height: 360px;
                box-shadow: 0 18px 40px rgba(15, 23, 42, 0.06);
            }
            
            .division-card {
                border-radius: 18px;
                border: 1px solid #E5E7EB;
                background: #FFFFFF;
                padding: 10px 16px;
                margin: 4px 0;
                box-shadow: 0 8px 18px rgba(15, 23, 42, 0.06);
                cursor: pointer;
                transition: all 0.16s ease;
            }
            
            .division-card:hover {
                box-shadow: 0 12px 26px rgba(15, 23, 42, 0.12);
                transform: translateY(-1px);
                background-color: #F9FAFB;
            }
            
            /* ★ v5.2 FIX: Use outline instead of box-shadow spread 
               so the green ring doesn't get clipped by the parent container */
            .division-card.selected {
                border-color: #00C896;
                outline: 2px solid rgba(0, 200, 150, 0.55);
                outline-offset: 0px;
                background: radial-gradient(circle at top left, #ECFDF5 0, #FFFFFF 65%);
            }
            
            /* ★ v5.2: Give the grade list breathing room for outlines */
            #divisionButtons.master-list {
                padding: 3px;
            }
            
            .division-card-top {
                display: flex;
                align-items: center;
                gap: 10px;
                margin-bottom: 4px;
            }
            
            .division-pill {
                padding: 4px 16px;
                border-radius: 999px;
                color: #FFFFFF;
                font-weight: 600;
                font-size: 0.9rem;
                min-width: 32px;
                display: flex;
                justify-content: center;
                align-items: center;
                box-shadow: 0 4px 10px rgba(15, 23, 42, 0.22);
            }
            
            .division-color-chip-list {
                width: 22px;
                height: 22px;
                border-radius: 6px;
                border: 1px solid rgba(15, 23, 42, 0.12);
                box-shadow: 0 2px 6px rgba(15, 23, 42, 0.15);
            }
            
            .division-card-subline {
                font-size: 0.8rem;
                color: #6B7280;
            }
            
            .division-edit-shell {
                padding: 4px 0 0;
                border-radius: 16px;
                background: transparent;
            }
            
            .division-edit-header {
                display: flex;
                justify-content: space-between;
                align-items: baseline;
                padding-bottom: 10px;
                border-bottom: 1px solid #E5E7EB;
                margin-bottom: 14px;
            }
            
            .division-header-left {
                display: flex;
                align-items: center;
                gap: 8px;
                font-weight: 600;
                font-size: 0.98rem;
                color: #111827;
            }
            
            .division-status-dot {
                width: 10px;
                height: 10px;
                border-radius: 50%;
                flex-shrink: 0;
            }
            
            .division-name {
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            
            .division-header-summary {
                font-size: 0.8rem;
                color: #6B7280;
                font-weight: 400;
            }
            
            .division-edit-grid {
                display: flex;
                flex-direction: column;
                gap: 14px;
            }
            
            .division-mini-card {
                background: #FFFFFF;
                border: 1px solid #E5E7EB;
                border-radius: 12px;
                padding: 12px 14px;
                box-shadow: 0 2px 8px rgba(15, 23, 42, 0.04);
            }
            
            .division-mini-header {
                font-weight: 600;
                font-size: 0.82rem;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                color: #374151;
                margin-bottom: 6px;
            }
            
            .division-mini-help {
                font-size: 0.78rem;
                color: #9CA3AF;
                margin: 0 0 6px;
            }
            
            .division-bunk-pill {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 5px 12px;
                border-radius: 999px;
                background: #F1F5F9;
                color: #1E293B;
                font-size: 0.8rem;
                font-weight: 500;
                border: 1px solid transparent;
                transition: all 0.15s ease;
            }
            
            .division-bunk-pill:hover {
                background: rgba(13, 124, 92, 0.12);
                border-color: #0D7C5C;
            }
            
            .bunk-size-badge {
                background: #E2E8F0;
                color: #64748B;
                padding: 1px 6px;
                border-radius: 999px;
                font-size: 0.7rem;
                font-weight: 500;
            }
            
            .division-color-row {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 0.8rem;
                color: #6B7280;
                margin-bottom: 12px;
            }

            /* ===== Parent Division Group Headers ===== */
            .parent-division-label {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 8px 4px 2px;
                font-size: 0.72rem;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.08em;
                color: #6B7280;
            }

            .parent-division-label:not(:first-child) {
                margin-top: 10px;
                padding-top: 10px;
                border-top: 1px solid #F3F4F6;
            }

            .parent-division-dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                flex-shrink: 0;
            }

            .bunk-delete-confirm {
                background: #FEF2F2;
                border-color: #FECACA;
                animation: shake 0.3s ease-in-out;
            }
            
            @keyframes shake {
                0%, 100% { transform: translateX(0); }
                25% { transform: translateX(-2px); }
                75% { transform: translateX(2px); }
            }
        `;
        document.head.appendChild(style);
    }

    // ==================== CAMPISTRY ME LINK BANNER ====================

    // Campistry Me link is now in the header (index.html)

    // ==================== UI RENDERING ====================
    
    /**
     * Render grade cards in the left panel, grouped by parent division
     */
    function setupDivisionButtons() {
        const container = document.getElementById("divisionButtons");
        if (!container) return;
        
        container.innerHTML = "";
        
        if (!state.availableDivisions?.length) {
            container.innerHTML = `
                <p class="muted">
                    No grades yet. <a href="campistry_me.html" style="color:#7C3AED; font-weight:600;">Open Campistry Me</a> to create divisions, grades, and bunks.
                </p>
            `;
            renderDivisionDetailPane();
            return;
        }
        
        const fragment = document.createDocumentFragment();
        
        const groupOrder = Object.keys(state.divisionGroups);
        
        groupOrder.forEach(parentDivName => {
            const group = state.divisionGroups[parentDivName];
            if (!group || !group.grades?.length) return;
            
            // Parent division header (only show if there are real named groups)
            if (parentDivName !== "All") {
                const groupHeader = document.createElement("div");
                groupHeader.className = "parent-division-label";
                groupHeader.innerHTML = `
                    <span class="parent-division-dot" style="background-color:${escapeHtml(group.color)};"></span>
                    ${escapeHtml(parentDivName)}
                `;
                fragment.appendChild(groupHeader);
            }
            
            // Grade cards within this parent division
            group.grades.forEach(gradeName => {
                const divObj = state.divisions[gradeName];
                if (!divObj) return;
                
                const card = document.createElement("div");
                card.className = "division-card";
                if (state.selectedDivision === gradeName) {
                    card.classList.add("selected");
                }
                
                card.addEventListener("click", () => {
                    state.selectedDivision = gradeName;
                    saveData();
                    setupDivisionButtons();
                    renderDivisionDetailPane();
                });
                
                const color = divObj.color || DEFAULT_COLORS[0];
                const hasTime = divObj.startTime && divObj.endTime;
                
                card.innerHTML = `
                    <div class="division-card-top">
                        <div class="division-pill" style="background-color:${escapeHtml(color)}">
                            ${escapeHtml(gradeName)}
                        </div>
                    </div>
                    <div class="division-card-subline">
                        ${hasTime
                            ? `<span style="color:#0D7C5C; font-weight:500;">${escapeHtml(divObj.startTime)} – ${escapeHtml(divObj.endTime)}</span>`
                            : `<span style="color:#D97706; font-style:italic;">No times set</span>`}
                    </div>
                `;
                
                fragment.appendChild(card);
            });
        });
        
        container.appendChild(fragment);
        renderDivisionDetailPane();
    }
    
    /**
     * Render grade detail pane — times are editable, structure is read-only
     */
    function renderDivisionDetailPane() {
        const pane = document.getElementById("division-detail-pane");
        if (!pane) return;
        
        pane.innerHTML = "";
        
        if (!state.selectedDivision || !state.divisions[state.selectedDivision]) {
            pane.innerHTML = `
                <p class="muted" style="padding: 20px 0; text-align: center;">
                    Select a grade on the left to configure its <strong>times</strong>
                    and view its <strong>bunks</strong>.
                </p>
            `;
            return;
        }
        
        const gradeName = state.selectedDivision;
        const divObj = state.divisions[gradeName];
        const parentDiv = divObj.parentDivision || "";
        
        // ====== CONTENT ======
        pane.innerHTML = `
            <div class="division-edit-grid">
                <!-- TIMES CARD (editable) -->
                <div class="division-mini-card">
                    <div class="division-mini-header"><span>Grade Times</span></div>
                    <p class="division-mini-help">Set the daily time window for this grade.</p>
                    <div style="display:flex; align-items:center; gap:8px; margin-top:4px; flex-wrap:wrap;">
                        <input id="time-start-input" value="${escapeHtml(divObj.startTime || "")}" placeholder="9:00am" style="width:80px; padding:4px 8px; border-radius:8px; border:1px solid #D1D5DB; font-size:0.85rem;">
                        <span style="color:#9CA3AF;">to</span>
                        <input id="time-end-input" value="${escapeHtml(divObj.endTime || "")}" placeholder="4:00pm" style="width:80px; padding:4px 8px; border-radius:8px; border:1px solid #D1D5DB; font-size:0.85rem;">
                        <button id="save-times-btn" style="background:#111827; color:white; border:none; padding:5px 14px; border-radius:8px; font-size:0.8rem; cursor:pointer; font-weight:500;">Save Times</button>
                        ${parentDiv ? `<button id="apply-times-all-btn" style="background:#F3F4F6; color:#374151; border:1px solid #D1D5DB; padding:5px 14px; border-radius:8px; font-size:0.78rem; cursor:pointer; font-weight:500;" title="Apply these times to all grades in ${escapeHtml(parentDiv)}">Apply to All in ${escapeHtml(parentDiv)}</button>` : ''}
                    </div>
                </div>
                
                <!-- BUNKS (read-only) -->
                <div class="division-mini-card">
                    <div class="division-mini-header"><span>Bunks</span></div>
                    <p class="division-mini-help">Bunks in this grade. <a href="campistry_me.html" style="color:#7C3AED; font-weight:500;">Edit in Campistry Me</a></p>
                    <div id="bunk-list" style="margin-top:6px; display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px;"></div>
                </div>
            </div>
        `;
        
        // ====== WIRE UP: Times ======
        const startInput = pane.querySelector("#time-start-input");
        const endInput = pane.querySelector("#time-end-input");
        const saveTimesBtn = pane.querySelector("#save-times-btn");
        const applyAllBtn = pane.querySelector("#apply-times-all-btn");
        
        const saveTimes = () => {
            const rawStart = (startInput?.value || "").trim();
            const rawEnd = (endInput?.value || "").trim();
            
            // Allow clearing both times
            if (!rawStart && !rawEnd) {
                divObj.startTime = "";
                divObj.endTime = "";
                syncSpine();
                saveData();
                setupDivisionButtons();
                renderDivisionDetailPane();
                return;
            }
            
            // Both must be provided
            if (!rawStart || !rawEnd) {
                alert("Please enter both a start and end time, or leave both empty.");
                return;
            }
            
            // Validate format
            const startMin = parseTimeToMinutes(rawStart);
            const endMin = parseTimeToMinutes(rawEnd);
            
            if (startMin === null) {
                alert("Invalid start time format. Use format like 9:00am or 2:30pm");
                startInput?.focus();
                return;
            }
            if (endMin === null) {
                alert("Invalid end time format. Use format like 9:00am or 2:30pm");
                endInput?.focus();
                return;
            }
            
            // End must be after start
            if (endMin <= startMin) {
                alert("End time must be after start time.");
                endInput?.focus();
                return;
            }
            
            divObj.startTime = rawStart;
            divObj.endTime = rawEnd;
            syncSpine();
            saveData();
            setupDivisionButtons();
            renderDivisionDetailPane();
        };
        
        saveTimesBtn?.addEventListener("click", saveTimes);
        startInput?.addEventListener("keydown", (e) => e.key === "Enter" && saveTimes());
        endInput?.addEventListener("keydown", (e) => e.key === "Enter" && saveTimes());
        
        // "Apply to All in Division" — sets same times for all sibling grades
       
            
           applyAllBtn?.addEventListener("click", () => {
            const newStart = (startInput?.value || "").trim();
            const newEnd = (endInput?.value || "").trim();
            if (!newStart || !newEnd) {
                alert("Please enter both a start and end time before applying to all.");
                return;
            }
            
            const startMin = parseTimeToMinutes(newStart);
            const endMin = parseTimeToMinutes(newEnd);
            
            if (startMin === null) {
                alert("Invalid start time format. Use format like 9:00am or 2:30pm");
                return;
            }
            if (endMin === null) {
                alert("Invalid end time format. Use format like 9:00am or 2:30pm");
                return;
            }
            if (endMin <= startMin) {
                alert("End time must be after start time.");
                return;
            }
            
            const group = state.divisionGroups[parentDiv];
            if (!group) return;
            
            group.grades.forEach(siblingGrade => {
                const sibling = state.divisions[siblingGrade];
                if (sibling) {
                    sibling.startTime = newStart;
                    sibling.endTime = newEnd;
                }
            });
            
            syncSpine();
            saveData();
            setupDivisionButtons();
            renderDivisionDetailPane();
        });
        
        // ====== BUNK LIST (read-only pills) ======
        const bunkList = pane.querySelector("#bunk-list");
        if (bunkList) {
            if (!divObj.bunks?.length) {
                bunkList.innerHTML = '<p class="muted">No bunks assigned yet.</p>';
            } else {
                const sorted = [...divObj.bunks].sort(compareBunks);
                sorted.forEach(bunkName => {
                    const meta = state.bunkMetaData[bunkName] || { size: 0 };
                    const pill = document.createElement("span");
                    pill.className = "division-bunk-pill";
                    pill.style.cursor = "default";
                    pill.innerHTML = `
                        ${escapeHtml(bunkName)} 
                        <span class="bunk-size-badge">${meta.size || 0}</span>
                    `;
                    bunkList.appendChild(pill);
                });
            }
        }
    }

    // ==================== PERSISTENCE ====================
    
    function saveData() {
        const app1Data = window.loadGlobalSettings?.()?.app1 || {};
        
        const data = {
            ...app1Data,
            bunks: state.bunks,
            divisions: state.divisions,
            availableDivisions: state.availableDivisions,
            selectedDivision: state.selectedDivision,
            allSports: state.allSports,
            savedSkeletons: state.savedSkeletons,
            skeletonAssignments: state.skeletonAssignments,
            specialActivities: state.specialActivities,
            bunkMetaData: state.bunkMetaData,
            sportMetaData: state.sportMetaData,
            divisionGroups: state.divisionGroups
        };
        
        window.saveGlobalSettings?.("app1", data);
        
        updateWindowApp1();
    }
    
    function loadData() {
        const globalData = window.loadGlobalSettings?.() || {};
        const data = globalData.app1 || {};
        const campStructure = globalData.campStructure || {};
        
        try {
            const existingTimes = {};
            if (data.divisions) {
                Object.entries(data.divisions).forEach(([name, div]) => {
                    if (div?.startTime || div?.endTime) {
                        existingTimes[name] = {
                            startTime: div.startTime || "",
                            endTime: div.endTime || ""
                        };
                    }
                });
            }
            
            if (Object.keys(campStructure).length > 0) {
                console.log("[app1 v5.2] Loading GRADES as scheduling units from campStructure");
                const gradeBasedDivisions = {};
                const allBunks = [];
                const divGroups = {};
                
                const gradeNameCounts = {};
                Object.entries(campStructure).forEach(([divName, divData]) => {
                    if (typeof divData !== 'object' || divData === null) return;
                    Object.keys(divData.grades || {}).forEach(gradeName => {
                        gradeNameCounts[gradeName] = (gradeNameCounts[gradeName] || 0) + 1;
                    });
                });
                
                Object.entries(campStructure).forEach(([divName, divData]) => {
                    if (typeof divData !== 'object' || divData === null) return;
                    
                    const parentColor = divData.color || getNextUniqueDivisionColor(gradeBasedDivisions);
                    const gradeNames = Object.keys(divData.grades || {});
                    
                    divGroups[divName] = { color: parentColor, grades: [] };
                    
                    gradeNames.forEach(gradeName => {
                        const gradeData = divData.grades[gradeName];
                        const bunks = gradeData.bunks || [];
                        bunks.forEach(b => { if (!allBunks.includes(b)) allBunks.push(b); });
                        
                        const key = gradeNameCounts[gradeName] > 1
                            ? `${divName} > ${gradeName}`
                            : gradeName;
                        
                        if (gradeNameCounts[gradeName] > 1) {
                            console.warn(`[app1 v5.2] Grade "${gradeName}" exists in multiple divisions — using "${key}"`);
                        }
                        
                        const times = existingTimes[key] || existingTimes[gradeName] || existingTimes[divName] || {};
                        
                        gradeBasedDivisions[key] = {
                            startTime: times.startTime || "",
                            endTime: times.endTime || "",
                            bunks: [...bunks].sort(compareBunks),
                            color: parentColor,
                            parentDivision: divName
                        };
                        
                        divGroups[divName].grades.push(key);
                    });
                });
                
                state.divisions = gradeBasedDivisions;
                state.bunks = allBunks;
                state.divisionGroups = divGroups;
                
            } else {
                console.log("[app1 v5.2] No campStructure found, falling back to flat divisions");
                const globalDivisions = window.getGlobalDivisions?.() || {};
                const globalBunks = window.getGlobalBunks?.() || [];
                
                if (Object.keys(globalDivisions).length > 0) {
                    state.divisions = deepClone(globalDivisions);
                } else if (data.divisions && Object.keys(data.divisions).length > 0) {
                    state.divisions = deepClone(data.divisions);
                } else {
                    state.divisions = {};
                }
                
                if (globalBunks.length > 0) {
                    state.bunks = deepClone(globalBunks);
                } else if (data.bunks?.length > 0) {
                    state.bunks = deepClone(data.bunks);
                } else {
                    state.bunks = [];
                }
                
                const validDivisions = {};
                Object.entries(state.divisions).forEach(([divName, div]) => {
                    if (typeof div !== 'object' || div === null) return;
                    validDivisions[divName] = {
                        startTime: div.startTime || "",
                        endTime: div.endTime || "",
                        bunks: Array.isArray(div.bunks) ? div.bunks : [],
                        color: div.color || getNextUniqueDivisionColor(validDivisions)
                    };
                    sortBunksInPlace(validDivisions[divName].bunks);
                });
                state.divisions = validDivisions;
                
                state.divisionGroups = { "All": { color: "#6B7280", grades: Object.keys(state.divisions) } };
            }
            
            state.availableDivisions = Object.keys(state.divisions);
            state.specialActivities = data.specialActivities || [];
            state.bunkMetaData = data.bunkMetaData || {};
            state.sportMetaData = data.sportMetaData || {};
            state.selectedDivision = data.selectedDivision || state.availableDivisions[0] || null;
            state.allSports = Array.isArray(data.allSports) ? data.allSports : [...DEFAULT_SPORTS];
            state.savedSkeletons = data.savedSkeletons || {};
            state.skeletonAssignments = data.skeletonAssignments || {};
            
            const camperRoster = data.camperRoster || {};
            const bunkCounts = {};
            Object.values(camperRoster).forEach(camper => {
                if (camper?.bunk) {
                    bunkCounts[camper.bunk] = (bunkCounts[camper.bunk] || 0) + 1;
                }
            });
            Object.entries(bunkCounts).forEach(([bunk, count]) => {
                if (!state.bunkMetaData[bunk]) state.bunkMetaData[bunk] = {};
                if (!state.bunkMetaData[bunk].size) {
                    state.bunkMetaData[bunk].size = count;
                }
            });
            
            updateWindowApp1();
            
            console.log(`[app1 v5.2] Loaded ${state.availableDivisions.length} grades as scheduling units:`, state.availableDivisions);
            
        } catch (e) {
            console.error("Error loading app1 data:", e);
        }
    }
    
    function updateWindowApp1() {
        window.app1 = {
            get divisions() { return state.divisions; },
            get bunks() { return state.bunks; },
            get availableDivisions() { return state.availableDivisions; },
            startTime: "9:00am",
            endTime: "4:00pm",
            defaultDurations: { ...DEFAULT_DURATIONS },
            increments: 30,
            get activities() { return state.specialActivities; },
            get bunkMetaData() { return state.bunkMetaData; },
            get sportMetaData() { return state.sportMetaData; },
            get divisionGroups() { return state.divisionGroups; }
        };
        
        window.divisions = state.divisions;
        window.availableDivisions = state.availableDivisions;
        window.bunks = state.bunks;
        window.allSports = state.allSports;
    }



    // ==================== INITIALIZATION ====================
    
    function initApp1() {
        ensureSharedSetupStyles();
        loadData();
        
        // Style detail pane
        const detailPane = document.getElementById("division-detail-pane");
        if (detailPane) {
            detailPane.classList.add("detail-pane");
            detailPane.style.marginTop = "8px";
        }
        
        // --- Wire up the Erase All Button ---
        const eraseAllBtn = document.getElementById("eraseAllBtn");
        if (eraseAllBtn) {
            const newBtn = eraseAllBtn.cloneNode(true);
            eraseAllBtn.parentNode.replaceChild(newBtn, eraseAllBtn);
            
            newBtn.addEventListener("click", async () => {
                if (!window.AccessControl?.canEraseData?.()) {
                    window.AccessControl?.showPermissionDenied?.('erase all camp data');
                    return;
                }
                if (confirm("⚠️ WARNING: This will delete ALL camp data, divisions, bunks, and schedules.\n\nThis action cannot be undone.\n\nAre you sure?")) {
                    const confirm2 = confirm("Are you absolutely sure? All data will be lost forever.");
                    if (confirm2) {
                        if (window.resetCloudState) {
                            newBtn.textContent = "Erasing...";
                            newBtn.disabled = true;
                            newBtn.style.opacity = "0.7";
                            
                            const success = await window.resetCloudState();
                            
                            if (success) {
                                alert("All data erased successfully.");
                                window.location.reload();
                            } else {
                                alert("Error erasing data from cloud. Please check connection.");
                                newBtn.textContent = "Erase All Camp Data";
                                newBtn.disabled = false;
                                newBtn.style.opacity = "1";
                            }
                        } else {
                            localStorage.clear();
                            window.location.reload();
                        }
                    }
                }
            });
        }
        
        // Initial render
        setupDivisionButtons();
        renderDivisionDetailPane();
        
        console.log(`[app1] v${VERSION} initialized — grades are scheduling units`);
        
    
    window.renderAutoModeToggle?.(document.getElementById('schedule-mode-toggle'));
    console.log(`[app1] v${VERSION} initialized — grades are scheduling units`);
}
    }

    // ==================== WINDOW EXPORTS ====================
    
    window.initApp1 = initApp1;
    
    window.getDivisions = () => state.divisions;
    window.getBunkMetaData = () => state.bunkMetaData;
    window.getSportMetaData = () => state.sportMetaData;
    window.getGlobalSpecialActivities = () => state.specialActivities;
    window.getAllGlobalSports = () => [...state.allSports].sort();
    window.getSavedSkeletons = () => state.savedSkeletons || {};
    window.getSkeletonAssignments = () => state.skeletonAssignments || {};
    
    window.getDivisionGroups = () => state.divisionGroups;
    window.getCampStructure = () => {
        const globalData = window.loadGlobalSettings?.() || {};
        return globalData.campStructure || {};
    };
    window.getParentDivision = (gradeName) => {
        return state.divisions[gradeName]?.parentDivision || null;
    };
    
    window.addGlobalSport = (sportName) => {
        if (!sportName) return;
        const s = sportName.trim();
        if (s && !state.allSports.find(sp => sp.toLowerCase() === s.toLowerCase())) {
            state.allSports.push(s);
            saveData();
        }
    };

    window.removeGlobalSport = (sportName) => {
        if (!sportName) return;
        const idx = state.allSports.findIndex(sp => 
            sp.toLowerCase() === sportName.toLowerCase()
        );
        if (idx !== -1) {
            state.allSports.splice(idx, 1);
            saveData();
            window.forceSyncToCloud?.();
        }
    };
    
    window.saveSkeleton = (name, skeletonData) => {
        if (!name || !skeletonData) return;
        state.savedSkeletons[name] = skeletonData;
        saveData();
    };
    
    window.deleteSkeleton = (name) => {
        if (!name) return;
        delete state.savedSkeletons[name];
        Object.keys(state.skeletonAssignments).forEach(day => {
            if (state.skeletonAssignments[day] === name) {
                delete state.skeletonAssignments[day];
            }
        });
        saveData();
    };
    
    window.saveSkeletonAssignments = (assignments) => {
        if (!assignments) return;
        state.skeletonAssignments = assignments;
        saveData();
    };
    
    window.saveGlobalSpecialActivities = (updatedActivities) => {
        state.specialActivities = updatedActivities;
        saveData();
    };
    
    window.addDivisionBunk = (divName, bunkName) => {
        console.warn("[app1] addDivisionBunk is deprecated — manage bunks in Campistry Me");
        return false;
    };
    
    window.getNextDivisionColor = getNextDivisionColor;
    window.getNextUniqueDivisionColor = getNextUniqueDivisionColor;
    window.getColorIndex = getColorIndex;
    window.incrementColorIndex = () => setColorIndex(getColorIndex() + 1);
    
    updateWindowApp1();

})();
