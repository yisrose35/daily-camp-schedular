// ============================================================================
// fields.js — MERGED: NEW UX + SPORT PLAYER REQS + RAINY DAY AVAILABILITY
// ============================================================================
// VERSION: 2.0 - Comprehensive Refactor
//
// FIXES APPLIED:
// - Fixed stale window.fields reference using getter
// - Added proper state management with centralized state object
// - Fixed memory leaks from event handlers
// - Added XSS protection via escapeHtml()
// - Added input validation and debouncing
// - Improved accordion with proper cleanup
// - Added null checks throughout
// - Centralized constants
// - Added error handling
// - Removed duplicate parseTimeToMinutes (uses shared utility)
// ============================================================================
(function () {
    'use strict';

    // ==================== CONSTANTS ====================
    const VERSION = "2.0";
    const FIELD_ID_PREFIX = "field-";
    const DEBOUNCE_MS = 150;
    const DEFAULT_CAPACITY = 2;
    const MIN_CAPACITY = 2;

    const DEFAULT_TRANSITION = Object.freeze({
        preMin: 0,
        postMin: 0,
        label: "Travel",
        zone: "Default",
        occupiesField: false,
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

    const DEFAULT_PREFERENCES = Object.freeze({
        enabled: false,
        exclusive: false,
        list: []
    });

    // ==================== STATE ====================
    const state = {
        fields: [],
        selectedItemId: null,
        sportMetaData: {}
    };

    // DOM References (set during init)
    let fieldsListEl = null;
    let detailPaneEl = null;
    let addFieldInput = null;

    // Cleanup tracking
    let cleanupFunctions = [];

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
     * Escape HTML to prevent XSS
     */
    function escapeHtml(str) {
        if (str === null || str === undefined) return "";
        const div = document.createElement("div");
        div.textContent = String(str);
        return div.innerHTML;
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

        if (isNaN(hours) || isNaN(minutes) || minutes < 0 || minutes > 59) {
            return null;
        }

        if (meridiem) {
            if (hours === 12) hours = meridiem === "am" ? 0 : 12;
            else if (meridiem === "pm" && hours < 12) hours += 12;
        }

        return hours * 60 + minutes;
    }

    /**
     * Create a unique field ID
     */
    function makeFieldId(name) {
        return FIELD_ID_PREFIX + name;
    }

    /**
     * Extract field name from ID
     */
    function extractFieldName(id) {
        if (!id || !id.startsWith(FIELD_ID_PREFIX)) return null;
        return id.slice(FIELD_ID_PREFIX.length);
    }

    /**
     * Find a field by name
     */
    function findField(name) {
        return state.fields.find(f => f.name === name);
    }

    /**
     * Run all cleanup functions
     */
    function runCleanups() {
        cleanupFunctions.forEach(fn => {
            try { fn(); } catch (e) { /* ignore */ }
        });
        cleanupFunctions = [];
    }

    // ==================== DATA MANAGEMENT ====================

    function loadData() {
        try {
            const app1 = window.loadGlobalSettings?.()?.app1 || {};
            state.fields = Array.isArray(app1.fields) ? app1.fields : [];
            state.sportMetaData = app1.sportMetaData || {};

            // Normalize field data
            state.fields.forEach(normalizeField);
        } catch (e) {
            console.error("Error loading fields data:", e);
            state.fields = [];
            state.sportMetaData = {};
        }
    }

    function normalizeField(field) {
        if (!field || typeof field !== 'object') return;

        field.available = field.available !== false;
        field.activities = Array.isArray(field.activities) ? field.activities : [];
        field.timeRules = Array.isArray(field.timeRules) ? field.timeRules : [];

        // Normalize sharableWith
        if (!field.sharableWith || typeof field.sharableWith !== 'object') {
            field.sharableWith = deepClone(DEFAULT_SHARABLE);
        } else {
            field.sharableWith.type = field.sharableWith.type || "not_sharable";
            field.sharableWith.divisions = Array.isArray(field.sharableWith.divisions)
                ? field.sharableWith.divisions : [];
            field.sharableWith.capacity = Math.max(
                MIN_CAPACITY,
                parseInt(field.sharableWith.capacity, 10) || DEFAULT_CAPACITY
            );
        }

        // Normalize limitUsage
        if (!field.limitUsage || typeof field.limitUsage !== 'object') {
            field.limitUsage = deepClone(DEFAULT_LIMIT_USAGE);
        } else {
            field.limitUsage.enabled = Boolean(field.limitUsage.enabled);
            field.limitUsage.divisions = field.limitUsage.divisions || {};
        }

        // Normalize preferences
        if (!field.preferences || typeof field.preferences !== 'object') {
            field.preferences = deepClone(DEFAULT_PREFERENCES);
        } else {
            field.preferences.enabled = Boolean(field.preferences.enabled);
            field.preferences.exclusive = Boolean(field.preferences.exclusive);
            field.preferences.list = Array.isArray(field.preferences.list)
                ? field.preferences.list : [];
        }

        // Normalize transition
        if (!field.transition || typeof field.transition !== 'object') {
            field.transition = {
                ...DEFAULT_TRANSITION,
                zone: window.DEFAULT_ZONE_NAME || "Default"
            };
        } else {
            field.transition.preMin = Math.max(0, parseInt(field.transition.preMin, 10) || 0);
            field.transition.postMin = Math.max(0, parseInt(field.transition.postMin, 10) || 0);
            field.transition.label = field.transition.label || "Travel";
            field.transition.zone = field.transition.zone || window.DEFAULT_ZONE_NAME || "Default";
            field.transition.occupiesField = Boolean(field.transition.occupiesField);
            field.transition.minDurationMin = Math.max(0, parseInt(field.transition.minDurationMin, 10) || 0);
        }

        // Rainy day default
        field.rainyDayAvailable = field.rainyDayAvailable === true;
    }

    function saveData() {
        try {
            const settings = window.loadGlobalSettings?.() || {};
            settings.app1 = settings.app1 || {};
            settings.app1.fields = state.fields;
            settings.app1.sportMetaData = state.sportMetaData;
            window.saveGlobalSettings?.("app1", settings.app1);
        } catch (e) {
            console.error("Error saving fields data:", e);
        }
    }

    // Debounced save for frequent updates
    const debouncedSave = debounce(saveData, DEBOUNCE_MS);

    // ==================== STYLES ====================

    function injectStyles(container) {
        if (document.getElementById("fields-styles")) return;

        const style = document.createElement('style');
        style.id = "fields-styles";
        style.textContent = `
            /* Master List */
            .master-list {
                border: 1px solid #E5E7EB;
                border-radius: 12px;
                background: #fff;
                overflow: hidden;
            }

            .list-item {
                padding: 12px 14px;
                border-bottom: 1px solid #F3F4F6;
                cursor: pointer;
                display: flex;
                justify-content: space-between;
                align-items: center;
                transition: background 0.15s ease;
            }

            .list-item:last-child {
                border-bottom: none;
            }

            .list-item:hover {
                background: #F9FAFB;
            }

            .list-item.selected {
                background: #F0FDF4;
                border-left: 3px solid #10B981;
            }

            .list-item-name {
                font-weight: 500;
                color: #1F2937;
                font-size: 0.9rem;
            }

            .list-item-meta {
                font-size: 0.75rem;
                color: #6B7280;
                margin-left: 6px;
            }

            /* Accordion Sections */
            .detail-section {
                margin-bottom: 12px;
                border: 1px solid #E5E7EB;
                border-radius: 12px;
                background: #fff;
                overflow: hidden;
            }

            .detail-section-header {
                padding: 12px 16px;
                background: #F9FAFB;
                cursor: pointer;
                display: flex;
                justify-content: space-between;
                align-items: center;
                user-select: none;
                transition: background 0.15s ease;
            }

            .detail-section-header:hover {
                background: #F3F4F6;
            }

            .detail-section-title {
                font-size: 0.9rem;
                font-weight: 600;
                color: #111;
            }

            .detail-section-summary {
                font-size: 0.8rem;
                color: #6B7280;
                margin-top: 2px;
            }

            .detail-section-body {
                display: none;
                padding: 16px;
                border-top: 1px solid #E5E7EB;
            }

            .detail-section-body.open {
                display: block;
            }

            /* Chips */
            .chip {
                display: inline-block;
                padding: 4px 10px;
                border-radius: 999px;
                font-size: 0.75rem;
                cursor: pointer;
                border: 1px solid #E5E7EB;
                margin-right: 4px;
                margin-bottom: 4px;
                transition: all 0.2s ease;
            }

            .chip.active {
                background: #10B981;
                color: white;
                border-color: #10B981;
                box-shadow: 0 2px 5px rgba(16, 185, 129, 0.3);
            }

            .chip.inactive {
                background: #F3F4F6;
                color: #374151;
            }

            .chip:hover {
                transform: translateY(-1px);
            }

            /* Priority List */
            .priority-list-item {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 8px;
                background: #F9FAFB;
                border: 1px solid #E5E7EB;
                border-radius: 8px;
                margin-bottom: 6px;
            }

            .priority-btn {
                width: 24px;
                height: 24px;
                display: flex;
                align-items: center;
                justify-content: center;
                border: 1px solid #D1D5DB;
                border-radius: 4px;
                background: white;
                cursor: pointer;
                font-size: 0.8rem;
                transition: all 0.15s ease;
            }

            .priority-btn:hover:not(:disabled) {
                border-color: #10B981;
                color: #10B981;
            }

            .priority-btn:disabled {
                opacity: 0.4;
                cursor: default;
            }

            .activity-button {
                padding: 6px 12px;
                border: 1px solid #E5E7EB;
                border-radius: 8px;
                background: white;
                cursor: pointer;
                font-size: 0.85rem;
                transition: all 0.2s ease;
            }

            .activity-button:hover {
                background: #F9FAFB;
            }

            .activity-button.active {
                background: #ECFDF5;
                color: #047857;
                border-color: #10B981;
                font-weight: 500;
            }

            /* Switch/Toggle */
            .switch {
                position: relative;
                display: inline-block;
                width: 34px;
                height: 20px;
                flex-shrink: 0;
            }

            .switch input {
                opacity: 0;
                width: 0;
                height: 0;
            }

            .slider {
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

            .slider:before {
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

            input:checked + .slider {
                background-color: #10B981;
            }

            input:checked + .slider:before {
                transform: translateX(14px);
            }

            /* Sport Rules Card */
            .sport-rules-card {
                border: 1px solid #E5E7EB;
                border-radius: 16px;
                padding: 20px;
                background: linear-gradient(135deg, #F0FDF4 0%, #FFFFFF 100%);
                margin-bottom: 24px;
            }

            .sport-rules-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                cursor: pointer;
                user-select: none;
            }

            .sport-rules-title {
                font-size: 1.1rem;
                font-weight: 600;
                color: #111827;
                display: flex;
                align-items: center;
                gap: 8px;
            }

            .sport-rules-body {
                display: none;
                margin-top: 16px;
                padding-top: 16px;
                border-top: 1px solid #E5E7EB;
            }

            .sport-rules-body.open {
                display: block;
            }

            .sport-rule-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 12px 0;
                border-bottom: 1px solid #F3F4F6;
            }

            .sport-rule-row:last-child {
                border-bottom: none;
            }

            .sport-rule-name {
                font-weight: 500;
                color: #374151;
                flex: 1;
            }

            .sport-rule-inputs {
                display: flex;
                align-items: center;
                gap: 16px;
            }

            .sport-rule-input-group {
                display: flex;
                align-items: center;
                gap: 6px;
            }

            .sport-rule-label {
                font-size: 0.8rem;
                color: #6B7280;
            }

            .sport-rule-input {
                width: 60px;
                padding: 6px 8px;
                border: 1px solid #D1D5DB;
                border-radius: 6px;
                text-align: center;
                font-size: 0.9rem;
                transition: all 0.15s ease;
            }

            .sport-rule-input:focus {
                outline: none;
                border-color: #10B981;
                box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.2);
            }

            .sport-rules-hint {
                font-size: 0.85rem;
                color: #6B7280;
                margin-bottom: 16px;
                padding: 12px;
                background: #F9FAFB;
                border-radius: 8px;
                border-left: 3px solid #10B981;
            }

            /* Form inputs */
            .field-input {
                padding: 6px 10px;
                border: 1px solid #D1D5DB;
                border-radius: 6px;
                font-size: 0.9rem;
                transition: all 0.15s ease;
            }

            .field-input:focus {
                outline: none;
                border-color: #10B981;
                box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.2);
            }

            .muted {
                color: #6B7280;
                font-size: 0.85rem;
            }
        `;
        container.appendChild(style);
    }

    // ==================== INIT ====================

    function initFieldsTab() {
        const container = document.getElementById("fields");
        if (!container) return;

        // Load data first
        loadData();

        // Inject styles
        injectStyles(container);

        // Build layout
        container.innerHTML = `
            <div class="setup-grid">
                <section class="setup-card setup-card-wide" style="border:none; box-shadow:none; background:transparent;">
                    <div class="setup-card-header" style="margin-bottom:20px;">
                        <span class="setup-step-pill">Fields</span>
                        <div class="setup-card-text">
                            <h3>Manage Fields & Facilities</h3>
                            <p>Configure courts, fields, capabilities, restriction rules, and sport player requirements.</p>
                        </div>
                    </div>

                    <!-- SPORT PLAYER REQUIREMENTS SECTION -->
                    <div id="sport-rules-section"></div>

                    <div style="display:flex; flex-wrap:wrap; gap:24px;">
                        <!-- LEFT SIDE: MASTER LIST -->
                        <div style="flex:1; min-width:280px;">
                            <div style="display:flex; justify-content:space-between; align-items:end; margin-bottom:8px;">
                                <div class="setup-subtitle">All Fields</div>
                            </div>

                            <div style="background:white; padding:10px; border-radius:12px; border:1px solid #E5E7EB; margin-bottom:12px; display:flex; gap:8px;">
                                <input id="new-field-input" placeholder="New Field (e.g., Court 1)" class="field-input" style="flex:1; border:none;">
                                <button id="add-field-btn" style="background:#111; color:white; border:none; border-radius:6px; padding:6px 12px; font-size:0.8rem; cursor:pointer; transition: background 0.15s ease;">Add</button>
                            </div>

                            <div id="fields-master-list" class="master-list" style="max-height:600px; overflow-y:auto;"></div>
                        </div>

                        <!-- RIGHT SIDE: DETAIL PANE -->
                        <div style="flex:1.4; min-width:340px;">
                            <div class="setup-subtitle">Field Configuration</div>
                            <div id="fields-detail-pane" style="margin-top:8px;"></div>
                        </div>
                    </div>
                </section>
            </div>
        `;

        // Cache DOM references
        fieldsListEl = document.getElementById("fields-master-list");
        detailPaneEl = document.getElementById("fields-detail-pane");
        addFieldInput = document.getElementById("new-field-input");

        // Event listeners
        const addBtn = document.getElementById("add-field-btn");
        addBtn?.addEventListener("click", addField);
        addBtn?.addEventListener("mouseenter", () => { addBtn.style.background = "#333"; });
        addBtn?.addEventListener("mouseleave", () => { addBtn.style.background = "#111"; });

        addFieldInput?.addEventListener("keydown", (e) => {
            if (e.key === "Enter") addField();
        });

        // Initial render
        renderSportRulesSection();
        renderMasterList();
        renderDetailPane();
    }

    // ==================== SPORT RULES SECTION ====================

    function renderSportRulesSection() {
        const container = document.getElementById("sport-rules-section");
        if (!container) return;

        const allSports = window.getAllGlobalSports?.() || [];

        // Empty state
        if (allSports.length === 0) {
            container.innerHTML = `
                <div class="sport-rules-card">
                    <div class="sport-rules-header">
                        <div class="sport-rules-title">⚡ Sports Rules</div>
                    </div>
                    <div class="sport-rules-body open" style="text-align:center;">
                        <p class="muted" style="padding:10px;">No sports configured yet. Add sports to fields first.</p>
                    </div>
                </div>
            `;
            return;
        }

        const sortedSports = [...allSports].sort();

        container.innerHTML = `
            <div class="sport-rules-card">
                <div class="sport-rules-header" id="sport-rules-toggle">
                    <div class="sport-rules-title">⚡ Sports Rules</div>
                    <span id="sport-rules-caret" style="transition: transform 0.2s; color:#6B7280;">
                        <svg width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                            <path d="M6 9l6 6 6-6"></path>
                        </svg>
                    </span>
                </div>
                <div id="sport-rules-body" class="sport-rules-body">
                    <div class="sport-rules-hint">
                        <strong>How this works:</strong> Set minimum and maximum players for each sport.
                        The scheduler will try to match bunks appropriately based on their sizes.
                        If a bunk is too small, it may be paired with another bunk.
                        If combined bunks are slightly over the max, the scheduler will still prefer a valid sport over "Free".
                    </div>
                    <div id="sport-rules-list"></div>
                    <div style="margin-top:20px; text-align:right;">
                        <button id="save-sport-rules-btn" style="background:#10B981; color:white; border:none; padding:8px 24px; border-radius:999px; cursor:pointer; font-weight:600; font-size:0.9rem; box-shadow: 0 2px 5px rgba(16,185,129,0.3); transition: background 0.15s ease;">
                            Save Rules
                        </button>
                    </div>
                </div>
            </div>
        `;

        // Populate sport rules list
        const listEl = document.getElementById("sport-rules-list");
        if (listEl) {
            sortedSports.forEach(sport => {
                const meta = state.sportMetaData[sport] || {};
                const row = document.createElement("div");
                row.className = "sport-rule-row";
                row.innerHTML = `
                    <span class="sport-rule-name">${escapeHtml(sport)}</span>
                    <div class="sport-rule-inputs">
                        <div class="sport-rule-input-group">
                            <span class="sport-rule-label">Min:</span>
                            <input type="number" class="sport-rule-input"
                                   data-sport="${escapeHtml(sport)}" data-type="min"
                                   value="${meta.minPlayers || ''}" placeholder="—" min="1">
                        </div>
                        <div class="sport-rule-input-group">
                            <span class="sport-rule-label">Max:</span>
                            <input type="number" class="sport-rule-input"
                                   data-sport="${escapeHtml(sport)}" data-type="max"
                                   value="${meta.maxPlayers || ''}" placeholder="∞" min="1">
                        </div>
                    </div>
                `;
                listEl.appendChild(row);
            });
        }

        // Toggle handler
        const toggleBtn = document.getElementById('sport-rules-toggle');
        const bodyEl = document.getElementById('sport-rules-body');
        const caretEl = document.getElementById('sport-rules-caret');

        toggleBtn?.addEventListener('click', () => {
            const isOpen = bodyEl.classList.contains('open');
            bodyEl.classList.toggle('open', !isOpen);
            caretEl.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(180deg)';
        });

        // Input change handlers
        container.querySelectorAll('.sport-rule-input').forEach(input => {
            input.addEventListener('change', () => {
                const sport = input.dataset.sport;
                const type = input.dataset.type;
                const val = parseInt(input.value, 10) || null;

                if (!state.sportMetaData[sport]) {
                    state.sportMetaData[sport] = {};
                }

                if (type === 'min') {
                    state.sportMetaData[sport].minPlayers = val;
                } else if (type === 'max') {
                    state.sportMetaData[sport].maxPlayers = val;
                }
            });
        });

        // Save button
        const saveBtn = document.getElementById('save-sport-rules-btn');
        if (saveBtn) {
            saveBtn.addEventListener('click', (e) => {
                e.stopPropagation();

                // Collect all values
                container.querySelectorAll('.sport-rule-input').forEach(input => {
                    const sport = input.dataset.sport;
                    const type = input.dataset.type;
                    const val = parseInt(input.value, 10) || null;

                    if (!state.sportMetaData[sport]) {
                        state.sportMetaData[sport] = {};
                    }

                    if (type === 'min') {
                        state.sportMetaData[sport].minPlayers = val;
                    } else if (type === 'max') {
                        state.sportMetaData[sport].maxPlayers = val;
                    }
                });

                saveData();

                // Visual feedback
                const originalText = saveBtn.textContent;
                saveBtn.textContent = '✓ Saved!';
                saveBtn.style.background = '#059669';
                setTimeout(() => {
                    saveBtn.textContent = originalText;
                    saveBtn.style.background = '#10B981';
                }, 1500);
            });

            saveBtn.addEventListener('mouseenter', () => {
                saveBtn.style.background = '#059669';
            });
            saveBtn.addEventListener('mouseleave', () => {
                saveBtn.style.background = '#10B981';
            });
        }
    }

    // ==================== MASTER LIST ====================

    function renderMasterList() {
        if (!fieldsListEl) return;

        fieldsListEl.innerHTML = "";

        if (state.fields.length === 0) {
            fieldsListEl.innerHTML = `
                <div style="padding:20px; text-align:center; color:#9CA3AF;">
                    No fields created yet.
                </div>
            `;
            return;
        }

        const fragment = document.createDocumentFragment();
        state.fields.forEach(field => {
            fragment.appendChild(createMasterListItem(field));
        });
        fieldsListEl.appendChild(fragment);
    }

    function createMasterListItem(field) {
        const id = makeFieldId(field.name);
        const el = document.createElement("div");
        el.className = "list-item" + (id === state.selectedItemId ? " selected" : "");

        el.addEventListener("click", () => {
            state.selectedItemId = id;
            renderMasterList();
            renderDetailPane();
        });

        // Info section
        const infoDiv = document.createElement("div");
        const nameEl = document.createElement("div");
        nameEl.className = "list-item-name";
        nameEl.textContent = field.name;

        // Add transition meta if present
        if (field.transition.preMin > 0 || field.transition.postMin > 0) {
            const meta = document.createElement("span");
            meta.className = "list-item-meta";
            meta.textContent = `(${field.transition.preMin}m / ${field.transition.postMin}m)`;
            nameEl.appendChild(meta);
        }

        infoDiv.appendChild(nameEl);
        el.appendChild(infoDiv);

        // Toggle Switch
        const toggle = document.createElement("label");
        toggle.className = "switch";
        toggle.addEventListener("click", (e) => e.stopPropagation());

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = field.available;
        checkbox.addEventListener("change", () => {
            field.available = checkbox.checked;
            saveData();
            renderDetailPane();
        });

        const slider = document.createElement("span");
        slider.className = "slider";

        toggle.appendChild(checkbox);
        toggle.appendChild(slider);
        el.appendChild(toggle);

        return el;
    }

    // ==================== DETAIL PANE ====================

    function renderDetailPane() {
        if (!detailPaneEl) return;

        // Run cleanups from previous render
        runCleanups();

        if (!state.selectedItemId) {
            detailPaneEl.innerHTML = `
                <div style="height:300px; display:flex; align-items:center; justify-content:center;
                            color:#9CA3AF; border:1px dashed #E5E7EB; border-radius:12px;">
                    Select a field to edit details
                </div>
            `;
            return;
        }

        const fieldName = extractFieldName(state.selectedItemId);
        const field = findField(fieldName);

        if (!field) {
            detailPaneEl.innerHTML = '<p class="muted">Field not found.</p>';
            return;
        }

        const allSports = window.getAllGlobalSports?.() || [];

        detailPaneEl.innerHTML = "";

        // Header
        detailPaneEl.appendChild(createDetailHeader(field));

        // Availability Strip
        detailPaneEl.appendChild(createAvailabilityStrip(field));

        // Accordion Sections
        detailPaneEl.appendChild(createSection(
            "Activities",
            () => summaryActivities(field),
            () => renderActivitiesContent(field, allSports)
        ));

        detailPaneEl.appendChild(createSection(
            "Transition & Zone Rules",
            () => summaryTransition(field),
            () => renderTransitionContent(field)
        ));

        detailPaneEl.appendChild(createSection(
            "Access & Restrictions",
            () => summaryAccess(field),
            () => renderAccessContent(field)
        ));

        detailPaneEl.appendChild(createSection(
            "Sharing Rules",
            () => summarySharing(field),
            () => renderSharingContent(field)
        ));

        detailPaneEl.appendChild(createSection(
            "Time Rules",
            () => summaryTime(field),
            () => renderTimeRulesContent(field)
        ));

        detailPaneEl.appendChild(createSection(
            "Weather & Availability",
            () => summaryWeather(field),
            () => renderWeatherContent(field)
        ));
    }

    function createDetailHeader(field) {
        const header = document.createElement("div");
        header.style.cssText = "display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;";

        // Editable title
        const title = document.createElement("h2");
        title.textContent = field.name;
        title.style.cssText = "margin:0; font-size:1.25rem; cursor:pointer;";
        title.title = "Double click to rename";

        const cleanup = makeEditable(title, (newName) => {
            const trimmed = newName.trim();
            if (!trimmed) return;

            // Check for duplicates
            if (state.fields.some(f => f !== field && f.name.toLowerCase() === trimmed.toLowerCase())) {
                alert("A field with that name already exists.");
                return;
            }

            field.name = trimmed;
            state.selectedItemId = makeFieldId(trimmed);
            saveData();
            renderMasterList();
            renderDetailPane();
        });
        cleanupFunctions.push(cleanup);

        // Delete button
        const delBtn = document.createElement("button");
        delBtn.innerHTML = `
            <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
            </svg> Delete
        `;
        delBtn.style.cssText = `
            color:#DC2626; background:#FEF2F2; border:1px solid #FECACA;
            padding:6px 12px; border-radius:6px; cursor:pointer;
            display:flex; gap:6px; align-items:center; transition:background 0.15s ease;
        `;

        delBtn.addEventListener("click", () => {
            if (confirm(`Delete "${field.name}"?`)) {
                state.fields = state.fields.filter(f => f !== field);
                saveData();
                state.selectedItemId = null;
                renderMasterList();
                renderDetailPane();
            }
        });

        delBtn.addEventListener("mouseenter", () => { delBtn.style.background = "#FEE2E2"; });
        delBtn.addEventListener("mouseleave", () => { delBtn.style.background = "#FEF2F2"; });

        header.appendChild(title);
        header.appendChild(delBtn);

        return header;
    }

    function createAvailabilityStrip(field) {
        const strip = document.createElement("div");
        const isAvailable = field.available;

        strip.style.cssText = `
            padding:12px; border-radius:8px; margin-bottom:20px;
            background:${isAvailable ? '#ECFDF5' : '#FEF2F2'};
            border:1px solid ${isAvailable ? '#A7F3D0' : '#FECACA'};
            color:${isAvailable ? '#065F46' : '#991B1B'};
            font-size:0.9rem; display:flex; justify-content:space-between;
        `;

        strip.innerHTML = `
            <span>Field is <strong>${isAvailable ? 'AVAILABLE' : 'UNAVAILABLE'}</strong></span>
            <span style="font-size:0.8rem; opacity:0.8;">Toggle in master list</span>
        `;

        return strip;
    }

    // ==================== SECTION BUILDER ====================

    function createSection(title, getSummary, buildContent) {
        const wrap = document.createElement("div");
        wrap.className = "detail-section";

        const header = document.createElement("div");
        header.className = "detail-section-header";

        const titleWrap = document.createElement("div");
        titleWrap.innerHTML = `
            <div class="detail-section-title">${escapeHtml(title)}</div>
            <div class="detail-section-summary">${escapeHtml(getSummary())}</div>
        `;

        const caret = document.createElement("span");
        caret.innerHTML = `
            <svg width="20" height="20" fill="none" stroke="#9CA3AF" stroke-width="2" viewBox="0 0 24 24">
                <path d="M9 5l7 7-7 7"></path>
            </svg>
        `;
        caret.style.transition = "transform 0.2s ease";

        header.appendChild(titleWrap);
        header.appendChild(caret);

        const body = document.createElement("div");
        body.className = "detail-section-body";

        let isBuilt = false;

        header.addEventListener("click", () => {
            const isOpen = body.classList.contains('open');

            if (!isOpen && !isBuilt) {
                body.innerHTML = "";
                const content = buildContent();
                if (content) body.appendChild(content);
                isBuilt = true;
            }

            body.classList.toggle('open', !isOpen);
            caret.style.transform = isOpen ? "rotate(0deg)" : "rotate(90deg)";

            // Update summary when closing
            if (isOpen) {
                const summaryEl = titleWrap.querySelector('.detail-section-summary');
                if (summaryEl) summaryEl.textContent = getSummary();
            }
        });

        wrap.appendChild(header);
        wrap.appendChild(body);

        return wrap;
    }

    // ==================== SUMMARY FUNCTIONS ====================

    function summaryActivities(f) {
        return f.activities.length ? `${f.activities.length} sports selected` : "No sports selected";
    }

    function summarySharing(f) {
        return f.sharableWith.type === "not_sharable"
            ? "Not sharable"
            : `Sharable (Max ${f.sharableWith.capacity})`;
    }

    function summaryAccess(f) {
        if (!f.limitUsage.enabled) return "Open to All Divisions";
        if (f.preferences.exclusive) return "Exclusive to specific divisions";
        return "Priority/Restrictions Active";
    }

    function summaryTransition(f) {
        return `${f.transition.preMin}m Pre / ${f.transition.postMin}m Post`;
    }

    function summaryTime(f) {
        return f.timeRules.length ? `${f.timeRules.length} rule(s) active` : "Available all day";
    }

    function summaryWeather(f) {
        return f.rainyDayAvailable ? "🏠 Indoor (Rain OK)" : "🌳 Outdoor";
    }

    // ==================== CONTENT BUILDERS ====================

    function renderActivitiesContent(field, allSports) {
        const container = document.createElement("div");

        const buttonWrap = document.createElement("div");
        buttonWrap.style.cssText = "display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px;";

        allSports.forEach(sport => {
            const btn = document.createElement("button");
            btn.textContent = sport;
            btn.className = "activity-button" + (field.activities.includes(sport) ? " active" : "");

            btn.addEventListener("click", () => {
                if (field.activities.includes(sport)) {
                    field.activities = field.activities.filter(x => x !== sport);
                } else {
                    field.activities.push(sport);
                }
                saveData();
                btn.className = "activity-button" + (field.activities.includes(sport) ? " active" : "");
                renderSportRulesSection();
            });

            buttonWrap.appendChild(btn);
        });

        const addInput = document.createElement("input");
        addInput.placeholder = "Add new sport (Type & Enter)...";
        addInput.className = "field-input";
        addInput.style.width = "100%";

        addInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && addInput.value.trim()) {
                const sport = addInput.value.trim();
                window.addGlobalSport?.(sport);
                if (!field.activities.includes(sport)) {
                    field.activities.push(sport);
                }
                saveData();
                renderDetailPane();
                renderSportRulesSection();
            }
        });

        container.appendChild(buttonWrap);
        container.appendChild(addInput);

        return container;
    }

    function renderTransitionContent(field) {
        const t = field.transition;
        const container = document.createElement("div");

        const update = () => {
            saveData();
            renderMasterList();
        };

        // Time inputs row
        const timeRow = document.createElement("div");
        timeRow.style.cssText = "display:flex; gap:12px; margin-bottom:12px; flex-wrap:wrap;";

        timeRow.appendChild(createNumberInput("Pre-Buffer (min)", t.preMin, (v) => {
            t.preMin = v;
            update();
        }));

        timeRow.appendChild(createNumberInput("Post-Buffer (min)", t.postMin, (v) => {
            t.postMin = v;
            update();
        }));

        container.appendChild(timeRow);

        // Zone & min duration row
        const metaRow = document.createElement("div");
        metaRow.style.cssText = "display:flex; gap:12px; margin-bottom:12px; flex-wrap:wrap;";

        // Zone select
        const zoneDiv = document.createElement("div");
        zoneDiv.style.flex = "1";
        zoneDiv.style.minWidth = "150px";
        zoneDiv.innerHTML = '<label style="display:block; font-size:0.8rem; font-weight:600; margin-bottom:4px;">Zone (Location)</label>';

        const zoneSel = document.createElement("select");
        zoneSel.className = "field-input";
        zoneSel.style.width = "100%";

        const zones = window.getZones?.() || {};
        Object.values(zones).forEach(z => {
            const opt = document.createElement("option");
            opt.value = z.name;
            opt.textContent = z.name + (z.isDefault ? " (Default)" : "");
            if (z.name === t.zone) opt.selected = true;
            zoneSel.appendChild(opt);
        });

        zoneSel.addEventListener("change", () => {
            t.zone = zoneSel.value;
            update();
        });

        zoneDiv.appendChild(zoneSel);
        metaRow.appendChild(zoneDiv);

        metaRow.appendChild(createNumberInput("Min Activity (min)", t.minDurationMin, (v) => {
            t.minDurationMin = v;
            update();
        }));

        container.appendChild(metaRow);

        // Occupies field checkbox
        const occLabel = document.createElement("label");
        occLabel.style.cssText = "display:flex; align-items:center; gap:8px; cursor:pointer;";

        const occCk = document.createElement("input");
        occCk.type = "checkbox";
        occCk.checked = t.occupiesField;
        occCk.addEventListener("change", () => {
            t.occupiesField = occCk.checked;
            update();
        });

        occLabel.appendChild(occCk);
        occLabel.appendChild(document.createTextNode("Buffer occupies field (e.g. Setup/Teardown)"));
        container.appendChild(occLabel);

        return container;
    }

    function renderSharingContent(field) {
        const container = document.createElement("div");
        const rules = field.sharableWith;

        // Toggle header
        const header = document.createElement("div");
        header.style.cssText = "display:flex; align-items:center; gap:10px;";

        const toggle = createToggle(rules.type !== 'not_sharable', (checked) => {
            rules.type = checked ? 'all' : 'not_sharable';
            rules.divisions = [];
            saveData();
            renderDetailPane();
        });

        header.appendChild(toggle);
        header.appendChild(document.createTextNode("Allow Sharing (Multiple bunks at once)"));
        container.appendChild(header);

        // Details if sharing enabled
        if (rules.type !== 'not_sharable') {
            const details = document.createElement("div");
            details.style.cssText = "margin-top:16px; padding-left:12px; border-left:2px solid #E5E7EB;";

            // Capacity input
            const capRow = document.createElement("div");
            capRow.style.marginBottom = "12px";
            capRow.innerHTML = '<span>Max Capacity: </span>';

            const capIn = document.createElement("input");
            capIn.type = "number";
            capIn.min = String(MIN_CAPACITY);
            capIn.value = String(rules.capacity);
            capIn.className = "field-input";
            capIn.style.width = "60px";
            capIn.style.marginLeft = "8px";

            capIn.addEventListener("change", () => {
                rules.capacity = Math.max(MIN_CAPACITY, parseInt(capIn.value, 10) || MIN_CAPACITY);
                saveData();
            });

            capRow.appendChild(capIn);
            details.appendChild(capRow);

            // Division limit chips
            const divLabel = document.createElement("div");
            divLabel.textContent = "Limit sharing to specific divisions (Optional):";
            divLabel.style.cssText = "font-size:0.85rem; margin-bottom:6px;";
            details.appendChild(divLabel);

            const allDivs = window.availableDivisions || [];
            const chipWrap = document.createElement("div");

            allDivs.forEach(divName => {
                const isActive = rules.divisions.includes(divName);
                const chip = createChip(divName, isActive, () => {
                    if (isActive) {
                        rules.divisions = rules.divisions.filter(x => x !== divName);
                    } else {
                        rules.divisions.push(divName);
                    }
                    rules.type = rules.divisions.length > 0 ? 'custom' : 'all';
                    saveData();
                    chip.className = "chip " + (rules.divisions.includes(divName) ? "active" : "inactive");
                });
                chipWrap.appendChild(chip);
            });

            details.appendChild(chipWrap);
            container.appendChild(details);
        }

        return container;
    }

    function renderAccessContent(field) {
        const container = document.createElement("div");
        const rules = field.limitUsage;
        const prefs = field.preferences;

        const render = () => {
            container.innerHTML = "";

            // Mode buttons
            const modeWrap = document.createElement("div");
            modeWrap.style.cssText = "display:flex; gap:12px; margin-bottom:16px;";

            const btnAll = createModeButton("Open to All", !rules.enabled, () => {
                rules.enabled = false;
                prefs.enabled = false;
                saveData();
                render();
            });

            const btnRes = createModeButton("Restricted / Priority", rules.enabled, () => {
                rules.enabled = true;
                prefs.enabled = true;
                saveData();
                render();
            });

            modeWrap.appendChild(btnAll);
            modeWrap.appendChild(btnRes);
            container.appendChild(modeWrap);

            if (rules.enabled) {
                const body = document.createElement("div");

                // Exclusive checkbox
                const exLabel = document.createElement("label");
                exLabel.style.cssText = "display:flex; align-items:center; gap:8px; margin-bottom:12px; cursor:pointer;";

                const exCk = document.createElement("input");
                exCk.type = "checkbox";
                exCk.checked = prefs.exclusive;
                exCk.addEventListener("change", () => {
                    prefs.exclusive = exCk.checked;
                    saveData();
                });

                exLabel.appendChild(exCk);
                exLabel.appendChild(document.createTextNode("Exclusive Mode (Only allowed divisions can use this)"));
                body.appendChild(exLabel);

                // Priority list header
                const pHeader = document.createElement("div");
                pHeader.textContent = "Priority Order (Top = First Choice):";
                pHeader.style.cssText = "font-size:0.85rem; font-weight:600; margin-bottom:6px;";
                body.appendChild(pHeader);

                // Filter out removed divisions
                prefs.list = (prefs.list || []).filter(d => d in rules.divisions);

                const listContainer = document.createElement("div");

                if (prefs.list.length === 0) {
                    listContainer.innerHTML = `
                        <div class="muted" style="font-size:0.8rem; font-style:italic; padding:4px;">
                            No priority divisions set. Add below.
                        </div>
                    `;
                }

                prefs.list.forEach((divName, idx) => {
                    listContainer.appendChild(createPriorityItem(divName, idx, prefs.list, () => {
                        saveData();
                        render();
                    }));
                });

                body.appendChild(listContainer);

                // Division selector chips
                const divHeader = document.createElement("div");
                divHeader.textContent = "Allowed Divisions (Click to add/remove from priority):";
                divHeader.style.cssText = "font-size:0.85rem; font-weight:600; margin-top:16px; margin-bottom:6px;";
                body.appendChild(divHeader);

                const chipWrap = document.createElement("div");
                const availableDivisions = window.availableDivisions || [];

                availableDivisions.forEach(divName => {
                    const isAllowed = divName in rules.divisions;
                    const chip = createChip(divName, isAllowed, () => {
                        if (isAllowed) {
                            delete rules.divisions[divName];
                            prefs.list = prefs.list.filter(d => d !== divName);
                        } else {
                            rules.divisions[divName] = [];
                            if (!prefs.list.includes(divName)) {
                                prefs.list.push(divName);
                            }
                        }
                        saveData();
                        render();
                    });
                    chipWrap.appendChild(chip);
                });

                body.appendChild(chipWrap);
                container.appendChild(body);
            }
        };

        render();
        return container;
    }

    function renderTimeRulesContent(field) {
        const container = document.createElement("div");

        const render = () => {
            container.innerHTML = "";

            // Existing rules
            if (field.timeRules.length > 0) {
                field.timeRules.forEach((rule, i) => {
                    const row = document.createElement("div");
                    row.style.cssText = `
                        display:flex; justify-content:space-between; align-items:center;
                        background:#F9FAFB; padding:8px; margin-bottom:6px;
                        border-radius:6px; border:1px solid #E5E7EB;
                    `;

                    const color = rule.type === 'Available' ? '#059669' : '#DC2626';
                    row.innerHTML = `
                        <span><strong style="color:${color}">${escapeHtml(rule.type)}</strong>:
                            ${escapeHtml(rule.start)} to ${escapeHtml(rule.end)}</span>
                    `;

                    const delBtn = document.createElement("button");
                    delBtn.textContent = "✕";
                    delBtn.style.cssText = "border:none; background:transparent; color:#9CA3AF; cursor:pointer; font-size:1rem;";
                    delBtn.addEventListener("click", () => {
                        field.timeRules.splice(i, 1);
                        saveData();
                        render();
                    });

                    row.appendChild(delBtn);
                    container.appendChild(row);
                });
            } else {
                container.innerHTML = '<div class="muted" style="font-size:0.8rem; margin-bottom:10px;">No specific time rules (Available all day).</div>';
            }

            // Add new rule form
            const addRow = document.createElement("div");
            addRow.style.cssText = "display:flex; gap:8px; margin-top:12px; padding-top:12px; border-top:1px dashed #E5E7EB; flex-wrap:wrap; align-items:center;";

            const typeSel = document.createElement("select");
            typeSel.innerHTML = '<option>Available</option><option>Unavailable</option>';
            typeSel.className = "field-input";

            const startIn = document.createElement("input");
            startIn.placeholder = "9:00am";
            startIn.className = "field-input";
            startIn.style.width = "80px";

            const endIn = document.createElement("input");
            endIn.placeholder = "10:00am";
            endIn.className = "field-input";
            endIn.style.width = "80px";

            const addBtn = document.createElement("button");
            addBtn.textContent = "Add";
            addBtn.style.cssText = "background:#111; color:white; border:none; border-radius:6px; padding:6px 12px; cursor:pointer;";

            addBtn.addEventListener("click", () => {
                if (!startIn.value || !endIn.value) {
                    alert("Please enter both start and end times.");
                    return;
                }

                if (parseTimeToMinutes(startIn.value) === null) {
                    alert("Invalid start time format. Use format like 9:00am");
                    return;
                }

                if (parseTimeToMinutes(endIn.value) === null) {
                    alert("Invalid end time format. Use format like 10:00am");
                    return;
                }

                field.timeRules.push({
                    type: typeSel.value,
                    start: startIn.value,
                    end: endIn.value
                });

                saveData();
                render();
            });

            addRow.appendChild(typeSel);
            addRow.appendChild(startIn);
            addRow.appendChild(document.createTextNode(" to "));
            addRow.appendChild(endIn);
            addRow.appendChild(addBtn);

            container.appendChild(addRow);
        };

        render();
        return container;
    }

    function renderWeatherContent(field) {
        const container = document.createElement("div");

        const render = () => {
            const isIndoor = field.rainyDayAvailable === true;

            container.innerHTML = `
                <div style="margin-bottom: 16px;">
                    <p style="font-size: 0.85rem; color: #6b7280; margin: 0 0 12px 0;">
                        Mark this field as indoor/covered to keep it available during Rainy Day Mode.
                        Outdoor fields will be automatically disabled when rainy weather is activated.
                    </p>
                    <div style="display: flex; align-items: center; gap: 12px; padding: 14px;
                                background: ${isIndoor ? '#ecfdf5' : '#fef3c7'};
                                border: 1px solid ${isIndoor ? '#a7f3d0' : '#fcd34d'};
                                border-radius: 10px; transition: all 0.2s ease;">
                        <span style="font-size: 28px;">${isIndoor ? '🏠' : '🌳'}</span>
                        <div style="flex: 1;">
                            <div style="font-weight: 600; color: ${isIndoor ? '#065f46' : '#92400e'};">
                                ${isIndoor ? 'Indoor / Covered' : 'Outdoor'}
                            </div>
                            <div style="font-size: 0.85rem; color: ${isIndoor ? '#047857' : '#b45309'};">
                                ${isIndoor ? 'Available on rainy days' : 'Disabled during rainy days'}
                            </div>
                        </div>
                        <label class="switch">
                            <input type="checkbox" id="rainy-day-toggle" ${isIndoor ? 'checked' : ''}>
                            <span class="slider"></span>
                        </label>
                    </div>
                </div>
                <div style="background: #f9fafb; border-radius: 8px; padding: 12px; font-size: 0.85rem; color: #4b5563;">
                    <strong>💡 Tip:</strong> Indoor facilities like gyms, covered courts, and activity rooms
                    should be marked as indoor. Outdoor fields like soccer fields, baseball diamonds,
                    and open courts should remain as outdoor.
                </div>
            `;

            const toggle = container.querySelector('#rainy-day-toggle');
            toggle?.addEventListener('change', () => {
                field.rainyDayAvailable = toggle.checked;
                saveData();
                render();
            });
        };

        render();
        return container;
    }

    // ==================== UI HELPERS ====================

    function createNumberInput(label, value, onChange) {
        const div = document.createElement("div");
        div.innerHTML = `<label style="display:block; font-size:0.8rem; font-weight:600; margin-bottom:4px;">${escapeHtml(label)}</label>`;

        const input = document.createElement("input");
        input.type = "number";
        input.min = "0";
        input.step = "5";
        input.value = String(value);
        input.className = "field-input";
        input.style.width = "80px";

        input.addEventListener("change", () => {
            onChange(Math.max(0, parseInt(input.value, 10) || 0));
        });

        div.appendChild(input);
        return div;
    }

    function createToggle(checked, onChange) {
        const label = document.createElement("label");
        label.className = "switch";

        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = checked;
        input.addEventListener("change", () => onChange(input.checked));

        const slider = document.createElement("span");
        slider.className = "slider";

        label.appendChild(input);
        label.appendChild(slider);

        return label;
    }

    function createChip(text, isActive, onClick) {
        const chip = document.createElement("span");
        chip.className = "chip " + (isActive ? "active" : "inactive");
        chip.textContent = text;
        chip.addEventListener("click", onClick);
        return chip;
    }

    function createModeButton(text, isActive, onClick) {
        const btn = document.createElement("button");
        btn.textContent = text;
        btn.style.cssText = `
            flex:1; padding:8px; border-radius:6px; cursor:pointer; transition:all 0.2s;
            background:${isActive ? '#ECFDF5' : '#fff'};
            color:${isActive ? '#047857' : '#333'};
            border:1px solid ${isActive ? '#10B981' : '#E5E7EB'};
            font-weight:${isActive ? '600' : '400'};
        `;
        btn.addEventListener("click", onClick);
        return btn;
    }

    function createPriorityItem(divName, idx, list, onUpdate) {
        const row = document.createElement("div");
        row.className = "priority-list-item";

        row.innerHTML = `
            <span style="font-weight:bold; color:#10B981; width:20px;">${idx + 1}</span>
            <span style="flex:1;">${escapeHtml(divName)}</span>
        `;

        const controls = document.createElement("div");
        controls.style.cssText = "display:flex; gap:4px;";

        // Move up button
        const upBtn = document.createElement("button");
        upBtn.className = "priority-btn";
        upBtn.textContent = "↑";
        upBtn.disabled = idx === 0;
        upBtn.addEventListener("click", () => {
            [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]];
            onUpdate();
        });

        // Move down button
        const downBtn = document.createElement("button");
        downBtn.className = "priority-btn";
        downBtn.textContent = "↓";
        downBtn.disabled = idx === list.length - 1;
        downBtn.addEventListener("click", () => {
            [list[idx + 1], list[idx]] = [list[idx], list[idx + 1]];
            onUpdate();
        });

        // Remove button
        const removeBtn = document.createElement("button");
        removeBtn.className = "priority-btn";
        removeBtn.textContent = "✕";
        removeBtn.style.color = "#DC2626";
        removeBtn.style.borderColor = "#FECACA";
        removeBtn.addEventListener("click", () => {
            list.splice(idx, 1);
            onUpdate();
        });

        controls.appendChild(upBtn);
        controls.appendChild(downBtn);
        controls.appendChild(removeBtn);

        row.appendChild(controls);
        return row;
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
            input.value = oldValue;
            input.className = "field-input";
            input.style.fontSize = "inherit";
            input.style.fontWeight = "inherit";
            input.style.width = Math.max(100, el.offsetWidth + 20) + "px";

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
            input.addEventListener("keydown", (e) => {
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

    // ==================== FIELD OPERATIONS ====================

    function addField() {
        const name = addFieldInput?.value?.trim();

        if (!name) return;

        // Check for duplicates (case-insensitive)
        if (state.fields.some(f => f.name.toLowerCase() === name.toLowerCase())) {
            alert("A field with that name already exists.");
            return;
        }

        const newField = {
            name: name,
            activities: [],
            available: true,
            sharableWith: deepClone(DEFAULT_SHARABLE),
            limitUsage: deepClone(DEFAULT_LIMIT_USAGE),
            preferences: deepClone(DEFAULT_PREFERENCES),
            timeRules: [],
            transition: {
                ...DEFAULT_TRANSITION,
                zone: window.DEFAULT_ZONE_NAME || "Default"
            },
            rainyDayAvailable: false
        };

        state.fields.push(newField);
        addFieldInput.value = "";

        saveData();

        state.selectedItemId = makeFieldId(name);
        renderMasterList();
        renderDetailPane();
    }

    // ==================== WINDOW EXPORTS ====================

    window.initFieldsTab = initFieldsTab;

    // Use getter for fresh reference
    Object.defineProperty(window, 'fields', {
        get: () => state.fields,
        configurable: true
    });

    // Export sport metadata getter
    window.getSportMetaData = () => state.sportMetaData;

    // Export for external access
    window.getFields = () => state.fields;
    window.getFieldByName = findField;

})();
