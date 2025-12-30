// =================================================================
// app1.js — MERGED: Beta Camper Roster + Published SyncSpine
//
// THEME: Modern Pro Camp (Emerald/White)
// VERSION: 3.1 - Wired "Erase All" to Cloud Bridge
// 
// FIXES APPLIED:
// - Fixed stale window reference issues (divisions/bunks)
// - Consistent syncSpine() calls on all mutations
// - Proper double-click handling (no race conditions)
// - Debounced color picker
// - Improved CSV parsing with proper quote handling
// - Added input validation and error handling
// - Eliminated memory leaks from event handlers
// - Centralized constants and configuration
// - Optimized DOM operations
// - Added proper null checks throughout
// =================================================================
(function () {
    "use strict";
    
    // ==================== CONSTANTS ====================
    const VERSION = "3.1";
    const CLICK_DELAY_MS = 300;
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

    // ==================== EDITABLE ELEMENTS ====================
    
    /**
     * Make an element editable on double-click
     * Returns cleanup function
     */
    function makeEditable(el, onSave) {
        if (!el) return () => {};
        
        const handleDblClick = (e) => {
            e.stopPropagation();
            
            const oldValue = el.textContent;
            const input = document.createElement("input");
            input.type = "text";
            input.value = oldValue;
            input.className = "bunk-edit-input";
            input.style.width = Math.max(80, el.offsetWidth + 20) + "px";
            
            const finalize = (save = true) => {
                const newValue = input.value.trim();
                if (save && newValue && newValue !== oldValue) {
                    onSave(newValue);
                }
                el.textContent = newValue || oldValue;
                if (input.parentNode) {
                    input.replaceWith(el);
                }
            };
            
            input.addEventListener("blur", () => finalize(true));
            input.addEventListener("keydown", (ev) => {
                if (ev.key === "Enter") {
                    ev.preventDefault();
                    finalize(true);
                } else if (ev.key === "Escape") {
                    ev.preventDefault();
                    finalize(false);
                }
            });
            
            el.replaceWith(input);
            input.focus();
            input.select();
        };
        
        el.addEventListener("dblclick", handleDblClick);
        
        // Return cleanup function
        return () => el.removeEventListener("dblclick", handleDblClick);
    }

    // ==================== BUNK OPERATIONS ====================
    
    function renameBunkEverywhere(oldName, newName, newSize) {
        const trimmedName = (newName || "").trim();
        if (!trimmedName) return false;
        
        const sizeVal = Math.max(0, parseInt(newSize, 10) || DEFAULT_BUNK_SIZE);
        
        // Size-only change
        if (trimmedName === oldName) {
            if (!state.bunkMetaData[trimmedName]) {
                state.bunkMetaData[trimmedName] = {};
            }
            state.bunkMetaData[trimmedName].size = sizeVal;
            saveData();
            renderDivisionDetailPane();
            window.updateTable?.();
            return true;
        }
        
        // Check for duplicate name
        const exists = state.bunks.some(
            b => b.toLowerCase() === trimmedName.toLowerCase() && b !== oldName
        );
        
        if (exists) {
            alert("Bunk name already exists.");
            return false;
        }
        
        // Update bunks array
        const bunkIdx = state.bunks.indexOf(oldName);
        if (bunkIdx !== -1) {
            state.bunks[bunkIdx] = trimmedName;
        }
        
        // Update all divisions
        Object.values(state.divisions).forEach((div) => {
            if (!div || !Array.isArray(div.bunks)) return;
            const idx = div.bunks.indexOf(oldName);
            if (idx !== -1) {
                div.bunks[idx] = trimmedName;
                sortBunksInPlace(div.bunks);
            }
        });
        
        // Update schedule assignments if they exist
        if (window.scheduleAssignments?.[oldName]) {
            window.scheduleAssignments[trimmedName] = window.scheduleAssignments[oldName];
            delete window.scheduleAssignments[oldName];
            window.saveCurrentDailyData?.("scheduleAssignments", window.scheduleAssignments);
        }
        
        // Update metadata
        state.bunkMetaData[trimmedName] = { size: sizeVal };
        delete state.bunkMetaData[oldName];
        
        syncSpine();
        saveData();
        renderDivisionDetailPane();
        window.updateTable?.();
        
        return true;
    }
    
    function deleteBunkFromDivision(divName, bunkName) {
        const div = state.divisions[divName];
        if (!div || !Array.isArray(div.bunks)) return false;
        
        const idx = div.bunks.indexOf(bunkName);
        if (idx === -1) return false;
        
        div.bunks.splice(idx, 1);
        syncSpine();
        saveData();
        renderDivisionDetailPane();
        window.updateTable?.();
        
        return true;
    }
    
    function addBunkToDivision(divName, bunkName) {
        if (!divName || !bunkName) return false;
        
        const cleanDiv = String(divName).trim();
        const cleanBunk = String(bunkName).trim();
        
        if (!cleanDiv || !cleanBunk) return false;
        
        // Add to global bunks if not exists
        if (!state.bunks.includes(cleanBunk)) {
            state.bunks.push(cleanBunk);
        }
        
        // Add to division
        const div = state.divisions[cleanDiv];
        if (div && !div.bunks.includes(cleanBunk)) {
            div.bunks.push(cleanBunk);
            sortBunksInPlace(div.bunks);
        }
        
        // Initialize metadata
        if (!state.bunkMetaData[cleanBunk]) {
            state.bunkMetaData[cleanBunk] = { size: DEFAULT_BUNK_SIZE };
        }
        
        syncSpine();
        saveData();
        renderDivisionDetailPane();
        window.updateTable?.();
        
        return true;
    }

    // ==================== CSV / BULK IMPORT ====================
    
    /**
     * Parse CSV line handling quoted fields properly
     */
    function parseCSVLine(line) {
        const result = [];
        let current = "";
        let inQuotes = false;
        
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            const nextChar = line[i + 1];
            
            if (inQuotes) {
                if (char === '"' && nextChar === '"') {
                    // Escaped quote
                    current += '"';
                    i++;
                } else if (char === '"') {
                    inQuotes = false;
                } else {
                    current += char;
                }
            } else {
                if (char === '"') {
                    inQuotes = true;
                } else if (char === ',') {
                    result.push(current.trim());
                    current = "";
                } else {
                    current += char;
                }
            }
        }
        
        result.push(current.trim());
        return result;
    }
    
    function downloadTemplate() {
        const lines = ["Division,Bunk Name,Camper Name OR Count"];
        
        if (state.availableDivisions.length === 0) {
            lines.push(
                '"Junior","Bunk 1",12',
                '"Junior","Bunk 2","Moshe Cohen"',
                '"Senior","Bunk A","David Levy"'
            );
        } else {
            state.availableDivisions.forEach(divName => {
                const div = state.divisions[divName];
                if (!div) return;
                
                if (div.bunks?.length > 0) {
                    div.bunks.forEach(bunk => {
                        lines.push(`"${divName}","${bunk}","(Enter Name or Count)"`);
                    });
                } else {
                    lines.push(`"${divName}","",`);
                }
            });
        }
        
        const csv = lines.join("\n");
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        
        const link = document.createElement("a");
        link.href = url;
        link.download = "camp_roster_template.csv";
        link.style.display = "none";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }
    
    function handleBulkImport(file) {
        if (!file) return;
        
        const reader = new FileReader();
        
        reader.onerror = () => {
            alert("Error reading file. Please try again.");
        };
        
        reader.onload = (e) => {
            const text = e.target.result;
            const lines = text.split(/\r?\n/);
            
            let stats = {
                addedDivs: 0,
                addedBunks: 0,
                updatedSizes: 0,
                addedCampers: 0
            };
            
            // Load existing roster
            const globalSettings = window.loadGlobalSettings?.() || {};
            const app1Data = globalSettings.app1 || {};
            const camperRoster = app1Data.camperRoster || {};
            const bunkCounts = {};
            
            // Skip header row
            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;
                
                const parts = parseCSVLine(line);
                if (parts.length < 2) continue;
                
                const divName = parts[0];
                const bunkName = parts[1];
                const thirdCol = parts[2] || "";
                
                if (!divName) continue;
                
                // Add division if new
                if (!state.availableDivisions.includes(divName)) {
                    state.availableDivisions.push(divName);
                    state.divisions[divName] = {
                        bunks: [],
                        color: getNextUniqueDivisionColor(state.divisions),
                        startTime: "",
                        endTime: ""
                    };
                    stats.addedDivs++;
                }
                
                // Add bunk if specified
                if (bunkName) {
                    if (!state.bunks.includes(bunkName)) {
                        state.bunks.push(bunkName);
                        stats.addedBunks++;
                    }
                    
                    const div = state.divisions[divName];
                    if (div && !div.bunks.includes(bunkName)) {
                        div.bunks.push(bunkName);
                        sortBunksInPlace(div.bunks);
                    }
                    
                    // Handle third column (size or camper name)
                    if (thirdCol) {
                        const asNum = parseInt(thirdCol, 10);
                        const isNumeric = !isNaN(asNum) && 
                            String(asNum) === thirdCol.trim();
                        
                        if (isNumeric) {
                            if (!state.bunkMetaData[bunkName]) {
                                state.bunkMetaData[bunkName] = {};
                            }
                            state.bunkMetaData[bunkName].size = asNum;
                            stats.updatedSizes++;
                        } else if (thirdCol.length > 1 && 
                                   !thirdCol.startsWith("(")) {
                            // Treat as camper name
                            camperRoster[thirdCol] = {
                                division: divName,
                                bunk: bunkName,
                                team: ""
                            };
                            stats.addedCampers++;
                            
                            bunkCounts[bunkName] = (bunkCounts[bunkName] || 0) + 1;
                        }
                    }
                }
            }
            
            // Update sizes from camper counts
            Object.entries(bunkCounts).forEach(([bunk, count]) => {
                if (!state.bunkMetaData[bunk]) {
                    state.bunkMetaData[bunk] = {};
                }
                state.bunkMetaData[bunk].size = count;
            });
            
            // Save roster to global storage
            const currentGlobal = window.loadGlobalSettings?.() || {};
            if (!currentGlobal.app1) currentGlobal.app1 = {};
            currentGlobal.app1.camperRoster = camperRoster;
            window.saveGlobalSettings?.("app1", currentGlobal.app1);
            
            syncSpine();
            saveData();
            setupDivisionButtons();
            renderDivisionDetailPane();
            
            alert(
                `Import Complete!\n` +
                `Added Divisions: ${stats.addedDivs}\n` +
                `Added Bunks: ${stats.addedBunks}\n` +
                `Updated Metadata: ${stats.updatedSizes}\n` +
                `Campers Imported: ${stats.addedCampers}`
            );
        };
        
        reader.readAsText(file);
    }
    
    function renderBulkImportUI() {
        if (document.getElementById("bulk-data-card")) return;
        
        const grid = document.querySelector(".setup-grid");
        const target = grid || document.getElementById("division-detail-pane")?.parentNode;
        if (!target) return;
        
        const card = document.createElement("section");
        card.className = "setup-card setup-card-wide bulk-card";
        card.id = "bulk-data-card";
        
        card.innerHTML = `
            <div style="display:flex; align-items:center; justify-content:space-between; gap:20px; flex-wrap:wrap;">
                <div style="flex:1; min-width:200px;">
                    <h3 style="margin:0; font-size:1.1rem; color:#111827; display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                        Camp Setup & Configuration
                        <span style="font-size:0.7rem; background:#8A5DFF; color:white; padding:2px 8px; border-radius:999px;">Step 1</span>
                    </h3>
                    <p class="muted" style="margin:4px 0 0;">
                        Import data via CSV (Divisions, Bunks, Camper Names) or add manually below.
                    </p>
                </div>
                <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                    <button id="btn-download-template" style="background:white; border:1px solid #D1D5DB; padding:8px 16px; border-radius:999px; font-size:0.85rem; cursor:pointer; transition:all 0.15s ease;">
                        Template
                    </button>
                    <button id="btn-trigger-upload" style="background:#0094FF; color:white; border:none; padding:8px 18px; border-radius:999px; font-size:0.85rem; cursor:pointer; font-weight:600; transition:all 0.15s ease;">
                        Upload CSV
                    </button>
                    <input type="file" id="bulk-upload-input" accept=".csv" style="display:none;">
                </div>
            </div>
        `;
        
        target.prepend(card);
        
        // Event listeners
        const downloadBtn = card.querySelector("#btn-download-template");
        const uploadBtn = card.querySelector("#btn-trigger-upload");
        const uploadInput = card.querySelector("#bulk-upload-input");
        
        downloadBtn.addEventListener("click", downloadTemplate);
        
        uploadBtn.addEventListener("click", () => uploadInput.click());
        
        uploadInput.addEventListener("change", (e) => {
            if (e.target.files?.length > 0) {
                handleBulkImport(e.target.files[0]);
                e.target.value = "";
            }
        });
        
        // Hover effects
        downloadBtn.addEventListener("mouseenter", () => {
            downloadBtn.style.backgroundColor = "#F9FAFB";
        });
        downloadBtn.addEventListener("mouseleave", () => {
            downloadBtn.style.backgroundColor = "white";
        });
        
        uploadBtn.addEventListener("mouseenter", () => {
            uploadBtn.style.backgroundColor = "#0084E8";
        });
        uploadBtn.addEventListener("mouseleave", () => {
            uploadBtn.style.backgroundColor = "#0094FF";
        });
    }

    // ==================== DIVISION OPERATIONS ====================
    
    function addDivision() {
        const input = document.getElementById("divisionInput");
        const name = (input?.value || "").trim();
        
        if (!name) return;
        
        if (state.availableDivisions.includes(name)) {
            alert("That division already exists.");
            input.value = "";
            return;
        }
        
        const color = getNextUniqueDivisionColor(state.divisions);
        
        state.availableDivisions.push(name);
        state.divisions[name] = {
            bunks: [],
            color: color,
            startTime: "",
            endTime: ""
        };
        
        state.selectedDivision = name;
        input.value = "";
        
        syncSpine();
        saveData();
        setupDivisionButtons();
        renderDivisionDetailPane();
        window.initLeaguesTab?.();
        window.updateTable?.();
    }
    
    function deleteDivision(divName) {
        if (!confirm(`Delete division "${divName}"?`)) return;
        
        delete state.divisions[divName];
        
        const idx = state.availableDivisions.indexOf(divName);
        if (idx !== -1) {
            state.availableDivisions.splice(idx, 1);
        }
        
        state.selectedDivision = state.availableDivisions[0] || null;
        
        syncSpine();
        saveData();
        setupDivisionButtons();
        renderDivisionDetailPane();
        window.initLeaguesTab?.();
        window.updateTable?.();
    }
    
    function renameDivision(oldName, newName) {
        const trimmed = newName.trim();
        
        if (!trimmed || trimmed === oldName) return false;
        
        if (state.divisions[trimmed]) {
            alert("A division with that name already exists.");
            return false;
        }
        
        // Move division data
        state.divisions[trimmed] = state.divisions[oldName];
        delete state.divisions[oldName];
        
        // Update available divisions
        const idx = state.availableDivisions.indexOf(oldName);
        if (idx !== -1) {
            state.availableDivisions[idx] = trimmed;
        }
        
        state.selectedDivision = trimmed;
        
        syncSpine();
        saveData();
        setupDivisionButtons();
        renderDivisionDetailPane();
        window.updateTable?.();
        
        return true;
    }

    // ==================== UI RENDERING ====================
    
    function setupDivisionButtons() {
        const container = document.getElementById("divisionButtons");
        if (!container) return;
        
        container.innerHTML = "";
        
        if (!state.availableDivisions?.length) {
            container.innerHTML = `
                <p class="muted">
                    No divisions created yet. Add one above or import via CSV.
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
    
    // Store cleanup functions for editable elements
    let editableCleanups = [];
    
    function renderDivisionDetailPane() {
        const pane = document.getElementById("division-detail-pane");
        if (!pane) return;
        
        // Clean up previous editable handlers
        editableCleanups.forEach(cleanup => cleanup());
        editableCleanups = [];
        
        pane.innerHTML = "";
        
        if (!state.selectedDivision || !state.divisions[state.selectedDivision]) {
            pane.innerHTML = `
                <p class="muted">
                    Click a division on the left to set its <strong>times</strong>, 
                    color, and <strong>bunks</strong>.
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
        
        // Build the pane using innerHTML for better performance
        pane.innerHTML = `
            <div class="detail-header" style="display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid #E5E7EB; padding-bottom:8px; margin-bottom:10px; column-gap:12px;">
                <h3 style="margin:0; font-size:1rem; font-weight:600; color:#111827;">
                    Division Details & Bunks
                </h3>
                <button id="delete-division-btn" style="background:#FFFFFF; color:#DC2626; border:1px solid #FECACA; padding:6px 16px; border-radius:999px; cursor:pointer; font-weight:600; font-size:0.85rem; box-shadow:0 4px 10px rgba(220,38,38,0.12); transition:all 0.15s ease;">
                    Delete Division
                </button>
            </div>
            
            <div class="division-color-row">
                <span>Division color</span>
                <input type="color" id="division-color-input" value="${escapeHtml(color)}">
            </div>
            
            <div class="division-edit-shell">
                <div class="division-edit-header">
                    <div class="division-header-left">
                        <span class="division-status-dot" style="background-color:${escapeHtml(color)}; box-shadow:0 0 0 4px ${escapeHtml(color)}33;"></span>
                        <span class="division-name" id="division-name-editable">${escapeHtml(state.selectedDivision)}</span>
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
                            Click to edit name/size. <strong>Double-click to delete.</strong>
                        </p>
                        <div id="bunk-list" style="margin-top:6px; display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px;"></div>
                        <div style="display:flex; gap:6px; margin-top:10px;">
                            <input id="add-bunk-input" placeholder="New Bunk Name" style="flex:1; padding:5px 10px; border-radius:999px; border:1px solid #D1D5DB; font-size:0.86rem;">
                            <button id="add-bunk-btn" style="padding:5px 14px; border-radius:999px; border:none; background:#00C896; color:white; font-size:0.85rem; font-weight:600; cursor:pointer; transition:background 0.15s ease;">
                                Add
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        // Attach event listeners
        const deleteBtn = pane.querySelector("#delete-division-btn");
        deleteBtn?.addEventListener("click", () => deleteDivision(state.selectedDivision));
        deleteBtn?.addEventListener("mouseenter", () => {
            deleteBtn.style.backgroundColor = "#FEF2F2";
        });
        deleteBtn?.addEventListener("mouseleave", () => {
            deleteBtn.style.backgroundColor = "#FFFFFF";
        });
        
        // Color picker with debounce
        const colorInput = pane.querySelector("#division-color-input");
        const debouncedColorChange = debounce((newColor) => {
            divObj.color = newColor;
            syncSpine();
            saveData();
            setupDivisionButtons();
            renderDivisionDetailPane();
            window.updateTable?.();
        }, DEBOUNCE_MS);
        
        colorInput?.addEventListener("input", (e) => debouncedColorChange(e.target.value));
        
        // Editable division name
        const nameEl = pane.querySelector("#division-name-editable");
        if (nameEl) {
            const cleanup = makeEditable(nameEl, (newName) => {
                renameDivision(state.selectedDivision, newName);
            });
            editableCleanups.push(cleanup);
        }
        
        // Time inputs
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
        
        // Bunk list
        const bunkList = pane.querySelector("#bunk-list");
        if (bunkList) {
            if (!divObj.bunks?.length) {
                bunkList.innerHTML = '<p class="muted">No bunks assigned yet.</p>';
            } else {
                const sorted = [...divObj.bunks].sort(compareBunks);
                sorted.forEach(bunkName => {
                    const meta = state.bunkMetaData[bunkName] || { size: 0 };
                    const pill = createBunkPill(bunkName, meta.size);
                    bunkList.appendChild(pill);
                });
            }
        }
        
        // Add bunk
        const addBunkInput = pane.querySelector("#add-bunk-input");
        const addBunkBtn = pane.querySelector("#add-bunk-btn");
        
        const doAddBunk = () => {
            const name = addBunkInput?.value?.trim();
            if (name) {
                addBunkToDivision(state.selectedDivision, name);
                addBunkInput.value = "";
            }
        };
        
        addBunkBtn?.addEventListener("click", doAddBunk);
        addBunkInput?.addEventListener("keydown", (e) => e.key === "Enter" && doAddBunk());
    }
    
    /**
     * Create a bunk pill element with proper click/double-click handling
     */
    function createBunkPill(bunkName, size) {
        const pill = document.createElement("span");
        pill.className = "division-bunk-pill";
        pill.innerHTML = `
            ${escapeHtml(bunkName)} 
            <span class="bunk-size-badge">${size || 0}</span>
        `;
        
        let clickCount = 0;
        let clickTimer = null;
        
        pill.addEventListener("click", (e) => {
            e.stopPropagation();
            clickCount++;
            
            if (clickCount === 1) {
                clickTimer = setTimeout(() => {
                    // Single click - edit mode
                    if (clickCount === 1) {
                        startInlineEdit(pill, bunkName, size);
                    }
                    clickCount = 0;
                }, CLICK_DELAY_MS);
            } else if (clickCount === 2) {
                // Double click - delete
                clearTimeout(clickTimer);
                clickCount = 0;
                
                // Visual feedback
                pill.classList.add("bunk-delete-confirm");
                
                if (confirm(`Delete bunk "${bunkName}" from this division?`)) {
                    deleteBunkFromDivision(state.selectedDivision, bunkName);
                } else {
                    pill.classList.remove("bunk-delete-confirm");
                }
            }
        });
        
        return pill;
    }
    
    function startInlineEdit(pill, bunkName, currentSize) {
        const form = document.createElement("span");
        form.className = "bunk-edit-form";
        
        const nameInput = document.createElement("input");
        nameInput.value = bunkName;
        nameInput.className = "bunk-edit-input";
        
        const sizeInput = document.createElement("input");
        sizeInput.type = "number";
        sizeInput.min = "0";
        sizeInput.value = currentSize || "";
        sizeInput.placeholder = "#";
        sizeInput.className = "bunk-edit-size";
        
        const saveBtn = document.createElement("button");
        saveBtn.className = "bunk-edit-save";
        saveBtn.innerHTML = "✓";
        saveBtn.type = "button";
        
        const doSave = () => {
            renameBunkEverywhere(bunkName, nameInput.value, sizeInput.value);
        };
        
        const doCancel = () => {
            renderDivisionDetailPane();
        };
        
        saveBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            doSave();
        });
        
        nameInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") doSave();
            if (e.key === "Escape") doCancel();
        });
        
        sizeInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") doSave();
            if (e.key === "Escape") doCancel();
        });
        
        form.appendChild(nameInput);
        form.appendChild(sizeInput);
        form.appendChild(saveBtn);
        
        pill.replaceWith(form);
        nameInput.focus();
        nameInput.select();
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
        
        try {
            // Priority: global_authority > app1 data > empty
            const globalDivisions = window.getGlobalDivisions?.() || {};
            const globalBunks = window.getGlobalBunks?.() || [];
            
            // Load divisions
            if (Object.keys(globalDivisions).length > 0) {
                state.divisions = deepClone(globalDivisions);
            } else if (data.divisions && Object.keys(data.divisions).length > 0) {
                state.divisions = deepClone(data.divisions);
            } else {
                state.divisions = {};
            }
            
            // Load bunks
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
            
            // Update derived state
            state.availableDivisions = Object.keys(state.divisions);
            state.specialActivities = data.specialActivities || [];
            state.bunkMetaData = data.bunkMetaData || {};
            state.sportMetaData = data.sportMetaData || {};
            state.selectedDivision = data.selectedDivision || state.availableDivisions[0] || null;
            state.allSports = Array.isArray(data.allSports) ? data.allSports : [...DEFAULT_SPORTS];
            state.savedSkeletons = data.savedSkeletons || {};
            state.skeletonAssignments = data.skeletonAssignments || {};
            
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
        
        // Set up event listeners
        const addDivisionBtn = document.getElementById("addDivisionBtn");
        addDivisionBtn?.addEventListener("click", addDivision);
        
        const divisionInput = document.getElementById("divisionInput");
        divisionInput?.addEventListener("keydown", (e) => {
            if (e.key === "Enter") addDivision();
        });
        
        // Style detail pane
        const detailPane = document.getElementById("division-detail-pane");
        if (detailPane) {
            detailPane.classList.add("detail-pane");
            detailPane.style.marginTop = "8px";
        }
        
        // --- 🟢 NEW: Wire up the Erase All Button ---
        const eraseAllBtn = document.getElementById("eraseAllBtn");
        if (eraseAllBtn) {
            // Remove old listeners by cloning
            const newBtn = eraseAllBtn.cloneNode(true);
            eraseAllBtn.parentNode.replaceChild(newBtn, eraseAllBtn);
            
            newBtn.addEventListener("click", async () => {
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
        renderBulkImportUI();
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
    
    window.addDivisionBunk = addBunkToDivision;
    
    // Color utilities
    window.getNextDivisionColor = getNextDivisionColor;
    window.getNextUniqueDivisionColor = getNextUniqueDivisionColor;
    window.getColorIndex = getColorIndex;
    window.incrementColorIndex = () => setColorIndex(getColorIndex() + 1);
    
    // Initialize window.app1 with getters
    updateWindowApp1();

})();
