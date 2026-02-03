// =================================================================
// app1.js — MERGED: Beta Camper Roster + Published SyncSpine
//
// THEME: Modern Pro Camp (Emerald/White)
// VERSION: 4.0 - Divisions/Bunks sourced from Campistry Me
// 
// v4.0 CHANGES:
// - Divisions & bunks are READ-ONLY (managed in Campistry Me)
// - loadData() reads from campStructure (Campistry Me) as source of truth
// - CSV import removed (use Campistry Me instead)
// - Division/bunk add/edit/delete removed
// - Times still editable per division
// - All window exports preserved for scheduler compatibility
// =================================================================
(function () {
    "use strict";
    
    // ==================== CONSTANTS ====================
    const VERSION = "4.0";
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
    // Using a state object to avoid stale reference issues
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
        skeletonAssignments: {}
    };

    // ==================== UTILITIES ====================
    
    /**
     * Deep clone an object safely
     */
    function deepClone(obj) {
        if (obj === null || obj === undefined) return obj;
        try {
            return structuredClone(obj);
        } catch {
            return JSON.parse(JSON.stringify(obj));
        }
    }
    
    /**
     * Debounce function calls
     */
    function debounce(fn, delay = DEBOUNCE_MS) {
        let timeoutId;
        return function (...args) {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => fn.apply(this, args), delay);
        };
    }
    
    /**
     * Safe property access
     */
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
    
    /**
     * Parse time string to minutes
     */
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
    
    /**
     * Compare bunks for sorting (natural sort)
     */
    function compareBunks(a, b) {
        const strA = String(a ?? "");
        const strB = String(b ?? "");
        return strA.localeCompare(strB, undefined, { numeric: true, sensitivity: "base" });
    }
    
    /**
     * Sort bunks array in place
     */
    function sortBunksInPlace(arr) {
        if (!Array.isArray(arr)) return;
        arr.sort(compareBunks);
    }
    
    /**
     * Escape HTML to prevent XSS
     */
    function escapeHtml(str) {
        if (!str) return "";
        const div = document.createElement("div");
        div.textContent = str;
        return div.innerHTML;
    }

    // ==================== SYNC SPINE ====================
    
    /**
     * Sync state to global authority - call after ANY state mutation
     */
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
            Object.values(divisionsObj || {})
                .map(d => d?.color)
                .filter(Boolean)
        );
        
        const startIndex = getColorIndex();
        
        // Try to find unused color
        for (let i = 0; i < DEFAULT_COLORS.length; i++) {
            const index = (startIndex + i) % DEFAULT_COLORS.length;
            const color = DEFAULT_COLORS[index];
            if (!usedColors.has(color)) {
                setColorIndex(index + 1);
                return color;
            }
        }
        
        // All colors used - cycle through
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
            
            .division-header-left .division-name {
                cursor: text;
            }
            
            .division-status-dot {
                width: 11px;
                height: 11px;
                border-radius: 999px;
                background: #00C896;
                box-shadow: 0 0 0 4px rgba(0, 200, 150, 0.25);
            }
            
            .division-header-summary {
                font-size: 0.8rem;
                color: #6B7280;
                text-align: right;
                white-space: nowrap;
            }
            
            .division-edit-grid {
                display: flex;
                flex-wrap: wrap;
                gap: 20px;
                margin-top: 6px;
            }
            
            .division-mini-card {
                flex: 1 1 280px;
                border-radius: 16px;
                background: #FFFFFF;
                border: 1px solid #E5E7EB;
                padding: 12px 14px 14px;
                box-shadow: 0 8px 20px rgba(15, 23, 42, 0.05);
            }
            
            .division-mini-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 8px;
                padding-bottom: 6px;
                font-size: 0.78rem;
                text-transform: uppercase;
                letter-spacing: 0.06em;
                color: #6B7280;
                font-weight: 600;
                border-bottom: 1px solid rgba(148, 163, 184, 0.4);
            }
            
            .division-mini-pill {
                padding: 4px 12px;
                border-radius: 999px;
                background: #ECFDF5;
                color: #047857;
                font-size: 0.7rem;
                border: none;
                cursor: default;
                font-weight: 500;
                box-shadow: 0 4px 10px rgba(16, 185, 129, 0.35);
            }
            
            .division-mini-help {
                margin: 0 0 10px;
                font-size: 0.78rem;
                color: #6B7280;
                max-width: 340px;
            }
            
            .division-color-row {
                display: flex;
                align-items: center;
                gap: 10px;
                margin: 6px 0 16px;
                font-size: 0.8rem;
                color: #4B5563;
            }
            
            .division-color-row input[type="color"] {
                -webkit-appearance: none;
                appearance: none;
                width: 68px;
                height: 26px;
                padding: 0;
                border-radius: 999px;
                border: 1px solid #E5E7EB;
                background: #FFFFFF;
                overflow: hidden;
                box-shadow: 0 4px 10px rgba(15, 23, 42, 0.12);
                cursor: pointer;
            }
            
            .division-color-row input[type="color"]::-webkit-color-swatch {
                border: none;
                border-radius: 999px;
                padding: 0;
            }
            
            .division-bunk-pill {
                padding: 4px 10px;
                border-radius: 999px;
                border: 1px solid #D1D5DB;
                background: #FFFFFF;
                color: #374151;
                font-size: 0.8rem;
                cursor: pointer;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                min-width: 28px;
                box-shadow: 0 1px 3px rgba(15, 23, 42, 0.1);
                transition: all 0.12s ease;
                user-select: none;
            }
            
            .division-bunk-pill:hover {
                background-color: #F3F4F6;
                box-shadow: 0 3px 8px rgba(15, 23, 42, 0.14);
                transform: translateY(-0.5px);
            }
            
            .bunk-size-badge {
                background: #ECFDF5;
                color: #047857;
                border-radius: 6px;
                padding: 1px 5px;
                font-size: 0.7rem;
                font-weight: 600;
                border: 1px solid #A7F3D0;
            }
            
            .bunk-edit-form {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 3px 6px;
                border-radius: 999px;
                border: 1px solid #00C896;
                background: #FFFFFF;
                box-shadow: 0 2px 8px rgba(0, 200, 150, 0.15);
            }
            
            .bunk-edit-input {
                border: 1px solid #E5E7EB;
                outline: none;
                padding: 3px 6px;
                width: 80px;
                font-size: 0.85rem;
                border-radius: 4px;
            }
            
            .bunk-edit-input:focus {
                border-color: #00C896;
                box-shadow: 0 0 0 2px rgba(0, 200, 150, 0.2);
            }
            
            .bunk-edit-size {
                width: 65px;
                border: 1px solid #E5E7EB;
                border-radius: 4px;
                text-align: center;
                font-size: 0.85rem;
                padding: 3px 2px;
            }
            
            .bunk-edit-size:focus {
                border-color: #00C896;
                box-shadow: 0 0 0 2px rgba(0, 200, 150, 0.2);
            }
            
            .bunk-edit-save {
                background: #00C896;
                color: white;
                border: none;
                border-radius: 50%;
                width: 24px;
                height: 24px;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 0.8rem;
                cursor: pointer;
                flex-shrink: 0;
                transition: background 0.15s ease;
            }
            
            .bunk-edit-save:hover {
                background: #00A67C;
            }
            
            .bulk-card {
                border: 1px solid #E5E7EB;
                border-radius: 16px;
                padding: 18px 24px;
                background: #FFFFFF;
                box-shadow: 0 4px 14px rgba(0, 0, 0, 0.04);
                margin-bottom: 24px;
                width: 100%;
                box-sizing: border-box;
            }
            
            .muted {
                color: #6B7280;
                font-size: 0.86rem;
            }
            
            /* Delete confirmation styling */
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

    // ==================== BUNK OPERATIONS ====================
    // Bunks are now managed in Campistry Me - these are kept as no-ops for compatibility

    // ==================== CSV / BULK IMPORT ====================
    // CSV import removed - use Campistry Me for data import
    
    /**
     * Render a "Campistry Me" link banner at top of setup (replaces CSV import UI)
     */
    function renderCampistryMeLink() {
        if (document.getElementById("me-link-banner")) return;
        
        const grid = document.querySelector(".setup-grid");
        const target = grid || document.getElementById("division-detail-pane")?.parentNode;
        if (!target) return;
        
        const card = document.createElement("section");
        card.className = "setup-card setup-card-wide bulk-card";
        card.id = "me-link-banner";
        
        card.innerHTML = `
            <div style="display:flex; align-items:center; justify-content:space-between; gap:20px; flex-wrap:wrap;">
                <div style="flex:1; min-width:200px;">
                    <h3 style="margin:0; font-size:1.1rem; color:#111827; display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                        Camp Setup & Configuration
                        <span style="font-size:0.7rem; background:#8A5DFF; color:white; padding:2px 8px; border-radius:999px;">Step 1</span>
                    </h3>
                    <p class="muted" style="margin:4px 0 0;">
                        Divisions, grades, bunks &amp; campers are managed in <a href="campistry_me.html" style="color:#7C3AED; font-weight:600;">Campistry Me</a>. Configure <strong>times</strong> and <strong>scheduling settings</strong> here.
                    </p>
                </div>
                <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                    <a href="campistry_me.html" style="background:#7C3AED; color:white; border:none; padding:8px 18px; border-radius:999px; font-size:0.85rem; cursor:pointer; font-weight:600; text-decoration:none; transition:all 0.15s ease;">
                        Open Campistry Me
                    </a>
                </div>
            </div>
        `;
        
        target.prepend(card);
    }

    // ==================== DIVISION OPERATIONS ====================
    // Divisions are now managed in Campistry Me - editing removed

    // ==================== UI RENDERING ====================
    
    function setupDivisionButtons() {
        const container = document.getElementById("divisionButtons");
        if (!container) return;
        
        container.innerHTML = "";
        
        if (!state.availableDivisions?.length) {
            container.innerHTML = `
                <p class="muted">
                    No divisions yet. <a href="campistry_me.html" style="color:#7C3AED; font-weight:600;">Open Campistry Me</a> to create divisions, grades, and bunks.
                </p>
            `;
            renderDivisionDetailPane();
            return;
        }
        
        // Use DocumentFragment for better performance
        const fragment = document.createDocumentFragment();
        
        state.availableDivisions.forEach((name) => {
            const divObj = state.divisions[name];
            if (!divObj) return;
            
            // Calculate total campers
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
                saveData();
                setupDivisionButtons();
                renderDivisionDetailPane();
            });
            
            const color = divObj.color || DEFAULT_COLORS[0];
            const bunkCount = (divObj.bunks || []).length;
            
            card.innerHTML = `
                <div class="division-card-top">
                    <div class="division-pill" style="background-color:${escapeHtml(color)}">
                        ${escapeHtml(name)}
                    </div>
                    <div class="division-color-chip-list" style="background-color:${escapeHtml(color)}"></div>
                </div>
                <div class="division-card-subline">
                    ${bunkCount} bunks • <strong>${totalKids}</strong> campers
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
                    Click a division on the left to set its <strong>times</strong> 
                    and view its <strong>bunks</strong>.
                </p>
            `;
            return;
        }
        
        const divObj = state.divisions[state.selectedDivision];
        const color = divObj.color || DEFAULT_COLORS[0];
        
        // Calculate totals
        let totalKids = 0;
        (divObj.bunks || []).forEach(b => {
            totalKids += state.bunkMetaData[b]?.size || 0;
        });
        
        const bunkCount = (divObj.bunks || []).length;
        const timesSummary = divObj.startTime && divObj.endTime
            ? `${divObj.startTime} – ${divObj.endTime}`
            : "Times not set";
        
        // Build the pane - read-only for divisions/bunks, editable for times
        pane.innerHTML = `
            <div class="detail-header" style="display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid #E5E7EB; padding-bottom:8px; margin-bottom:10px; column-gap:12px;">
                <h3 style="margin:0; font-size:1rem; font-weight:600; color:#111827;">
                    Division Details
                </h3>
            </div>
            
            <div class="division-color-row">
                <span>Division color</span>
                <div style="width:24px; height:24px; border-radius:6px; background-color:${escapeHtml(color)}; border:1px solid rgba(15,23,42,0.12);"></div>
            </div>
            
            <div class="division-edit-shell">
                <div class="division-edit-header">
                    <div class="division-header-left">
                        <span class="division-status-dot" style="background-color:${escapeHtml(color)}; box-shadow:0 0 0 4px ${escapeHtml(color)}33;"></span>
                        <span class="division-name">${escapeHtml(state.selectedDivision)}</span>
                    </div>
                    <div class="division-header-summary">
                        ${bunkCount} bunks • <strong>${totalKids}</strong> campers • ${escapeHtml(timesSummary)}
                    </div>
                </div>
                
                <div class="division-edit-grid">
                    <div class="division-mini-card">
                        <div class="division-mini-header"><span>Division Times</span></div>
                        <p class="division-mini-help">Set the daily time window this division is in camp.</p>
                        <div style="display:flex; align-items:center; gap:8px; margin-top:4px; flex-wrap:wrap;">
                            <input id="time-start-input" value="${escapeHtml(divObj.startTime || "")}" placeholder="9:00am" style="width:80px; padding:4px 8px; border-radius:999px; border:1px solid #D1D5DB; font-size:0.85rem;">
                            <span class="muted">to</span>
                            <input id="time-end-input" value="${escapeHtml(divObj.endTime || "")}" placeholder="4:00pm" style="width:80px; padding:4px 8px; border-radius:999px; border:1px solid #D1D5DB; font-size:0.85rem;">
                            <button id="save-times-btn" style="background:#00C896; color:white; border:none; padding:4px 12px; border-radius:999px; font-weight:600; cursor:pointer; transition:background 0.15s ease;">
                                Save
                            </button>
                        </div>
                    </div>
                    
                    <div class="division-mini-card">
                        <div class="division-mini-header"><span>Bunks in this Division</span></div>
                        <p class="division-mini-help">
                            Bunks are managed in <a href="campistry_me.html" style="color:#7C3AED; font-weight:600;">Campistry Me</a>.
                        </p>
                        <div id="bunk-list" style="margin-top:6px; display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px;"></div>
                    </div>
                </div>
            </div>
        `;
        
        // Time inputs (still editable)
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
        
        // Bunk list (read-only pills)
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
            sportMetaData: state.sportMetaData
        };
        
        window.saveGlobalSettings?.("app1", data);
        
        // Update window.app1 reference
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
            // SOURCE OF TRUTH: campStructure from Campistry Me
            // Flatten grades → bunks for app1's flat division format
            // Merge with app1's own times (startTime/endTime)
            // ============================================================
            if (Object.keys(campStructure).length > 0) {
                console.log("[app1] Loading divisions from Campistry Me campStructure");
                const meBasedDivisions = {};
                const allBunks = [];
                
                Object.entries(campStructure).forEach(([divName, divData]) => {
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
                
            } else {
                // Fallback: use global authority > app1 data > empty
                console.log("[app1] No campStructure found, falling back to app1/global data");
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
                
                // Validate and fix division data
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
            }
            
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
            
            // Update window.app1
            updateWindowApp1();
            
        } catch (e) {
            console.error("Error loading app1 data:", e);
        }
    }
    
    /**
     * Update the window.app1 object with current state
     * Called after any state change to keep references fresh
     */
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
        
        // Fix #2 - 🔴 CRITICAL: State/Window Sync
        // Keep window references as direct references (not copies)
        // so external code mutations are reflected in state
        window.divisions = state.divisions;
        window.availableDivisions = state.availableDivisions;
        window.bunks = state.bunks;
        window.allSports = state.allSports;
    }

    // ==================== INITIALIZATION ====================
    
    function initApp1() {
        ensureSharedSetupStyles();
        
        // Load data first
        loadData();
        
        // Hide the division input row (now managed in Campistry Me)
        const divisionInput = document.getElementById("divisionInput");
        const addDivisionBtn = document.getElementById("addDivisionBtn");
        if (divisionInput) {
            const fieldRow = divisionInput.closest('.setup-field-row');
            if (fieldRow) fieldRow.style.display = 'none';
        }
        if (addDivisionBtn && !divisionInput) {
            const fieldRow = addDivisionBtn.closest('.setup-field-row');
            if (fieldRow) fieldRow.style.display = 'none';
        }
        
        // Hide the enable color toggle
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
        
        // --- 🟢 Wire up the Erase All Button ---
        const eraseAllBtn = document.getElementById("eraseAllBtn");
        if (eraseAllBtn) {
            // Remove old listeners by cloning
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
                            // Fallback if bridge isn't loaded
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
        renderCampistryMeLink();
        
        console.log(`[app1] v${VERSION} initialized - divisions sourced from Campistry Me`);
    }

    // ==================== WINDOW EXPORTS ====================
    
    // Core initialization
    window.initApp1 = initApp1;
    
    // Getters that always return current state
    window.getDivisions = () => state.divisions;
    window.getBunkMetaData = () => state.bunkMetaData;
    window.getSportMetaData = () => state.sportMetaData;
    window.getGlobalSpecialActivities = () => state.specialActivities;
    window.getAllGlobalSports = () => [...state.allSports].sort();
    window.getSavedSkeletons = () => state.savedSkeletons || {};
    window.getSkeletonAssignments = () => state.skeletonAssignments || {};
    
    // Setters
    window.addGlobalSport = (sportName) => {
        if (!sportName) return;
        const s = sportName.trim();
        if (s && !state.allSports.find(sp => sp.toLowerCase() === s.toLowerCase())) {
            state.allSports.push(s);
            saveData();
        }
    };

    // Fix #1 - 🟠 HIGH: Missing removeGlobalSport Export
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
    
    // Legacy export - now a no-op since bunks managed in Campistry Me
    window.addDivisionBunk = (divName, bunkName) => {
        console.warn("[app1] addDivisionBunk is deprecated - manage bunks in Campistry Me");
        return false;
    };
    
    // Color utilities
    window.getNextDivisionColor = getNextDivisionColor;
    window.getNextUniqueDivisionColor = getNextUniqueDivisionColor;
    window.getColorIndex = getColorIndex;
    window.incrementColorIndex = () => setColorIndex(getColorIndex() + 1);
    
    // Initialize window.app1 with getters
    updateWindowApp1();

})();
