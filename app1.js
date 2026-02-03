// =================================================================
// app1.js — v5.0: Inline Division/Grade/Bunk Management
//
// THEME: Modern Pro Camp (Emerald/White)
// VERSION: 5.0 - Hierarchical Division→Grade→Bunk creation in Setup
// 
// v5.0 CHANGES:
// - Divisions, grades & bunks can now be created/deleted directly in Setup
// - Hierarchical detail pane: Division → Grades → Bunks (like Campistry Me)
// - campStructure written as source of truth for cross-page compat
// - Times still editable per division
// - All window exports preserved for scheduler compatibility
// =================================================================
(function () {
    "use strict";
    
    // ==================== CONSTANTS ====================
    const VERSION = "5.0";
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
        divisions: {},          // Flat: { divName: { startTime, endTime, bunks:[], color } }
        campStructure: {},      // Hierarchical: { divName: { color, grades: { gradeName: { bunks:[] } } } }
        specialActivities: [],
        availableDivisions: [],
        selectedDivision: null,
        bunkMetaData: {},
        sportMetaData: {},
        allSports: [...DEFAULT_SPORTS],
        savedSkeletons: {},
        skeletonAssignments: {},
        // UI state for expand/collapse
        expandedDivisions: new Set(),
        expandedGrades: new Set()
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

    function getNextUniqueStructureColor() {
        const usedColors = new Set(
            Object.values(state.campStructure || {}).map(d => d?.color).filter(Boolean)
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

    // ==================== CAMP STRUCTURE ↔ FLAT DIVISIONS ====================

    /**
     * Rebuild flat state.divisions + state.bunks from state.campStructure
     * Preserves existing times from state.divisions
     */
    function rebuildFlatDivisions() {
        const existingTimes = {};
        Object.entries(state.divisions).forEach(([name, div]) => {
            if (div?.startTime || div?.endTime) {
                existingTimes[name] = { startTime: div.startTime || "", endTime: div.endTime || "" };
            }
        });

        const newDivisions = {};
        const allBunks = [];

        Object.entries(state.campStructure).forEach(([divName, divData]) => {
            if (typeof divData !== 'object' || divData === null) return;
            const bunks = [];
            Object.values(divData.grades || {}).forEach(grade => {
                (grade.bunks || []).forEach(b => {
                    bunks.push(b);
                    if (!allBunks.includes(b)) allBunks.push(b);
                });
            });
            sortBunksInPlace(bunks);

            const times = existingTimes[divName] || {};
            newDivisions[divName] = {
                startTime: times.startTime || "",
                endTime: times.endTime || "",
                bunks: bunks,
                color: divData.color || getNextUniqueDivisionColor(newDivisions)
            };
        });

        state.divisions = newDivisions;
        state.bunks = allBunks;
        state.availableDivisions = Object.keys(state.divisions);
        syncSpine();
    }

    /**
     * Migrate old flat divisions to hierarchical campStructure
     */
    function migrateToStructure(oldDivisions) {
        const struct = {};
        Object.entries(oldDivisions).forEach(([divName, divData]) => {
            const bunks = (divData.bunks || []).map(b => typeof b === 'string' ? b : b.name);
            struct[divName] = {
                color: divData.color || DEFAULT_COLORS[Object.keys(struct).length % DEFAULT_COLORS.length],
                grades: bunks.length > 0 ? { 'Default': { bunks } } : {}
            };
        });
        return struct;
    }

    // ==================== DIVISION / GRADE / BUNK OPERATIONS ====================

    function addDivision() {
        const input = document.getElementById("divisionInput");
        const name = input?.value?.trim();
        if (!name) return;

        if (state.campStructure[name]) {
            alert("Division '" + name + "' already exists.");
            return;
        }

        state.campStructure[name] = {
            color: getNextUniqueStructureColor(),
            grades: {}
        };
        state.expandedDivisions.add(name);

        input.value = "";
        rebuildFlatDivisions();
        state.selectedDivision = name;
        saveData();
        setupDivisionButtons();
        renderDivisionDetailPane();
    }

    function deleteDivision(divName) {
        if (!confirm('Delete "' + divName + '" and all its grades & bunks?')) return;
        delete state.campStructure[divName];
        state.expandedDivisions.delete(divName);
        // Clean any expanded grades for this division
        [...state.expandedGrades].forEach(key => {
            if (key.startsWith(divName + '||')) state.expandedGrades.delete(key);
        });

        rebuildFlatDivisions();
        if (state.selectedDivision === divName) {
            state.selectedDivision = state.availableDivisions[0] || null;
        }
        saveData();
        setupDivisionButtons();
        renderDivisionDetailPane();
    }

    function addGradeToDiv(divName) {
        const input = document.getElementById("add-grade-input-" + CSS.escape(divName));
        const gradeName = input?.value?.trim();
        if (!gradeName) return;

        const div = state.campStructure[divName];
        if (!div) return;
        if (!div.grades) div.grades = {};

        if (div.grades[gradeName]) {
            alert("Grade '" + gradeName + "' already exists in " + divName + ".");
            return;
        }

        div.grades[gradeName] = { bunks: [] };
        state.expandedGrades.add(divName + '||' + gradeName);
        input.value = "";

        rebuildFlatDivisions();
        saveData();
        renderDivisionDetailPane();

        // Focus the bunk input for this new grade
        setTimeout(() => {
            document.getElementById("add-bunk-input-" + CSS.escape(divName) + "-" + CSS.escape(gradeName))?.focus();
        }, 60);
    }

    function deleteGrade(divName, gradeName) {
        if (!confirm('Delete grade "' + gradeName + '" and all its bunks?')) return;
        const div = state.campStructure[divName];
        if (!div?.grades) return;
        delete div.grades[gradeName];
        state.expandedGrades.delete(divName + '||' + gradeName);

        rebuildFlatDivisions();
        saveData();
        renderDivisionDetailPane();
    }

    function addBunkToGrade(divName, gradeName) {
        const inputId = "add-bunk-input-" + CSS.escape(divName) + "-" + CSS.escape(gradeName);
        const input = document.getElementById(inputId);
        const bunkName = input?.value?.trim();
        if (!bunkName) return;

        const gradeData = state.campStructure[divName]?.grades?.[gradeName];
        if (!gradeData) return;
        if (!gradeData.bunks) gradeData.bunks = [];

        if (gradeData.bunks.includes(bunkName)) {
            alert("Bunk '" + bunkName + "' already exists.");
            return;
        }

        gradeData.bunks.push(bunkName);
        input.value = "";

        rebuildFlatDivisions();
        saveData();
        renderDivisionDetailPane();

        setTimeout(() => document.getElementById(inputId)?.focus(), 60);
    }

    function deleteBunk(divName, gradeName, bunkName) {
        const gradeData = state.campStructure[divName]?.grades?.[gradeName];
        if (!gradeData) return;
        gradeData.bunks = (gradeData.bunks || []).filter(b => b !== bunkName);

        rebuildFlatDivisions();
        saveData();
        renderDivisionDetailPane();
    }

    function toggleDetailDivision(divName) {
        if (state.expandedDivisions.has(divName)) state.expandedDivisions.delete(divName);
        else state.expandedDivisions.add(divName);
        renderDivisionDetailPane();
    }

    function toggleDetailGrade(divName, gradeName) {
        const key = divName + '||' + gradeName;
        if (state.expandedGrades.has(key)) state.expandedGrades.delete(key);
        else state.expandedGrades.add(key);
        renderDivisionDetailPane();
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
                margin: 8px 0;
                box-shadow: 0 8px 18px rgba(15, 23, 42, 0.06);
                cursor: pointer;
                transition: all 0.16s ease;
            }
            
            .division-card:hover {
                box-shadow: 0 12px 26px rgba(15, 23, 42, 0.12);
                transform: translateY(-1px);
                background-color: #F9FAFB;
            }
            
            .division-card.selected {
                border-color: #00C896;
                box-shadow: 0 0 0 1px rgba(0, 200, 150, 0.55);
                background: radial-gradient(circle at top left, #ECFDF5 0, #FFFFFF 65%);
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

            /* ===== Hierarchy Detail Styles (v5.0) ===== */

            .hierarchy-section {
                margin-top: 14px;
            }

            .grade-block-detail {
                background: #FFFFFF;
                border: 1px solid #E5E7EB;
                border-radius: 10px;
                margin-bottom: 8px;
                overflow: hidden;
                transition: box-shadow 0.15s ease;
            }

            .grade-block-detail:hover {
                box-shadow: 0 4px 12px rgba(15,23,42,0.06);
            }

            .grade-header-detail {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 8px 12px;
                cursor: pointer;
                transition: background 0.12s ease;
                user-select: none;
            }

            .grade-header-detail:hover {
                background: #F9FAFB;
            }

            .grade-header-left {
                display: flex;
                align-items: center;
                gap: 8px;
            }

            .grade-expand-icon {
                transition: transform 0.2s ease;
                color: #9CA3AF;
                flex-shrink: 0;
            }

            .grade-expand-icon.collapsed {
                transform: rotate(-90deg);
            }

            .grade-name-label {
                font-weight: 600;
                font-size: 0.85rem;
                color: #111827;
            }

            .grade-bunk-count {
                font-size: 0.72rem;
                color: #9CA3AF;
                background: #F3F4F6;
                padding: 2px 8px;
                border-radius: 999px;
            }

            .grade-delete-btn {
                background: none;
                border: none;
                cursor: pointer;
                color: #D1D5DB;
                padding: 4px;
                border-radius: 6px;
                transition: all 0.15s;
                display: flex;
                align-items: center;
            }

            .grade-delete-btn:hover {
                color: #EF4444;
                background: #FEF2F2;
            }

            .grade-body-detail {
                padding: 8px 12px 12px;
                border-top: 1px solid #F3F4F6;
                background: #FAFBFC;
            }

            .grade-body-detail.collapsed {
                display: none;
            }

            .bunks-wrap {
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
                align-items: center;
            }

            .bunk-chip-detail {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                padding: 4px 10px;
                background: #F1F5F9;
                border: 1px solid #E2E8F0;
                border-radius: 999px;
                font-size: 0.78rem;
                font-weight: 500;
                color: #1E293B;
                transition: all 0.12s;
            }

            .bunk-chip-detail:hover {
                background: #E2E8F0;
            }

            .bunk-chip-x {
                background: none;
                border: none;
                cursor: pointer;
                color: #D1D5DB;
                font-size: 0.75rem;
                padding: 0 0 0 2px;
                line-height: 1;
                transition: color 0.12s;
                display: flex;
                align-items: center;
            }

            .bunk-chip-x:hover {
                color: #EF4444;
            }

            .quick-add-row {
                display: flex;
                gap: 6px;
                align-items: center;
                margin-top: 6px;
            }

            .quick-add-row input {
                flex: 1;
                min-width: 80px;
                padding: 5px 10px;
                border: 1px solid #E5E7EB;
                border-radius: 8px;
                font-size: 0.8rem;
                outline: none;
                transition: border-color 0.15s;
            }

            .quick-add-row input:focus {
                border-color: #00C896;
                box-shadow: 0 0 0 2px rgba(0,200,150,0.15);
            }

            .quick-add-btn {
                background: #F3F4F6;
                border: 1px solid #E5E7EB;
                border-radius: 8px;
                padding: 5px 10px;
                cursor: pointer;
                color: #374151;
                font-size: 0.8rem;
                font-weight: 500;
                transition: all 0.12s;
                display: flex;
                align-items: center;
                gap: 4px;
            }

            .quick-add-btn:hover {
                background: #E5E7EB;
                border-color: #D1D5DB;
            }

            .add-grade-section {
                margin-top: 10px;
                padding-top: 10px;
                border-top: 1px dashed #E5E7EB;
            }

            .delete-division-btn {
                background: none;
                border: 1px solid #FECACA;
                color: #EF4444;
                padding: 6px 14px;
                border-radius: 8px;
                font-size: 0.78rem;
                cursor: pointer;
                transition: all 0.12s;
                font-weight: 500;
            }

            .delete-division-btn:hover {
                background: #FEF2F2;
                border-color: #EF4444;
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

    // ==================== BUNK OPERATIONS (LEGACY COMPAT) ====================
    // No-ops kept for any external callers

    // ==================== UI RENDERING ====================
    
    function setupDivisionButtons() {
        const container = document.getElementById("divisionButtons");
        if (!container) return;
        
        container.innerHTML = "";
        
        if (!state.availableDivisions?.length) {
            container.innerHTML = `
                <p class="muted">
                    No divisions yet. Use the input above to create one.
                </p>
            `;
            renderDivisionDetailPane();
            return;
        }
        
        const fragment = document.createDocumentFragment();
        
        state.availableDivisions.forEach((name) => {
            const divObj = state.divisions[name];
            if (!divObj) return;
            
            let totalKids = 0;
            (divObj.bunks || []).forEach(b => {
                totalKids += state.bunkMetaData[b]?.size || 0;
            });
            
            const card = document.createElement("div");
            card.className = "division-card";
            if (state.selectedDivision === name) {
                card.classList.add("selected");
            }
            
            card.addEventListener("click", () => {
                state.selectedDivision = name;
                // Auto-expand when selecting
                state.expandedDivisions.add(name);
                const struct = state.campStructure[name];
                if (struct?.grades) {
                    Object.keys(struct.grades).forEach(g => state.expandedGrades.add(name + '||' + g));
                }
                saveData();
                setupDivisionButtons();
                renderDivisionDetailPane();
            });
            
            const color = divObj.color || DEFAULT_COLORS[0];
            const bunkCount = (divObj.bunks || []).length;
            const gradeCount = Object.keys(state.campStructure[name]?.grades || {}).length;
            
            card.innerHTML = `
                <div class="division-card-top">
                    <div class="division-pill" style="background-color:${escapeHtml(color)}">
                        ${escapeHtml(name)}
                    </div>
                    <div class="division-color-chip-list" style="background-color:${escapeHtml(color)}"></div>
                </div>
                <div class="division-card-subline">
                    ${gradeCount} grade${gradeCount !== 1 ? 's' : ''} · ${bunkCount} bunk${bunkCount !== 1 ? 's' : ''} · <strong>${totalKids}</strong> camper${totalKids !== 1 ? 's' : ''}
                </div>
            `;
            
            fragment.appendChild(card);
        });
        
        container.appendChild(fragment);
        renderDivisionDetailPane();
    }
    
    function renderDivisionDetailPane() {
        const pane = document.getElementById("division-detail-pane");
        if (!pane) return;
        
        pane.innerHTML = "";
        
        if (!state.selectedDivision || !state.divisions[state.selectedDivision]) {
            pane.innerHTML = `
                <p class="muted">
                    Click a division on the left to set its <strong>times</strong>,
                    manage <strong>grades</strong>, and add <strong>bunks</strong>.
                </p>
            `;
            return;
        }
        
        const divName = state.selectedDivision;
        const divObj = state.divisions[divName];
        const structDiv = state.campStructure[divName] || { grades: {} };
        const color = divObj.color || DEFAULT_COLORS[0];
        
        let totalKids = 0;
        (divObj.bunks || []).forEach(b => { totalKids += state.bunkMetaData[b]?.size || 0; });
        
        const bunkCount = (divObj.bunks || []).length;
        const gradeCount = Object.keys(structDiv.grades || {}).length;
        const timesSummary = divObj.startTime && divObj.endTime
            ? `${divObj.startTime} – ${divObj.endTime}` : "Times not set";
        
        // ====== HEADER ======
        pane.innerHTML = `
            <div class="detail-header" style="display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid #E5E7EB; padding-bottom:8px; margin-bottom:10px; column-gap:12px;">
                <h3 style="margin:0; font-size:1.1rem; font-weight:600; color:#111827;">
                    ${escapeHtml(divName)}
                </h3>
                <button class="delete-division-btn" id="delete-div-btn">Delete Division</button>
            </div>
            
            <div class="division-color-row">
                <span>Division color</span>
                <div style="width:24px; height:24px; border-radius:6px; background-color:${escapeHtml(color)}; border:1px solid rgba(15,23,42,0.12);"></div>
            </div>
            
            <div class="division-edit-shell">
                <div class="division-edit-header">
                    <div class="division-header-left">
                        <span class="division-status-dot" style="background-color:${escapeHtml(color)}; box-shadow:0 0 0 4px ${escapeHtml(color)}33;"></span>
                        <span class="division-name">${escapeHtml(divName)}</span>
                    </div>
                    <div class="division-header-summary">
                        ${gradeCount} grade${gradeCount !== 1 ? 's' : ''} · ${bunkCount} bunk${bunkCount !== 1 ? 's' : ''} · <strong>${totalKids}</strong> campers · ${escapeHtml(timesSummary)}
                    </div>
                </div>
                
                <div class="division-edit-grid">
                    <!-- TIMES CARD -->
                    <div class="division-mini-card">
                        <div class="division-mini-header"><span>Division Times</span></div>
                        <p class="division-mini-help">Set the daily time window this division is in camp.</p>
                        <div style="display:flex; align-items:center; gap:8px; margin-top:4px; flex-wrap:wrap;">
                            <input id="time-start-input" value="${escapeHtml(divObj.startTime || "")}" placeholder="9:00am" style="width:80px; padding:4px 8px; border-radius:8px; border:1px solid #D1D5DB; font-size:0.85rem;">
                            <span style="color:#9CA3AF;">to</span>
                            <input id="time-end-input" value="${escapeHtml(divObj.endTime || "")}" placeholder="4:00pm" style="width:80px; padding:4px 8px; border-radius:8px; border:1px solid #D1D5DB; font-size:0.85rem;">
                            <button id="save-times-btn" style="background:#111827; color:white; border:none; padding:5px 14px; border-radius:8px; font-size:0.8rem; cursor:pointer; font-weight:500;">Save Times</button>
                        </div>
                    </div>
                    
                    <!-- GRADES & BUNKS HIERARCHY -->
                    <div class="division-mini-card">
                        <div class="division-mini-header"><span>Grades & Bunks</span></div>
                        <p class="division-mini-help">Organize bunks within grades. Add grades first, then add bunks to each grade.</p>
                        <div id="grades-hierarchy-container"></div>
                        <div class="add-grade-section">
                            <div class="quick-add-row">
                                <input id="add-grade-input-${escapeHtml(divName)}" placeholder="+ Add grade (e.g. 3rd Grade)" style="flex:1;">
                                <button class="quick-add-btn" id="add-grade-btn">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                                    Add Grade
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        // ====== WIRE UP: Delete Division ======
        pane.querySelector("#delete-div-btn")?.addEventListener("click", () => deleteDivision(divName));

        // ====== WIRE UP: Times ======
        const startInput = pane.querySelector("#time-start-input");
        const endInput = pane.querySelector("#time-end-input");
        const saveTimesBtn = pane.querySelector("#save-times-btn");
        
        const saveTimes = () => {
            divObj.startTime = startInput?.value || "";
            divObj.endTime = endInput?.value || "";
            syncSpine();
            saveData();
            setupDivisionButtons();
            renderDivisionDetailPane();
        };
        
        saveTimesBtn?.addEventListener("click", saveTimes);
        startInput?.addEventListener("keydown", (e) => e.key === "Enter" && saveTimes());
        endInput?.addEventListener("keydown", (e) => e.key === "Enter" && saveTimes());
        
        // ====== WIRE UP: Add Grade ======
        const addGradeBtn = pane.querySelector("#add-grade-btn");
        const addGradeInput = pane.querySelector("#add-grade-input-" + CSS.escape(divName));
        addGradeBtn?.addEventListener("click", () => addGradeToDiv(divName));
        addGradeInput?.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); addGradeToDiv(divName); }
        });
        
        // ====== RENDER GRADES HIERARCHY ======
        renderGradesHierarchy(divName, structDiv);
    }

    /**
     * Render the grades & bunks tree inside the detail pane
     */
    function renderGradesHierarchy(divName, structDiv) {
        const container = document.getElementById("grades-hierarchy-container");
        if (!container) return;

        const grades = structDiv.grades || {};
        const gradeNames = Object.keys(grades).sort();

        if (gradeNames.length === 0) {
            container.innerHTML = '<p style="color:#9CA3AF; font-size:0.82rem; margin:8px 0 0;">No grades yet. Add one below.</p>';
            return;
        }

        container.innerHTML = "";

        gradeNames.forEach(gradeName => {
            const gradeKey = divName + '||' + gradeName;
            const isExpanded = state.expandedGrades.has(gradeKey);
            const bunks = grades[gradeName].bunks || [];

            // --- Grade Block ---
            const block = document.createElement("div");
            block.className = "grade-block-detail";

            // --- Grade Header ---
            const header = document.createElement("div");
            header.className = "grade-header-detail";
            header.innerHTML = `
                <div class="grade-header-left">
                    <svg class="grade-expand-icon ${isExpanded ? '' : 'collapsed'}" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                    <span class="grade-name-label">${escapeHtml(gradeName)}</span>
                    <span class="grade-bunk-count">${bunks.length} bunk${bunks.length !== 1 ? 's' : ''}</span>
                </div>
            `;

            // Delete grade button (in header, right side)
            const delBtn = document.createElement("button");
            delBtn.className = "grade-delete-btn";
            delBtn.title = "Delete grade";
            delBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
            delBtn.addEventListener("click", (e) => { e.stopPropagation(); deleteGrade(divName, gradeName); });
            header.appendChild(delBtn);

            header.addEventListener("click", (e) => {
                if (e.target.closest('.grade-delete-btn')) return;
                toggleDetailGrade(divName, gradeName);
            });

            block.appendChild(header);

            // --- Grade Body (bunks) ---
            const body = document.createElement("div");
            body.className = "grade-body-detail" + (isExpanded ? "" : " collapsed");

            const bunksWrap = document.createElement("div");
            bunksWrap.className = "bunks-wrap";

            bunks.sort(compareBunks).forEach(bunkName => {
                const meta = state.bunkMetaData[bunkName] || { size: 0 };
                const chip = document.createElement("span");
                chip.className = "bunk-chip-detail";
                chip.innerHTML = `
                    ${escapeHtml(bunkName)}
                    <span class="bunk-size-badge">${meta.size || 0}</span>
                    <button class="bunk-chip-x" title="Remove bunk">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                `;
                chip.querySelector(".bunk-chip-x").addEventListener("click", (e) => {
                    e.stopPropagation();
                    deleteBunk(divName, gradeName, bunkName);
                });
                bunksWrap.appendChild(chip);
            });

            body.appendChild(bunksWrap);

            // --- Add Bunk Row ---
            const addRow = document.createElement("div");
            addRow.className = "quick-add-row";
            const addBunkInputId = "add-bunk-input-" + CSS.escape(divName) + "-" + CSS.escape(gradeName);
            addRow.innerHTML = `
                <input id="${addBunkInputId}" placeholder="+ Add bunk" style="flex:1;">
                <button class="quick-add-btn" data-div="${escapeHtml(divName)}" data-grade="${escapeHtml(gradeName)}">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    Add
                </button>
            `;
            addRow.querySelector("button").addEventListener("click", () => addBunkToGrade(divName, gradeName));
            addRow.querySelector("input").addEventListener("keydown", (e) => {
                if (e.key === "Enter") { e.preventDefault(); addBunkToGrade(divName, gradeName); }
            });

            body.appendChild(addRow);
            block.appendChild(body);
            container.appendChild(block);
        });
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
            sportMetaData: state.sportMetaData
        };
        
        window.saveGlobalSettings?.("app1", data);

        // ★ Also save campStructure for cross-page compatibility (Campistry Me)
        window.saveGlobalSettings?.("campStructure", state.campStructure);
        
        updateWindowApp1();
    }
    
    function loadData() {
        const globalData = window.loadGlobalSettings?.() || {};
        const data = globalData.app1 || {};
        const campStructure = globalData.campStructure || {};
        
        try {
            // Preserve any times already saved in app1
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
            
            // ============================================================
            // SOURCE OF TRUTH: campStructure
            // If campStructure exists, use it. Otherwise migrate from flat.
            // ============================================================
            if (Object.keys(campStructure).length > 0) {
                console.log("[app1] Loading from campStructure");
                state.campStructure = deepClone(campStructure);
            } else if (data.divisions && Object.keys(data.divisions).length > 0) {
                console.log("[app1] Migrating flat divisions to campStructure");
                state.campStructure = migrateToStructure(data.divisions);
            } else {
                const globalDivisions = window.getGlobalDivisions?.() || {};
                if (Object.keys(globalDivisions).length > 0) {
                    state.campStructure = migrateToStructure(globalDivisions);
                } else {
                    state.campStructure = {};
                }
            }

            // Build flat divisions from campStructure
            const meBasedDivisions = {};
            const allBunks = [];
            
            Object.entries(state.campStructure).forEach(([divName, divData]) => {
                if (typeof divData !== 'object' || divData === null) return;
                const bunks = [];
                Object.values(divData.grades || {}).forEach(grade => {
                    (grade.bunks || []).forEach(b => {
                        bunks.push(b);
                        if (!allBunks.includes(b)) allBunks.push(b);
                    });
                });
                sortBunksInPlace(bunks);
                
                const times = existingTimes[divName] || {};
                meBasedDivisions[divName] = {
                    startTime: times.startTime || "",
                    endTime: times.endTime || "",
                    bunks: bunks,
                    color: divData.color || getNextUniqueDivisionColor(meBasedDivisions)
                };
            });
            
            state.divisions = meBasedDivisions;
            state.bunks = allBunks;

            // Update derived state
            state.availableDivisions = Object.keys(state.divisions);
            state.specialActivities = data.specialActivities || [];
            state.bunkMetaData = data.bunkMetaData || {};
            state.sportMetaData = data.sportMetaData || {};
            state.selectedDivision = data.selectedDivision || state.availableDivisions[0] || null;
            state.allSports = Array.isArray(data.allSports) ? data.allSports : [...DEFAULT_SPORTS];
            state.savedSkeletons = data.savedSkeletons || {};
            state.skeletonAssignments = data.skeletonAssignments || {};
            
            // Compute bunk sizes from camperRoster if available
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

            // Auto-expand all divisions on first load
            Object.keys(state.campStructure).forEach(d => state.expandedDivisions.add(d));
            
            updateWindowApp1();
            
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
            get sportMetaData() { return state.sportMetaData; }
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
        
        // ★ v5.0: Re-enable division input (no longer hidden)
        const divisionInput = document.getElementById("divisionInput");
        const addDivisionBtn = document.getElementById("addDivisionBtn");
        
        // Wire up the Add Division button
        if (addDivisionBtn) {
            const newBtn = addDivisionBtn.cloneNode(true);
            addDivisionBtn.parentNode.replaceChild(newBtn, addDivisionBtn);
            newBtn.addEventListener("click", addDivision);
        }
        if (divisionInput) {
            divisionInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter") { e.preventDefault(); addDivision(); }
            });
        }
        
        // Hide the enable color toggle (auto-managed)
        const enableColor = document.getElementById("enableColor");
        if (enableColor) {
            const label = enableColor.closest('label');
            if (label) label.style.display = 'none';
        }
        
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
        
        console.log(`[app1] v${VERSION} initialized - inline division/grade/bunk management`);
    }

    // ==================== WINDOW EXPORTS ====================
    
    window.initApp1 = initApp1;
    
    // Getters
    window.getDivisions = () => state.divisions;
    window.getBunkMetaData = () => state.bunkMetaData;
    window.getSportMetaData = () => state.sportMetaData;
    window.getGlobalSpecialActivities = () => state.specialActivities;
    window.getAllGlobalSports = () => [...state.allSports].sort();
    window.getSavedSkeletons = () => state.savedSkeletons || {};
    window.getSkeletonAssignments = () => state.skeletonAssignments || {};
    window.getCampStructure = () => state.campStructure;
    
    // Setters
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
    
    // ★ v5.0: addDivisionBunk now works again (adds to Default grade)
    window.addDivisionBunk = (divName, bunkName) => {
        if (!divName || !bunkName || !state.campStructure[divName]) return false;
        const struct = state.campStructure[divName];
        if (!struct.grades) struct.grades = {};
        // Add to 'Default' grade if no grades exist
        const targetGrade = Object.keys(struct.grades).length > 0 
            ? Object.keys(struct.grades)[0] 
            : 'Default';
        if (!struct.grades[targetGrade]) struct.grades[targetGrade] = { bunks: [] };
        if (struct.grades[targetGrade].bunks.includes(bunkName)) return false;
        struct.grades[targetGrade].bunks.push(bunkName);
        rebuildFlatDivisions();
        saveData();
        setupDivisionButtons();
        renderDivisionDetailPane();
        return true;
    };
    
    // Color utilities
    window.getNextDivisionColor = getNextDivisionColor;
    window.getNextUniqueDivisionColor = getNextUniqueDivisionColor;
    window.getColorIndex = getColorIndex;
    window.incrementColorIndex = () => setColorIndex(getColorIndex() + 1);
    
    // Initialize window.app1 with getters
    updateWindowApp1();

})();
