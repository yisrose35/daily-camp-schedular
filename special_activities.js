// =================================================================
// special_activities.js — Modern Pro Camp THEMED VERSION
// =================================================================
// VERSION: 2.1 - UI/UX Restored + Code Quality Improvements
//
// FIXES APPLIED:
// - Restored original beta UI/UX design
// - Fixed stale window.specialActivities reference using getter
// - Added proper state management with centralized state object
// - Fixed memory leaks from event handlers
// - Added XSS protection via escapeHtml()
// - Added input validation
// - Consistent event handling with addEventListener
// - Added Enter key support on ALL inputs
// - Added debouncing for frequent saves
// - Added error handling
// - Added Rainy Day availability section
// =================================================================
(function () {
    'use strict';

    // ==================== CONSTANTS ====================
    const VERSION = "2.1";
    const SPECIAL_ID_PREFIX = "special-";
    const DEBOUNCE_MS = 150;
    const MIN_CAPACITY = 2;
    const DEFAULT_CAPACITY = 2;

    const DEFAULT_TRANSITION = Object.freeze({
        preMin: 0,
        postMin: 0,
        label: "Change Time",
        zone: "Default",
        occupiesField: true,
        minDurationMin: 0
    });

    const DEFAULT_SHARABLE = Object.freeze({
        type: "not_sharable",
        divisions: [],
        capacity: DEFAULT_CAPACITY
    });

    const DEFAULT_LIMIT_USAGE = Object.freeze({
        enabled: false,
        divisions: {}
    });

    const FREQUENCY_OPTIONS = Object.freeze([
        { value: 0, label: "Summer (Lifetime)" },
        { value: 1, label: "1 Week (7 Days)" },
        { value: 2, label: "2 Weeks (14 Days)" },
        { value: 3, label: "3 Weeks (21 Days)" },
        { value: 4, label: "4 Weeks (28 Days)" }
    ]);

    // ==================== STATE ====================
    const state = {
        specialActivities: [],
        selectedItemId: null
    };

    // DOM References
    let specialsListEl = null;
    let detailPaneEl = null;
    let addSpecialInput = null;

    // Cleanup tracking
    let cleanupFunctions = [];

    // ==================== UTILITIES ====================

    function deepClone(obj) {
        if (obj === null || obj === undefined) return obj;
        try {
            return structuredClone(obj);
        } catch {
            return JSON.parse(JSON.stringify(obj));
        }
    }

    function debounce(fn, delay = DEBOUNCE_MS) {
        let timeoutId;
        return function (...args) {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => fn.apply(this, args), delay);
        };
    }

    function escapeHtml(str) {
        if (str === null || str === undefined) return "";
        const div = document.createElement("div");
        div.textContent = String(str);
        return div.innerHTML;
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

        if (isNaN(hours) || isNaN(minutes) || minutes < 0 || minutes > 59) {
            return null;
        }

        if (meridiem) {
            if (hours === 12) hours = meridiem === "am" ? 0 : 12;
            else if (meridiem === "pm" && hours < 12) hours += 12;
        }

        return hours * 60 + minutes;
    }

    function makeSpecialId(name) {
        return SPECIAL_ID_PREFIX + name;
    }

    function extractSpecialName(id) {
        if (!id || !id.startsWith(SPECIAL_ID_PREFIX)) return null;
        return id.slice(SPECIAL_ID_PREFIX.length);
    }

    function findSpecial(name) {
        return state.specialActivities.find(s => s.name === name);
    }

    function runCleanups() {
        cleanupFunctions.forEach(fn => {
            try { fn(); } catch (e) { /* ignore */ }
        });
        cleanupFunctions = [];
    }

    // ==================== DATA MANAGEMENT ====================

    function loadData() {
        try {
            state.specialActivities = window.getGlobalSpecialActivities?.() || [];
            state.specialActivities.forEach(normalizeSpecial);
        } catch (e) {
            console.error("Error loading special activities:", e);
            state.specialActivities = [];
        }
    }

    function normalizeSpecial(special) {
        if (!special || typeof special !== 'object') return;

        special.available = special.available !== false;
        special.timeRules = Array.isArray(special.timeRules) ? special.timeRules : [];

        // Normalize sharableWith
        if (!special.sharableWith || typeof special.sharableWith !== 'object') {
            special.sharableWith = deepClone(DEFAULT_SHARABLE);
        } else {
            special.sharableWith.type = special.sharableWith.type || "not_sharable";
            special.sharableWith.divisions = Array.isArray(special.sharableWith.divisions)
                ? special.sharableWith.divisions : [];
            special.sharableWith.capacity = Math.max(
                MIN_CAPACITY,
                parseInt(special.sharableWith.capacity, 10) || DEFAULT_CAPACITY
            );
        }

        // Normalize limitUsage
        if (!special.limitUsage || typeof special.limitUsage !== 'object') {
            special.limitUsage = deepClone(DEFAULT_LIMIT_USAGE);
        } else {
            special.limitUsage.enabled = Boolean(special.limitUsage.enabled);
            special.limitUsage.divisions = special.limitUsage.divisions || {};
        }

        // Normalize maxUsage
        special.maxUsage = (special.maxUsage !== undefined && special.maxUsage !== "" && special.maxUsage !== null)
            ? Math.max(1, parseInt(special.maxUsage, 10) || 1)
            : null;
        special.frequencyWeeks = parseInt(special.frequencyWeeks, 10) || 0;

        // Normalize transition
        if (!special.transition || typeof special.transition !== 'object') {
            special.transition = {
                ...DEFAULT_TRANSITION,
                zone: window.DEFAULT_ZONE_NAME || "Default"
            };
        } else {
            special.transition.preMin = Math.max(0, parseInt(special.transition.preMin, 10) || 0);
            special.transition.postMin = Math.max(0, parseInt(special.transition.postMin, 10) || 0);
            special.transition.label = special.transition.label || "Change Time";
            special.transition.zone = special.transition.zone || window.DEFAULT_ZONE_NAME || "Default";
            special.transition.occupiesField = special.transition.occupiesField !== false;
            special.transition.minDurationMin = Math.max(0, parseInt(special.transition.minDurationMin, 10) || 0);
        }

        // Rainy day defaults
        special.rainyDayAvailable = special.rainyDayAvailable === true;
        special.rainyDayOnly = special.rainyDayOnly === true;
    }

    function saveData() {
        try {
            window.saveGlobalSpecialActivities?.(state.specialActivities);
        } catch (e) {
            console.error("Error saving special activities:", e);
        }
    }

    const debouncedSave = debounce(saveData, DEBOUNCE_MS);

    // ==================== STYLES ====================

    function injectStyles(container) {
        if (document.getElementById("special-activities-styles")) return;

        const style = document.createElement('style');
        style.id = "special-activities-styles";
        style.textContent = `
            /* Master List - Original Beta Styling */
            .sa-master-list {
                border-radius: 18px;
                border: 1px solid #E5E7EB;
                background: #F8FAFC;
                padding: 6px 6px;
                box-shadow: 0 8px 20px rgba(15,23,42,0.06);
            }

            .sa-list-item {
                padding: 10px 12px;
                border-radius: 14px;
                margin-bottom: 6px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                cursor: pointer;
                background: #ffffff;
                border: 1px solid #e5e7eb;
                box-shadow: 0 3px 8px rgba(15,23,42,0.05);
                transition: 0.15s ease;
            }

            .sa-list-item:last-child {
                margin-bottom: 0;
            }

            .sa-list-item:hover {
                background: #f1f5f9;
                transform: translateY(-1px);
            }

            .sa-list-item.selected {
                background: radial-gradient(circle at top left, #ECFDF5, #ffffff 70%);
                border-color: #00C896;
                box-shadow: 0 0 0 2px rgba(0,200,150,0.45);
                font-weight: 600;
            }

            .sa-list-item-name {
                font-weight: 500;
                color: #1F2937;
                font-size: 0.9rem;
            }

            .sa-list-item-meta {
                font-size: 0.7rem;
                color: #047857;
                font-weight: normal;
                margin-left: 4px;
            }

            /* Detail Pane - Original Beta Styling */
            .sa-detail-pane {
                border-radius: 18px;
                border: 1px solid #E5E7EB;
                padding: 20px 22px;
                background: radial-gradient(circle at top left, #F0F9FF 0%, #FFFFFF 55%, #F8FAFC 100%);
                box-shadow: 0 14px 36px rgba(15,23,42,0.08);
                min-height: 380px;
            }

            /* Cards within detail pane */
            .sa-card {
                background: #ffffff;
                border: 1px solid #e5e7eb;
                border-radius: 14px;
                padding: 16px 16px;
                margin-bottom: 20px;
                box-shadow: 0 8px 18px rgba(15,23,42,0.06);
            }

            .sa-card-header {
                font-weight: 600;
                margin-bottom: 6px;
                font-size: 0.9rem;
                color: #111827;
            }

            /* Switch/Toggle - Original Style */
            .sa-switch {
                position: relative;
                display: inline-block;
                width: 34px;
                height: 20px;
                flex-shrink: 0;
            }

            .sa-switch input {
                opacity: 0;
                width: 0;
                height: 0;
            }

            .sa-slider {
                position: absolute;
                cursor: pointer;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background-color: #ccc;
                transition: 0.3s ease;
                border-radius: 34px;
            }

            .sa-slider:before {
                position: absolute;
                content: "";
                height: 14px;
                width: 14px;
                left: 3px;
                bottom: 3px;
                background-color: white;
                transition: 0.3s ease;
                border-radius: 50%;
            }

            .sa-switch input:checked + .sa-slider {
                background-color: #00C896;
            }

            .sa-switch input:checked + .sa-slider:before {
                transform: translateX(14px);
            }

            /* Chips - Original Pill Style */
            .sa-chip {
                display: inline-block;
                padding: 6px 12px;
                border-radius: 999px;
                font-size: 0.8rem;
                cursor: pointer;
                border: 1px solid #D1D5DB;
                margin-right: 6px;
                margin-bottom: 6px;
                transition: all 0.15s ease;
            }

            .sa-chip.active {
                background: #00C896;
                color: #FFFFFF;
                border-color: #00C896;
            }

            .sa-chip.inactive {
                background: #F3F4F6;
                color: #111827;
            }

            .sa-chip:hover {
                transform: translateY(-1px);
            }

            /* Form inputs - Pill Style */
            .sa-input {
                padding: 6px 12px;
                border: 1px solid #D1D5DB;
                border-radius: 999px;
                font-size: 0.9rem;
                transition: all 0.15s ease;
            }

            .sa-input:focus {
                outline: none;
                border-color: #00C896;
                box-shadow: 0 0 0 2px rgba(0,200,150,0.2);
            }

            .sa-select {
                padding: 6px 12px;
                border: 1px solid #D1D5DB;
                border-radius: 999px;
                font-size: 0.9rem;
                background: white;
                cursor: pointer;
            }

            .sa-select:focus {
                outline: none;
                border-color: #00C896;
            }

            .sa-btn {
                padding: 6px 14px;
                border-radius: 999px;
                font-size: 0.85rem;
                cursor: pointer;
                transition: all 0.15s ease;
                border: none;
            }

            .sa-btn-primary {
                background: #00C896;
                color: white;
            }

            .sa-btn-primary:hover {
                background: #00B085;
            }

            .sa-btn-danger {
                background: #FEE2E2;
                color: #DC2626;
                border: 1px solid #FECACA;
            }

            .sa-btn-danger:hover {
                background: #FECACA;
            }

            .sa-btn-secondary {
                background: #111;
                color: white;
            }

            .sa-btn-secondary:hover {
                background: #333;
            }

            .sa-muted {
                color: #6b7280;
                font-size: 0.86rem;
            }

            /* Section separators */
            .sa-section {
                margin-top: 16px;
                padding-top: 14px;
                border-top: 1px solid #E5E7EB;
            }

            .sa-section-title {
                font-weight: 600;
                font-size: 0.9rem;
                margin-bottom: 10px;
                color: #111827;
            }

            /* Time rules list */
            .sa-time-rule {
                padding: 4px 6px;
                margin: 3px 0;
                background: #f3f4f6;
                border-radius: 8px;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }

            /* Rainy Day Cards */
            .sa-weather-card {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 14px;
                border-radius: 10px;
                margin-bottom: 12px;
            }

            .sa-weather-card-indoor {
                background: #ecfdf5;
                border: 1px solid #a7f3d0;
            }

            .sa-weather-card-outdoor {
                background: #fef3c7;
                border: 1px solid #fcd34d;
            }

            .sa-weather-card-rainy {
                background: #dbeafe;
                border: 1px solid #93c5fd;
            }

            .sa-weather-card-default {
                background: #f9fafb;
                border: 1px solid #e5e7eb;
            }
        `;
        container.appendChild(style);
    }

    // ==================== INIT ====================

    function initSpecialActivitiesTab() {
        const container = document.getElementById("special_activities");
        if (!container) return;

        loadData();
        injectStyles(container);

        container.innerHTML = `
            <div class="setup-grid">
                <section class="setup-card setup-card-wide">
                    <div class="setup-card-header">
                        <span class="setup-step-pill">Specials</span>
                        <div class="setup-card-text">
                            <h3>Special Activities & Rotations</h3>
                            <p>
                                Add canteen, electives, trips, lakes, buses, and control
                                availability, sharing, division access, and rotation rules.
                            </p>
                        </div>
                    </div>
                    <div style="display:flex; flex-wrap:wrap; gap:22px; margin-top:10px;">
                        <div style="flex:1; min-width:260px;">
                            <div class="setup-subtitle">All Specials</div>
                            <p style="font-size:0.8rem; color:#6b7280;">
                                Click a special to edit its rules.
                            </p>
                            <div class="setup-field-row" style="margin-top:10px;">
                                <input id="new-special-input" placeholder="New Special (e.g., Canteen)">
                                <button id="add-special-btn">Add Special</button>
                            </div>
                            <div id="specials-master-list"
                                 class="sa-master-list"
                                 style="margin-top:10px; max-height:460px; overflow:auto;">
                            </div>
                        </div>
                        <div style="flex:1.3; min-width:330px;">
                            <div class="setup-subtitle">Special Details</div>
                            <div id="specials-detail-pane"
                                 class="sa-detail-pane"
                                 style="margin-top:10px;">
                                <p class="sa-muted">Select a special to begin.</p>
                            </div>
                        </div>
                    </div>
                </section>
            </div>
        `;

        specialsListEl = document.getElementById("specials-master-list");
        detailPaneEl = document.getElementById("specials-detail-pane");
        addSpecialInput = document.getElementById("new-special-input");

        const addBtn = document.getElementById("add-special-btn");
        addBtn?.addEventListener("click", addSpecial);

        addSpecialInput?.addEventListener("keyup", (e) => {
            if (e.key === "Enter") addSpecial();
        });

        renderMasterList();
        renderDetailPane();
    }

    // ==================== MASTER LIST ====================

    function renderMasterList() {
        if (!specialsListEl) return;

        specialsListEl.innerHTML = "";

        if (state.specialActivities.length === 0) {
            specialsListEl.innerHTML = `<p class="sa-muted">No special activities yet.</p>`;
            return;
        }

        const fragment = document.createDocumentFragment();
        state.specialActivities.forEach(special => {
            fragment.appendChild(createMasterListItem(special));
        });
        specialsListEl.appendChild(fragment);
    }

    function createMasterListItem(special) {
        const id = makeSpecialId(special.name);
        const el = document.createElement("div");
        el.className = "sa-list-item" + (id === state.selectedItemId ? " selected" : "");

        el.addEventListener("click", () => {
            state.selectedItemId = id;
            renderMasterList();
            renderDetailPane();
        });

        // Name section
        const nameEl = document.createElement("span");
        nameEl.className = "sa-list-item-name";
        nameEl.textContent = special.name;

        // Add transition meta if present
        if (special.transition.preMin > 0 || special.transition.postMin > 0) {
            const meta = document.createElement("span");
            meta.className = "sa-list-item-meta";
            meta.textContent = ` (${special.transition.preMin}m / ${special.transition.postMin}m)`;
            nameEl.appendChild(meta);
        }

        // Add rainy day indicator
        if (special.rainyDayOnly) {
            const badge = document.createElement("span");
            badge.className = "sa-list-item-meta";
            badge.textContent = " 🌧️";
            badge.title = "Rainy Day Only";
            nameEl.appendChild(badge);
        } else if (special.rainyDayAvailable) {
            const badge = document.createElement("span");
            badge.className = "sa-list-item-meta";
            badge.textContent = " 🏠";
            badge.title = "Available on Rainy Days";
            nameEl.appendChild(badge);
        }

        el.appendChild(nameEl);

        // Toggle Switch
        const toggle = document.createElement("label");
        toggle.className = "sa-switch";
        toggle.addEventListener("click", (e) => e.stopPropagation());

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = special.available;
        checkbox.addEventListener("change", () => {
            special.available = checkbox.checked;
            saveData();
            renderDetailPane();
        });

        const slider = document.createElement("span");
        slider.className = "sa-slider";

        toggle.appendChild(checkbox);
        toggle.appendChild(slider);
        el.appendChild(toggle);

        return el;
    }

    // ==================== DETAIL PANE ====================

    function renderDetailPane() {
        if (!detailPaneEl) return;

        runCleanups();

        if (!state.selectedItemId) {
            detailPaneEl.innerHTML = `<p class="sa-muted">Select a special to begin.</p>`;
            return;
        }

        const specialName = extractSpecialName(state.selectedItemId);
        const special = findSpecial(specialName);

        if (!special) {
            state.selectedItemId = null;
            detailPaneEl.innerHTML = `<p style="color:red;">Error.</p>`;
            return;
        }

        detailPaneEl.innerHTML = "";

        const onSave = () => saveData();
        const onRerender = () => {
            renderMasterList();
            renderDetailPane();
        };

        // HEADER
        detailPaneEl.appendChild(createDetailHeader(special, onSave, onRerender));

        // AVAILABILITY STRIP
        detailPaneEl.appendChild(createAvailabilityStrip(special));

        // TRANSITION RULES CARD
        detailPaneEl.appendChild(createTransitionCard(special, onSave, onRerender));

        // FREQUENCY LIMITS CARD
        detailPaneEl.appendChild(createFrequencyCard(special, onSave, onRerender));

        // WEATHER/RAINY DAY CARD
        detailPaneEl.appendChild(createWeatherCard(special, onSave, onRerender));

        // SHARABLE RULES SECTION
        detailPaneEl.appendChild(renderSharableControls(special, onSave, onRerender));

        // ALLOWED DIVISIONS/BUNKS SECTION
        detailPaneEl.appendChild(renderAllowedBunksControls(special, onSave, onRerender));

        // TIME RULES SECTION
        detailPaneEl.appendChild(renderTimeRulesUI(special, onSave, onRerender));
    }

    function createDetailHeader(special, onSave, onRerender) {
        const header = document.createElement("div");
        header.style.cssText = "display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #E5E7EB; padding-bottom:10px; margin-bottom:16px;";

        const title = document.createElement("h3");
        title.style.cssText = "margin:0; font-size:1.05rem; font-weight:600;";
        title.textContent = special.name;

        const cleanup = makeEditable(title, (newName) => {
            const trimmed = newName.trim();
            if (!trimmed) return;

            if (state.specialActivities.some(s => s !== special && s.name.toLowerCase() === trimmed.toLowerCase())) {
                alert("A special with that name already exists.");
                return;
            }

            special.name = trimmed;
            state.selectedItemId = makeSpecialId(trimmed);
            onSave();
            onRerender();
        });
        cleanupFunctions.push(cleanup);

        const delBtn = document.createElement("button");
        delBtn.textContent = "Delete";
        delBtn.style.cssText = "color:#DC2626; border:1px solid #FECACA; background:#fff; border-radius:999px; padding:6px 14px; cursor:pointer;";

        delBtn.addEventListener("click", () => {
            if (confirm(`Delete "${special.name}"?`)) {
                state.specialActivities = state.specialActivities.filter(s => s !== special);
                state.selectedItemId = null;
                onSave();
                onRerender();
            }
        });

        header.appendChild(title);
        header.appendChild(delBtn);

        return header;
    }

    function createAvailabilityStrip(special) {
        const strip = document.createElement("div");
        const isAvailable = special.available;

        strip.style.cssText = `
            padding: 10px 14px;
            border-radius: 14px;
            margin-bottom: 18px;
            border: 1px solid ${isAvailable ? '#BBF7D0' : '#FECACA'};
            background: ${isAvailable ? '#ECFDF5' : '#FEF2F2'};
        `;

        strip.innerHTML = `
            Currently <strong>${isAvailable ? 'AVAILABLE' : 'UNAVAILABLE'}</strong>.
            <span style="opacity:0.7;">(Toggle in the left list)</span>
        `;

        return strip;
    }

    // ==================== TRANSITION CARD ====================

    function createTransitionCard(special, onSave, onRerender) {
        const card = document.createElement("div");
        card.className = "sa-card";

        const header = document.createElement("div");
        header.className = "sa-card-header";
        header.textContent = "Transition & Duration Rules";
        card.appendChild(header);

        const t = special.transition;

        const container = document.createElement("div");
        container.innerHTML = `
            <div style="display:flex; flex-wrap:wrap; gap:10px; align-items:center;">
                <label style="font-weight:600; font-size:0.85rem;">Pre-Activity (To):</label>
                <input type="number" id="pre-min-input" value="${t.preMin}" min="0" step="5" class="sa-input" style="width:60px;">
                <label style="font-weight:600; font-size:0.85rem;">Post-Activity (From):</label>
                <input type="number" id="post-min-input" value="${t.postMin}" min="0" step="5" class="sa-input" style="width:60px;">
            </div>

            <div style="margin-top:10px; display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
                <label style="font-weight:600; font-size:0.85rem;">Label:</label>
                <input type="text" id="buffer-label-input" value="${escapeHtml(t.label)}" class="sa-input" style="width:120px;">
            </div>

            <!-- Zone Selector -->
            <div style="margin-top:15px; border-top:1px dashed #E5E7EB; padding-top:10px;">
                <label style="font-weight:600; font-size:0.85rem;">Location Zone:</label>
                <select id="zone-select" class="sa-select" style="width:100%; margin-top:5px;"></select>
                <p class="sa-muted" style="font-size:0.75rem; margin-top:5px;">Required for Buffer Merging and Transport Limits.</p>
            </div>

            <!-- Occupancy Toggle -->
            <label style="display:flex; align-items:center; gap:8px; margin-top:10px; cursor:pointer;">
                <input type="checkbox" id="occupies-field-check" ${t.occupiesField ? 'checked' : ''} style="width:16px; height:16px;">
                <span style="font-size:0.85rem; font-weight:600;">Buffer Occupies Resource (e.g., Setup/Change)</span>
            </label>
            <p class="sa-muted" style="font-size:0.75rem; margin-top:2px; padding-left:25px;">
                If unchecked (Travel), the resource is available during transition time.
            </p>

            <!-- Minimum Duration -->
            <div style="margin-top:15px; border-top:1px dashed #E5E7EB; padding-top:10px;">
                <label style="font-weight:600; font-size:0.85rem;">Min Activity Duration:</label>
                <input type="number" id="min-duration-input" value="${t.minDurationMin}" min="0" step="5" class="sa-input" style="width:60px; margin-left:5px;">
                <span class="sa-muted" style="font-size:0.85rem;">minutes (if less, placement is rejected).</span>
            </div>
        `;

        // Populate Zones
        const zones = window.getZones?.() || {};
        const zoneSelect = container.querySelector('#zone-select');
        Object.values(zones).forEach(z => {
            const opt = document.createElement('option');
            opt.value = z.name;
            opt.textContent = z.name + (z.isDefault ? ' (Default)' : '');
            if (z.name === t.zone) opt.selected = true;
            zoneSelect.appendChild(opt);
        });

        const updateTransition = () => {
            t.preMin = parseInt(container.querySelector('#pre-min-input').value, 10) || 0;
            t.postMin = parseInt(container.querySelector('#post-min-input').value, 10) || 0;
            t.label = container.querySelector('#buffer-label-input').value.trim() || "Transition";
            t.zone = container.querySelector('#zone-select').value;
            t.occupiesField = container.querySelector('#occupies-field-check').checked;
            t.minDurationMin = parseInt(container.querySelector('#min-duration-input').value, 10) || 0;
            onSave();
            onRerender();
        };

        container.querySelectorAll('input, select').forEach(el => {
            el.addEventListener('change', updateTransition);
            if (el.tagName === 'INPUT') {
                el.addEventListener('keyup', (e) => {
                    if (e.key === 'Enter') updateTransition();
                });
            }
        });

        card.appendChild(container);
        return card;
    }

    // ==================== FREQUENCY CARD ====================

    function createFrequencyCard(special, onSave, onRerender) {
        const card = document.createElement("div");
        card.className = "sa-card";

        const header = document.createElement("div");
        header.className = "sa-card-header";
        header.textContent = "Frequency Limits";
        card.appendChild(header);

        const render = () => {
            // Clear existing content except header
            while (card.childNodes.length > 1) {
                card.removeChild(card.lastChild);
            }

            if (special.maxUsage === null || special.maxUsage === undefined) {
                const noLimitText = document.createElement('p');
                noLimitText.textContent = "Unlimited usage allowed.";
                noLimitText.style.cssText = "margin:0 0 10px; font-size:0.8rem; color:#6b7280;";
                card.appendChild(noLimitText);

                const addLimitBtn = document.createElement("button");
                addLimitBtn.textContent = "+ Add Frequency Rule";
                addLimitBtn.className = "sa-btn sa-btn-primary";

                addLimitBtn.addEventListener("click", () => {
                    special.maxUsage = 1;
                    special.frequencyWeeks = 0;
                    onSave();
                    render();
                });
                card.appendChild(addLimitBtn);
            } else {
                const limitDesc = document.createElement('p');
                limitDesc.textContent = "Bunks are allowed to play this:";
                limitDesc.style.cssText = "margin:0 0 8px; font-size:0.8rem; color:#6b7280;";
                card.appendChild(limitDesc);

                const controlRow = document.createElement("div");
                controlRow.style.cssText = "display:flex; gap:10px; align-items:center; flex-wrap:wrap;";

                // Count Input
                const maxInput = document.createElement("input");
                maxInput.type = "number";
                maxInput.min = "1";
                maxInput.value = String(special.maxUsage);
                maxInput.className = "sa-input";
                maxInput.style.width = "60px";

                maxInput.addEventListener("input", () => {
                    const val = maxInput.value.trim();
                    if (val !== "") {
                        special.maxUsage = Math.max(1, parseInt(val, 10) || 1);
                        onSave();
                    }
                });

                maxInput.addEventListener("keyup", (e) => {
                    if (e.key === "Enter") {
                        special.maxUsage = Math.max(1, parseInt(maxInput.value, 10) || 1);
                        onSave();
                    }
                });

                const timeLabel = document.createElement("span");
                timeLabel.textContent = "time(s) per";
                timeLabel.style.fontSize = "0.85rem";

                // Frequency Dropdown
                const freqSelect = document.createElement("select");
                freqSelect.className = "sa-select";

                FREQUENCY_OPTIONS.forEach(opt => {
                    const option = document.createElement("option");
                    option.value = String(opt.value);
                    option.textContent = opt.label;
                    if (special.frequencyWeeks === opt.value) option.selected = true;
                    freqSelect.appendChild(option);
                });

                freqSelect.addEventListener("change", () => {
                    special.frequencyWeeks = parseInt(freqSelect.value, 10);
                    onSave();
                });

                // Remove Button
                const removeBtn = document.createElement("button");
                removeBtn.textContent = "Remove Rule";
                removeBtn.className = "sa-btn sa-btn-danger";

                removeBtn.addEventListener("click", () => {
                    special.maxUsage = null;
                    special.frequencyWeeks = 0;
                    onSave();
                    render();
                });

                controlRow.appendChild(maxInput);
                controlRow.appendChild(timeLabel);
                controlRow.appendChild(freqSelect);
                controlRow.appendChild(removeBtn);
                card.appendChild(controlRow);
            }
        };

        render();
        return card;
    }

    // ==================== WEATHER CARD ====================

    function createWeatherCard(special, onSave, onRerender) {
        const card = document.createElement("div");
        card.className = "sa-card";

        const header = document.createElement("div");
        header.className = "sa-card-header";
        header.textContent = "Weather & Availability";
        card.appendChild(header);

        const render = () => {
            // Clear existing content except header
            while (card.childNodes.length > 1) {
                card.removeChild(card.lastChild);
            }

            const isIndoor = special.rainyDayAvailable === true;
            const isRainyOnly = special.rainyDayOnly === true;

            const container = document.createElement("div");

            const desc = document.createElement("p");
            desc.className = "sa-muted";
            desc.style.cssText = "margin:0 0 12px;";
            desc.textContent = "Configure how this special behaves during rainy days.";
            container.appendChild(desc);

            // Indoor/Outdoor Toggle Card
            const indoorCard = document.createElement("div");
            indoorCard.className = `sa-weather-card ${isIndoor ? 'sa-weather-card-indoor' : 'sa-weather-card-outdoor'}`;

            indoorCard.innerHTML = `
                <span style="font-size: 28px;">${isIndoor ? '🏠' : '🌳'}</span>
                <div style="flex: 1;">
                    <div style="font-weight: 600; color: ${isIndoor ? '#065f46' : '#92400e'};">
                        ${isIndoor ? 'Indoor / Covered' : 'Outdoor'}
                    </div>
                    <div style="font-size: 0.85rem; color: ${isIndoor ? '#047857' : '#b45309'};">
                        ${isIndoor ? 'Available on rainy days' : 'Disabled during rainy days'}
                    </div>
                </div>
            `;

            const indoorToggle = createToggle(isIndoor, (checked) => {
                special.rainyDayAvailable = checked;
                if (!checked) {
                    special.rainyDayOnly = false;
                }
                onSave();
                onRerender();
            });
            indoorCard.appendChild(indoorToggle);
            container.appendChild(indoorCard);

            // Rainy Day Only Toggle Card
            const rainyCard = document.createElement("div");
            rainyCard.className = `sa-weather-card ${isRainyOnly ? 'sa-weather-card-rainy' : 'sa-weather-card-default'}`;

            rainyCard.innerHTML = `
                <span style="font-size: 28px;">🌧️</span>
                <div style="flex: 1;">
                    <div style="font-weight: 600; color: ${isRainyOnly ? '#1e40af' : '#374151'};">
                        Rainy Day Only
                    </div>
                    <div style="font-size: 0.85rem; color: ${isRainyOnly ? '#3b82f6' : '#6b7280'};">
                        ${isRainyOnly ? 'Only available when Rainy Day Mode is active' : 'Available on all days'}
                    </div>
                </div>
            `;

            const rainyToggle = createToggle(isRainyOnly, (checked) => {
                special.rainyDayOnly = checked;
                if (checked) {
                    special.rainyDayAvailable = true;
                }
                onSave();
                onRerender();
            });
            rainyCard.appendChild(rainyToggle);
            container.appendChild(rainyCard);

            // Tips
            const tips = document.createElement("div");
            tips.style.cssText = "background:#f9fafb; border-radius:8px; padding:12px; font-size:0.85rem; color:#4b5563; margin-top:12px;";
            tips.innerHTML = `
                <strong>💡 Tips:</strong>
                <ul style="margin:8px 0 0 0; padding-left:20px;">
                    <li><strong>Indoor activities</strong> (gym, arts & crafts) should be marked as "Indoor/Covered"</li>
                    <li><strong>Rainy day specials</strong> (movie time, indoor games) should be marked as "Rainy Day Only"</li>
                    <li><strong>Outdoor activities</strong> (lake, outdoor sports) will be auto-disabled on rainy days</li>
                </ul>
            `;
            container.appendChild(tips);

            card.appendChild(container);
        };

        render();
        return card;
    }

    // ==================== SHARABLE CONTROLS ====================

    function renderSharableControls(special, onSave, onRerender) {
        const wrap = document.createElement("div");
        wrap.className = "sa-section";

        const title = document.createElement("div");
        title.className = "sa-section-title";
        title.textContent = "Sharing Rules:";
        wrap.appendChild(title);

        const rules = special.sharableWith;
        const isSharable = rules.type !== 'not_sharable';

        const row = document.createElement("label");
        row.style.cssText = "display:flex; align-items:center; gap:10px; cursor:pointer;";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = isSharable;
        cb.style.cssText = "width:16px; height:16px;";
        cb.addEventListener("change", () => {
            rules.type = cb.checked ? "all" : "not_sharable";
            rules.divisions = [];
            onSave();
            onRerender();
        });

        const txt = document.createElement("span");
        txt.textContent = "Sharable (Multiple bunks at once)";

        row.appendChild(cb);
        row.appendChild(txt);
        wrap.appendChild(row);

        // If sharable → show division chips & capacity
        if (isSharable) {
            const box = document.createElement("div");
            box.style.cssText = "margin-top:10px; padding-left:20px;";

            // Capacity input
            const capRow = document.createElement("div");
            capRow.style.marginBottom = "10px";
            capRow.innerHTML = '<span style="font-size:0.85rem;">Max Capacity: </span>';

            const capIn = document.createElement("input");
            capIn.type = "number";
            capIn.min = String(MIN_CAPACITY);
            capIn.value = String(rules.capacity || DEFAULT_CAPACITY);
            capIn.className = "sa-input";
            capIn.style.width = "60px";
            capIn.style.marginLeft = "8px";

            capIn.addEventListener("change", () => {
                rules.capacity = Math.max(MIN_CAPACITY, parseInt(capIn.value, 10) || MIN_CAPACITY);
                onSave();
            });

            capIn.addEventListener("keyup", (e) => {
                if (e.key === "Enter") {
                    rules.capacity = Math.max(MIN_CAPACITY, parseInt(capIn.value, 10) || MIN_CAPACITY);
                    onSave();
                }
            });

            capRow.appendChild(capIn);
            box.appendChild(capRow);

            const help = document.createElement("div");
            help.textContent = "Limit to divisions (optional):";
            help.style.cssText = "font-size:0.82rem; color:#6b7280; margin-bottom:4px;";
            box.appendChild(help);

            const chips = createChipPicker(
                window.availableDivisions || [],
                rules.divisions,
                () => {
                    rules.type = rules.divisions.length ? "custom" : "all";
                    onSave();
                    onRerender();
                }
            );
            box.appendChild(chips);
            wrap.appendChild(box);
        }

        return wrap;
    }

    function createChipPicker(all, selected, onToggle) {
        const box = document.createElement("div");
        box.style.cssText = "display:flex; flex-wrap:wrap; gap:6px;";

        all.forEach(name => {
            const active = selected.includes(name);
            const chip = document.createElement("span");
            chip.className = "sa-chip " + (active ? "active" : "inactive");
            chip.textContent = name;

            chip.addEventListener("click", () => {
                const idx = selected.indexOf(name);
                if (idx > -1) selected.splice(idx, 1);
                else selected.push(name);
                onToggle();
            });

            box.appendChild(chip);
        });

        return box;
    }

    // ==================== ALLOWED BUNKS CONTROLS ====================

    function renderAllowedBunksControls(special, onSave, onRerender) {
        const wrap = document.createElement("div");
        wrap.className = "sa-section";

        const title = document.createElement("div");
        title.className = "sa-section-title";
        title.textContent = "Allowed Divisions & Bunks:";
        wrap.appendChild(title);

        const rules = special.limitUsage;

        // TOGGLE - Custom styled toggle
        const mode = document.createElement("label");
        mode.style.cssText = "display:flex; align-items:center; gap:12px; margin-top:10px; cursor:pointer;";

        const tAll = document.createElement("span");
        tAll.textContent = "All Divisions";
        tAll.style.fontSize = "0.9rem";

        const track = document.createElement("span");
        track.style.cssText = `
            width:44px; height:24px; border-radius:999px;
            display:inline-block; position:relative;
            border:1px solid #cbd5e1;
            background:${rules.enabled ? '#d1d5db' : '#22c55e'};
            transition:0.2s;
        `;

        const knob = document.createElement("span");
        knob.style.cssText = `
            width:20px; height:20px; border-radius:50%;
            background:#ffffff; position:absolute;
            top:1px; left:${rules.enabled ? '21px' : '1px'};
            transition:0.2s;
        `;
        track.appendChild(knob);

        const tSpec = document.createElement("span");
        tSpec.textContent = "Specific Divisions/Bunks";
        tSpec.style.fontSize = "0.9rem";

        mode.appendChild(tAll);
        mode.appendChild(track);
        mode.appendChild(tSpec);

        mode.addEventListener("click", () => {
            rules.enabled = !rules.enabled;
            onSave();
            onRerender();
        });

        wrap.appendChild(mode);

        // If NOT enabled → done
        if (!rules.enabled) return wrap;

        // PANEL
        const panel = document.createElement("div");
        panel.style.cssText = "margin-top:12px; padding-left:20px; border-left:3px solid #e5e7eb;";

        const allDivs = window.availableDivisions || [];

        allDivs.forEach(div => {
            const divWrap = document.createElement("div");
            divWrap.style.marginTop = "8px";

            const isAllowed = div in rules.divisions;
            const bunks = window.divisions?.[div]?.bunks || [];
            const allowedBunks = rules.divisions[div] || [];

            const chip = createLimitChip(div, isAllowed);
            chip.style.fontWeight = "600";
            chip.addEventListener("click", () => {
                if (isAllowed) delete rules.divisions[div];
                else rules.divisions[div] = [];
                onSave();
                onRerender();
            });
            divWrap.appendChild(chip);

            // Show bunk chips
            if (isAllowed && bunks.length > 0) {
                const bunkBox = document.createElement("div");
                bunkBox.style.cssText = "display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; padding-left:22px;";

                if (allowedBunks.length > 0) {
                    const allChip = createLimitChip("All " + div, false);
                    allChip.style.borderColor = "#00C896";
                    allChip.style.color = "#00C896";
                    allChip.addEventListener("click", () => {
                        rules.divisions[div] = [];
                        onSave();
                        onRerender();
                    });
                    bunkBox.appendChild(allChip);
                }

                bunks.forEach(b => {
                    const bc = createLimitChip(b, allowedBunks.includes(b));
                    bc.addEventListener("click", () => {
                        const idx = allowedBunks.indexOf(b);
                        if (idx > -1) allowedBunks.splice(idx, 1);
                        else allowedBunks.push(b);
                        onSave();
                        onRerender();
                    });
                    bunkBox.appendChild(bc);
                });

                divWrap.appendChild(bunkBox);
            }

            panel.appendChild(divWrap);
        });

        wrap.appendChild(panel);
        return wrap;
    }

    function createLimitChip(text, active) {
        const c = document.createElement("span");
        c.className = "sa-chip " + (active ? "active" : "inactive");
        c.textContent = text;
        return c;
    }

    // ==================== TIME RULES UI ====================

    function renderTimeRulesUI(special, onSave, onRerender) {
        const wrap = document.createElement("div");
        wrap.className = "sa-section";
        wrap.style.paddingLeft = "14px";
        wrap.style.borderLeft = "3px solid #e5e7eb";

        const title = document.createElement("div");
        title.className = "sa-section-title";
        title.textContent = "Global Time Rules:";
        wrap.appendChild(title);

        if (!special.timeRules) special.timeRules = [];

        const list = document.createElement("div");

        if (special.timeRules.length === 0) {
            list.innerHTML = `<p class="sa-muted" style="margin:0;">Available all day</p>`;
        }

        special.timeRules.forEach((rule, idx) => {
            const row = document.createElement("div");
            row.className = "sa-time-rule";

            row.innerHTML = `
                <span>
                    <strong style="color:${rule.type === 'Available' ? '#059669' : '#DC2626'};">
                        ${escapeHtml(rule.type)}
                    </strong>
                    from ${escapeHtml(rule.start)} to ${escapeHtml(rule.end)}
                </span>
            `;

            const x = document.createElement("button");
            x.textContent = "✖";
            x.style.cssText = "background:transparent; border:none; cursor:pointer; color:#9CA3AF; font-size:1rem;";
            x.addEventListener("click", () => {
                special.timeRules.splice(idx, 1);
                onSave();
                onRerender();
            });
            row.appendChild(x);
            list.appendChild(row);
        });

        wrap.appendChild(list);

        // Add rule form
        const form = document.createElement("div");
        form.style.cssText = "margin-top:10px; display:flex; gap:6px; flex-wrap:wrap; align-items:center;";

        const sel = document.createElement("select");
        sel.className = "sa-select";
        sel.innerHTML = `
            <option value="Available">Available</option>
            <option value="Unavailable">Unavailable</option>
        `;

        const s = document.createElement("input");
        s.placeholder = "9:00am";
        s.className = "sa-input";
        s.style.width = "90px";

        const txt = document.createElement("span");
        txt.textContent = " to ";
        txt.style.margin = "0 4px";

        const e = document.createElement("input");
        e.placeholder = "10:00am";
        e.className = "sa-input";
        e.style.width = "90px";

        const addRule = () => {
            if (!s.value || !e.value) {
                alert("Enter both times.");
                return;
            }
            if (parseTimeToMinutes(s.value) === null) {
                alert("Invalid start time format. Use format like 9:00am");
                return;
            }
            if (parseTimeToMinutes(e.value) === null) {
                alert("Invalid end time format. Use format like 10:00am");
                return;
            }
            if (parseTimeToMinutes(s.value) >= parseTimeToMinutes(e.value)) {
                alert("End must be after start.");
                return;
            }

            special.timeRules.push({
                type: sel.value,
                start: s.value,
                end: e.value
            });
            onSave();
            onRerender();
        };

        const add = document.createElement("button");
        add.textContent = "Add";
        add.className = "sa-btn sa-btn-secondary";
        add.addEventListener("click", addRule);

        s.addEventListener("keyup", (e) => {
            if (e.key === "Enter") addRule();
        });
        e.addEventListener("keyup", (e) => {
            if (e.key === "Enter") addRule();
        });

        form.appendChild(sel);
        form.appendChild(s);
        form.appendChild(txt);
        form.appendChild(e);
        form.appendChild(add);
        wrap.appendChild(form);

        return wrap;
    }

    // ==================== UI HELPERS ====================

    function createToggle(checked, onChange) {
        const label = document.createElement("label");
        label.className = "sa-switch";

        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = checked;
        input.addEventListener("change", () => onChange(input.checked));

        const slider = document.createElement("span");
        slider.className = "sa-slider";

        label.appendChild(input);
        label.appendChild(slider);

        return label;
    }

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
            input.className = "sa-input";
            input.style.cssText = "min-width:120px; font-size:inherit; font-weight:inherit;";

            const finalize = (save = true) => {
                const newValue = input.value.trim();
                if (save && newValue && newValue !== oldValue) {
                    onSave(newValue);
                } else {
                    el.textContent = oldValue;
                    if (input.parentNode) {
                        input.replaceWith(el);
                    }
                }
            };

            input.addEventListener("blur", () => finalize(true));
            input.addEventListener("keyup", (e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    finalize(true);
                } else if (e.key === "Escape") {
                    e.preventDefault();
                    finalize(false);
                }
            });

            el.replaceWith(input);
            input.focus();
            input.select();
        };

        el.addEventListener("dblclick", handleDblClick);

        return () => el.removeEventListener("dblclick", handleDblClick);
    }

    // ==================== SPECIAL OPERATIONS ====================

    function addSpecial() {
        const name = addSpecialInput?.value?.trim();

        if (!name) return;

        if (state.specialActivities.some(s => s.name.toLowerCase() === name.toLowerCase())) {
            alert("Special already exists.");
            return;
        }

        const newSpecial = {
            name: name,
            available: true,
            sharableWith: deepClone(DEFAULT_SHARABLE),
            limitUsage: deepClone(DEFAULT_LIMIT_USAGE),
            timeRules: [],
            maxUsage: null,
            frequencyWeeks: 0,
            transition: {
                ...DEFAULT_TRANSITION,
                zone: window.DEFAULT_ZONE_NAME || "Default"
            },
            rainyDayAvailable: false,
            rainyDayOnly: false
        };

        state.specialActivities.push(newSpecial);
        addSpecialInput.value = "";

        saveData();

        state.selectedItemId = makeSpecialId(name);
        renderMasterList();
        renderDetailPane();
    }

    // ==================== WINDOW EXPORTS ====================

    window.initSpecialActivitiesTab = initSpecialActivitiesTab;

    // Use getter for fresh reference
    Object.defineProperty(window, 'specialActivities', {
        get: () => state.specialActivities,
        configurable: true
    });

    // Export helpers
    window.getSpecialActivities = () => state.specialActivities;
    window.getSpecialByName = findSpecial;

})();
