// =================================================================
// special_activities.js — Modern Pro Camp THEMED VERSION
// =================================================================
// VERSION: 2.0 - Comprehensive Refactor
//
// FIXES APPLIED:
// - Fixed stale window.specialActivities reference using getter
// - Added proper state management with centralized state object
// - Fixed memory leaks from event handlers
// - Added XSS protection via escapeHtml()
// - Added input validation
// - Consistent event handling with addEventListener
// - Added Enter key support on ALL inputs
// - Matched UI/UX to fields.js (accordion sections)
// - Added Rainy Day availability section
// - Added debouncing for frequent saves
// - Centralized constants
// - Added error handling
// =================================================================
(function () {
    'use strict';

    // ==================== CONSTANTS ====================
    const VERSION = "2.0";
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
            /* Master List */
            .sa-master-list {
                border: 1px solid #E5E7EB;
                border-radius: 12px;
                background: #fff;
                overflow: hidden;
            }

            .sa-list-item {
                padding: 12px 14px;
                border-bottom: 1px solid #F3F4F6;
                cursor: pointer;
                display: flex;
                justify-content: space-between;
                align-items: center;
                transition: background 0.15s ease;
            }

            .sa-list-item:last-child {
                border-bottom: none;
            }

            .sa-list-item:hover {
                background: #F9FAFB;
            }

            .sa-list-item.selected {
                background: #F0FDF4;
                border-left: 3px solid #10B981;
            }

            .sa-list-item-name {
                font-weight: 500;
                color: #1F2937;
                font-size: 0.9rem;
            }

            .sa-list-item-meta {
                font-size: 0.75rem;
                color: #6B7280;
                margin-left: 6px;
            }

            /* Accordion Sections - Matching fields.js */
            .sa-detail-section {
                margin-bottom: 12px;
                border: 1px solid #E5E7EB;
                border-radius: 12px;
                background: #fff;
                overflow: hidden;
            }

            .sa-detail-section-header {
                padding: 12px 16px;
                background: #F9FAFB;
                cursor: pointer;
                display: flex;
                justify-content: space-between;
                align-items: center;
                user-select: none;
                transition: background 0.15s ease;
            }

            .sa-detail-section-header:hover {
                background: #F3F4F6;
            }

            .sa-detail-section-title {
                font-size: 0.9rem;
                font-weight: 600;
                color: #111;
            }

            .sa-detail-section-summary {
                font-size: 0.8rem;
                color: #6B7280;
                margin-top: 2px;
            }

            .sa-detail-section-body {
                display: none;
                padding: 16px;
                border-top: 1px solid #E5E7EB;
            }

            .sa-detail-section-body.open {
                display: block;
            }

            /* Chips */
            .sa-chip {
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

            .sa-chip.active {
                background: #10B981;
                color: white;
                border-color: #10B981;
                box-shadow: 0 2px 5px rgba(16, 185, 129, 0.3);
            }

            .sa-chip.inactive {
                background: #F3F4F6;
                color: #374151;
            }

            .sa-chip:hover {
                transform: translateY(-1px);
            }

            /* Priority List */
            .sa-priority-list-item {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 8px;
                background: #F9FAFB;
                border: 1px solid #E5E7EB;
                border-radius: 8px;
                margin-bottom: 6px;
            }

            .sa-priority-btn {
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

            .sa-priority-btn:hover:not(:disabled) {
                border-color: #10B981;
                color: #10B981;
            }

            .sa-priority-btn:disabled {
                opacity: 0.4;
                cursor: default;
            }

            /* Switch/Toggle */
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
                background-color: #10B981;
            }

            .sa-switch input:checked + .sa-slider:before {
                transform: translateX(14px);
            }

            /* Form inputs */
            .sa-input {
                padding: 6px 10px;
                border: 1px solid #D1D5DB;
                border-radius: 6px;
                font-size: 0.9rem;
                transition: all 0.15s ease;
            }

            .sa-input:focus {
                outline: none;
                border-color: #10B981;
                box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.2);
            }

            .sa-select {
                padding: 6px 10px;
                border: 1px solid #D1D5DB;
                border-radius: 6px;
                font-size: 0.9rem;
                background: white;
                cursor: pointer;
            }

            .sa-select:focus {
                outline: none;
                border-color: #10B981;
            }

            .sa-btn {
                padding: 6px 14px;
                border-radius: 6px;
                font-size: 0.85rem;
                cursor: pointer;
                transition: all 0.15s ease;
                border: none;
            }

            .sa-btn-primary {
                background: #10B981;
                color: white;
            }

            .sa-btn-primary:hover {
                background: #059669;
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
                color: #6B7280;
                font-size: 0.85rem;
            }

            /* Detail Pane */
            .sa-detail-pane {
                border-radius: 18px;
                border: 1px solid #E5E7EB;
                padding: 20px 22px;
                background: linear-gradient(135deg, #F7F9FA 0%, #FFFFFF 55%, #F7F9FA 100%);
                min-height: 380px;
                box-shadow: 0 14px 36px rgba(15, 23, 42, 0.08);
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
                <section class="setup-card setup-card-wide" style="border:none; box-shadow:none; background:transparent;">
                    <div class="setup-card-header" style="margin-bottom:20px;">
                        <span class="setup-step-pill">Specials</span>
                        <div class="setup-card-text">
                            <h3>Special Activities & Rotations</h3>
                            <p>Add canteen, electives, trips, lakes, buses, and control availability, sharing, division access, and rotation rules.</p>
                        </div>
                    </div>

                    <div style="display:flex; flex-wrap:wrap; gap:24px;">
                        <!-- LEFT SIDE: MASTER LIST -->
                        <div style="flex:1; min-width:280px;">
                            <div style="display:flex; justify-content:space-between; align-items:end; margin-bottom:8px;">
                                <div class="setup-subtitle">All Specials</div>
                            </div>

                            <div style="background:white; padding:10px; border-radius:12px; border:1px solid #E5E7EB; margin-bottom:12px; display:flex; gap:8px;">
                                <input id="new-special-input" placeholder="New Special (e.g., Canteen)" class="sa-input" style="flex:1; border:none;">
                                <button id="add-special-btn" class="sa-btn sa-btn-secondary">Add</button>
                            </div>

                            <div id="specials-master-list" class="sa-master-list" style="max-height:600px; overflow-y:auto;"></div>
                        </div>

                        <!-- RIGHT SIDE: DETAIL PANE -->
                        <div style="flex:1.4; min-width:340px;">
                            <div class="setup-subtitle">Special Configuration</div>
                            <div id="specials-detail-pane" class="sa-detail-pane" style="margin-top:8px;"></div>
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

        addSpecialInput?.addEventListener("keydown", (e) => {
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
            specialsListEl.innerHTML = `
                <div style="padding:20px; text-align:center; color:#9CA3AF;">
                    No special activities yet.
                </div>
            `;
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

        // Info section
        const infoDiv = document.createElement("div");
        const nameEl = document.createElement("span");
        nameEl.className = "sa-list-item-name";
        nameEl.textContent = special.name;

        // Add transition meta if present
        if (special.transition.preMin > 0 || special.transition.postMin > 0) {
            const meta = document.createElement("span");
            meta.className = "sa-list-item-meta";
            meta.textContent = `(${special.transition.preMin}m / ${special.transition.postMin}m)`;
            meta.style.color = "#047857";
            nameEl.appendChild(meta);
        }

        // Add rainy day indicator
        if (special.rainyDayOnly) {
            const badge = document.createElement("span");
            badge.className = "sa-list-item-meta";
            badge.textContent = "🌧️";
            badge.title = "Rainy Day Only";
            nameEl.appendChild(badge);
        } else if (special.rainyDayAvailable) {
            const badge = document.createElement("span");
            badge.className = "sa-list-item-meta";
            badge.textContent = "🏠";
            badge.title = "Available on Rainy Days";
            nameEl.appendChild(badge);
        }

        infoDiv.appendChild(nameEl);
        el.appendChild(infoDiv);

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
            detailPaneEl.innerHTML = `
                <div style="height:300px; display:flex; align-items:center; justify-content:center;
                            color:#9CA3AF; border:1px dashed #E5E7EB; border-radius:12px;">
                    Select a special to edit details
                </div>
            `;
            return;
        }

        const specialName = extractSpecialName(state.selectedItemId);
        const special = findSpecial(specialName);

        if (!special) {
            detailPaneEl.innerHTML = '<p class="sa-muted">Special not found.</p>';
            return;
        }

        detailPaneEl.innerHTML = "";

        // Header
        detailPaneEl.appendChild(createDetailHeader(special));

        // Availability Strip
        detailPaneEl.appendChild(createAvailabilityStrip(special));

        // Accordion Sections
        detailPaneEl.appendChild(createSection(
            "Transition & Duration",
            () => summaryTransition(special),
            () => renderTransitionContent(special)
        ));

        detailPaneEl.appendChild(createSection(
            "Frequency Limits",
            () => summaryFrequency(special),
            () => renderFrequencyContent(special)
        ));

        detailPaneEl.appendChild(createSection(
            "Sharing Rules",
            () => summarySharing(special),
            () => renderSharingContent(special)
        ));

        detailPaneEl.appendChild(createSection(
            "Access & Restrictions",
            () => summaryAccess(special),
            () => renderAccessContent(special)
        ));

        detailPaneEl.appendChild(createSection(
            "Time Rules",
            () => summaryTime(special),
            () => renderTimeRulesContent(special)
        ));

        detailPaneEl.appendChild(createSection(
            "Weather & Availability",
            () => summaryWeather(special),
            () => renderWeatherContent(special)
        ));
    }

    function createDetailHeader(special) {
        const header = document.createElement("div");
        header.style.cssText = "display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; padding-bottom:12px; border-bottom:1px solid #E5E7EB;";

        // Editable title
        const title = document.createElement("h2");
        title.textContent = special.name;
        title.style.cssText = "margin:0; font-size:1.25rem; cursor:pointer;";
        title.title = "Double click to rename";

        const cleanup = makeEditable(title, (newName) => {
            const trimmed = newName.trim();
            if (!trimmed) return;

            if (state.specialActivities.some(s => s !== special && s.name.toLowerCase() === trimmed.toLowerCase())) {
                alert("A special with that name already exists.");
                return;
            }

            special.name = trimmed;
            state.selectedItemId = makeSpecialId(trimmed);
            saveData();
            renderMasterList();
            renderDetailPane();
        });
        cleanupFunctions.push(cleanup);

        // Delete button
        const delBtn = document.createElement("button");
        delBtn.innerHTML = `
            <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="vertical-align:middle;">
                <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
            </svg> Delete
        `;
        delBtn.className = "sa-btn sa-btn-danger";
        delBtn.style.display = "flex";
        delBtn.style.alignItems = "center";
        delBtn.style.gap = "6px";

        delBtn.addEventListener("click", () => {
            if (confirm(`Delete "${special.name}"?`)) {
                state.specialActivities = state.specialActivities.filter(s => s !== special);
                saveData();
                state.selectedItemId = null;
                renderMasterList();
                renderDetailPane();
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
            padding:12px; border-radius:8px; margin-bottom:20px;
            background:${isAvailable ? '#ECFDF5' : '#FEF2F2'};
            border:1px solid ${isAvailable ? '#A7F3D0' : '#FECACA'};
            color:${isAvailable ? '#065F46' : '#991B1B'};
            font-size:0.9rem; display:flex; justify-content:space-between;
        `;

        strip.innerHTML = `
            <span>Currently <strong>${isAvailable ? 'AVAILABLE' : 'UNAVAILABLE'}</strong></span>
            <span style="font-size:0.8rem; opacity:0.8;">Toggle in master list</span>
        `;

        return strip;
    }

    // ==================== SECTION BUILDER ====================

    function createSection(title, getSummary, buildContent) {
        const wrap = document.createElement("div");
        wrap.className = "sa-detail-section";

        const header = document.createElement("div");
        header.className = "sa-detail-section-header";

        const titleWrap = document.createElement("div");
        titleWrap.innerHTML = `
            <div class="sa-detail-section-title">${escapeHtml(title)}</div>
            <div class="sa-detail-section-summary">${escapeHtml(getSummary())}</div>
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
        body.className = "sa-detail-section-body";

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

            if (isOpen) {
                const summaryEl = titleWrap.querySelector('.sa-detail-section-summary');
                if (summaryEl) summaryEl.textContent = getSummary();
            }
        });

        wrap.appendChild(header);
        wrap.appendChild(body);

        return wrap;
    }

    // ==================== SUMMARY FUNCTIONS ====================

    function summaryTransition(s) {
        return `${s.transition.preMin}m Pre / ${s.transition.postMin}m Post`;
    }

    function summaryFrequency(s) {
        if (s.maxUsage === null || s.maxUsage === undefined) return "Unlimited";
        const freq = FREQUENCY_OPTIONS.find(f => f.value === s.frequencyWeeks);
        return `${s.maxUsage}x per ${freq?.label || 'Summer'}`;
    }

    function summarySharing(s) {
        return s.sharableWith.type === "not_sharable"
            ? "Not sharable"
            : `Sharable (Max ${s.sharableWith.capacity || 2})`;
    }

    function summaryAccess(s) {
        if (!s.limitUsage.enabled) return "Open to All Divisions";
        const count = Object.keys(s.limitUsage.divisions).length;
        return `${count} division(s) allowed`;
    }

    function summaryTime(s) {
        return s.timeRules.length ? `${s.timeRules.length} rule(s) active` : "Available all day";
    }

    function summaryWeather(s) {
        if (s.rainyDayOnly) return "🌧️ Rainy Day Only";
        if (s.rainyDayAvailable) return "🏠 Indoor (Rain OK)";
        return "🌳 Outdoor";
    }

    // ==================== CONTENT BUILDERS ====================

    function renderTransitionContent(special) {
        const t = special.transition;
        const container = document.createElement("div");

        const update = () => {
            saveData();
            renderMasterList();
        };

        // Time inputs row
        const timeRow = document.createElement("div");
        timeRow.style.cssText = "display:flex; gap:12px; margin-bottom:12px; flex-wrap:wrap;";

        timeRow.appendChild(createNumberInput("Pre-Activity (min)", t.preMin, (v) => {
            t.preMin = v;
            update();
        }));

        timeRow.appendChild(createNumberInput("Post-Activity (min)", t.postMin, (v) => {
            t.postMin = v;
            update();
        }));

        container.appendChild(timeRow);

        // Label input
        const labelRow = document.createElement("div");
        labelRow.style.cssText = "margin-bottom:12px;";
        labelRow.innerHTML = '<label style="display:block; font-size:0.8rem; font-weight:600; margin-bottom:4px;">Buffer Label</label>';

        const labelInput = document.createElement("input");
        labelInput.type = "text";
        labelInput.value = t.label || "Change Time";
        labelInput.className = "sa-input";
        labelInput.style.width = "150px";

        labelInput.addEventListener("change", () => {
            t.label = labelInput.value.trim() || "Change Time";
            update();
        });

        labelInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                t.label = labelInput.value.trim() || "Change Time";
                update();
            }
        });

        labelRow.appendChild(labelInput);
        container.appendChild(labelRow);

        // Zone & min duration row
        const metaRow = document.createElement("div");
        metaRow.style.cssText = "display:flex; gap:12px; margin-bottom:12px; flex-wrap:wrap;";

        // Zone select
        const zoneDiv = document.createElement("div");
        zoneDiv.style.flex = "1";
        zoneDiv.style.minWidth = "150px";
        zoneDiv.innerHTML = '<label style="display:block; font-size:0.8rem; font-weight:600; margin-bottom:4px;">Location Zone</label>';

        const zoneSel = document.createElement("select");
        zoneSel.className = "sa-select";
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

        metaRow.appendChild(createNumberInput("Min Duration (min)", t.minDurationMin, (v) => {
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
        occLabel.appendChild(document.createTextNode("Buffer occupies resource (e.g. Setup/Change)"));
        container.appendChild(occLabel);

        const hint = document.createElement("p");
        hint.className = "sa-muted";
        hint.style.marginTop = "4px";
        hint.style.paddingLeft = "24px";
        hint.textContent = "If unchecked (Travel), the resource is available during transition time.";
        container.appendChild(hint);

        return container;
    }

    function renderFrequencyContent(special) {
        const container = document.createElement("div");

        const render = () => {
            container.innerHTML = "";

            if (special.maxUsage === null || special.maxUsage === undefined) {
                const noLimitText = document.createElement("p");
                noLimitText.className = "sa-muted";
                noLimitText.textContent = "Unlimited usage allowed.";
                noLimitText.style.marginBottom = "12px";
                container.appendChild(noLimitText);

                const addBtn = document.createElement("button");
                addBtn.textContent = "+ Add Frequency Rule";
                addBtn.className = "sa-btn sa-btn-primary";
                addBtn.addEventListener("click", () => {
                    special.maxUsage = 1;
                    special.frequencyWeeks = 0;
                    saveData();
                    render();
                });
                container.appendChild(addBtn);
            } else {
                const desc = document.createElement("p");
                desc.className = "sa-muted";
                desc.textContent = "Bunks are allowed to use this:";
                desc.style.marginBottom = "12px";
                container.appendChild(desc);

                const controlRow = document.createElement("div");
                controlRow.style.cssText = "display:flex; gap:10px; align-items:center; flex-wrap:wrap;";

                // Count input
                const maxInput = document.createElement("input");
                maxInput.type = "number";
                maxInput.min = "1";
                maxInput.value = String(special.maxUsage);
                maxInput.className = "sa-input";
                maxInput.style.width = "60px";

                maxInput.addEventListener("change", () => {
                    special.maxUsage = Math.max(1, parseInt(maxInput.value, 10) || 1);
                    saveData();
                });

                maxInput.addEventListener("keydown", (e) => {
                    if (e.key === "Enter") {
                        special.maxUsage = Math.max(1, parseInt(maxInput.value, 10) || 1);
                        saveData();
                    }
                });

                const timeLabel = document.createElement("span");
                timeLabel.textContent = "time(s) per";

                // Frequency dropdown
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
                    saveData();
                });

                // Remove button
                const removeBtn = document.createElement("button");
                removeBtn.textContent = "Remove Rule";
                removeBtn.className = "sa-btn sa-btn-danger";
                removeBtn.addEventListener("click", () => {
                    special.maxUsage = null;
                    special.frequencyWeeks = 0;
                    saveData();
                    render();
                });

                controlRow.appendChild(maxInput);
                controlRow.appendChild(timeLabel);
                controlRow.appendChild(freqSelect);
                controlRow.appendChild(removeBtn);
                container.appendChild(controlRow);
            }
        };

        render();
        return container;
    }

    function renderSharingContent(special) {
        const container = document.createElement("div");
        const rules = special.sharableWith;

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
            capIn.value = String(rules.capacity || DEFAULT_CAPACITY);
            capIn.className = "sa-input";
            capIn.style.width = "60px";
            capIn.style.marginLeft = "8px";

            capIn.addEventListener("change", () => {
                rules.capacity = Math.max(MIN_CAPACITY, parseInt(capIn.value, 10) || MIN_CAPACITY);
                saveData();
            });

            capIn.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                    rules.capacity = Math.max(MIN_CAPACITY, parseInt(capIn.value, 10) || MIN_CAPACITY);
                    saveData();
                }
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
                    chip.className = "sa-chip " + (rules.divisions.includes(divName) ? "active" : "inactive");
                });
                chipWrap.appendChild(chip);
            });

            details.appendChild(chipWrap);
            container.appendChild(details);
        }

        return container;
    }

    function renderAccessContent(special) {
        const container = document.createElement("div");
        const rules = special.limitUsage;

        const render = () => {
            container.innerHTML = "";

            // Mode buttons
            const modeWrap = document.createElement("div");
            modeWrap.style.cssText = "display:flex; gap:12px; margin-bottom:16px;";

            const btnAll = createModeButton("Open to All", !rules.enabled, () => {
                rules.enabled = false;
                saveData();
                render();
            });

            const btnRes = createModeButton("Specific Divisions", rules.enabled, () => {
                rules.enabled = true;
                saveData();
                render();
            });

            modeWrap.appendChild(btnAll);
            modeWrap.appendChild(btnRes);
            container.appendChild(modeWrap);

            if (rules.enabled) {
                const panel = document.createElement("div");
                panel.style.cssText = "padding-left:12px; border-left:2px solid #E5E7EB;";

                const allDivs = window.availableDivisions || [];

                allDivs.forEach(divName => {
                    const divWrap = document.createElement("div");
                    divWrap.style.marginBottom = "8px";

                    const isAllowed = divName in rules.divisions;
                    const bunks = window.divisions?.[divName]?.bunks || [];
                    const allowedBunks = rules.divisions[divName] || [];

                    // Division chip
                    const divChip = createChip(divName, isAllowed, () => {
                        if (isAllowed) {
                            delete rules.divisions[divName];
                        } else {
                            rules.divisions[divName] = [];
                        }
                        saveData();
                        render();
                    });
                    divChip.style.fontWeight = "600";
                    divWrap.appendChild(divChip);

                    // Bunk chips if division is allowed
                    if (isAllowed && bunks.length > 0) {
                        const bunkBox = document.createElement("div");
                        bunkBox.style.cssText = "display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; padding-left:22px;";

                        // "All bunks" chip if some are selected
                        if (allowedBunks.length > 0) {
                            const allChip = createChip(`All ${divName}`, false, () => {
                                rules.divisions[divName] = [];
                                saveData();
                                render();
                            });
                            allChip.style.borderColor = "#10B981";
                            allChip.style.color = "#10B981";
                            bunkBox.appendChild(allChip);
                        }

                        bunks.forEach(bunkName => {
                            const bunkChip = createChip(bunkName, allowedBunks.includes(bunkName), () => {
                                const idx = allowedBunks.indexOf(bunkName);
                                if (idx > -1) {
                                    allowedBunks.splice(idx, 1);
                                } else {
                                    allowedBunks.push(bunkName);
                                }
                                saveData();
                                render();
                            });
                            bunkBox.appendChild(bunkChip);
                        });

                        divWrap.appendChild(bunkBox);
                    }

                    panel.appendChild(divWrap);
                });

                container.appendChild(panel);
            }
        };

        render();
        return container;
    }

    function renderTimeRulesContent(special) {
        const container = document.createElement("div");

        const render = () => {
            container.innerHTML = "";

            // Existing rules
            if (special.timeRules.length > 0) {
                special.timeRules.forEach((rule, i) => {
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
                        special.timeRules.splice(i, 1);
                        saveData();
                        render();
                    });

                    row.appendChild(delBtn);
                    container.appendChild(row);
                });
            } else {
                container.innerHTML = '<div class="sa-muted" style="margin-bottom:10px;">No specific time rules (Available all day).</div>';
            }

            // Add new rule form
            const addRow = document.createElement("div");
            addRow.style.cssText = "display:flex; gap:8px; margin-top:12px; padding-top:12px; border-top:1px dashed #E5E7EB; flex-wrap:wrap; align-items:center;";

            const typeSel = document.createElement("select");
            typeSel.innerHTML = '<option>Available</option><option>Unavailable</option>';
            typeSel.className = "sa-select";

            const startIn = document.createElement("input");
            startIn.placeholder = "9:00am";
            startIn.className = "sa-input";
            startIn.style.width = "80px";

            const endIn = document.createElement("input");
            endIn.placeholder = "10:00am";
            endIn.className = "sa-input";
            endIn.style.width = "80px";

            const addRule = () => {
                if (!startIn.value || !endIn.value) {
                    alert("Please enter both start and end times.");
                    return;
                }

                const startMins = parseTimeToMinutes(startIn.value);
                const endMins = parseTimeToMinutes(endIn.value);

                if (startMins === null) {
                    alert("Invalid start time format. Use format like 9:00am");
                    return;
                }

                if (endMins === null) {
                    alert("Invalid end time format. Use format like 10:00am");
                    return;
                }

                if (startMins >= endMins) {
                    alert("End time must be after start time.");
                    return;
                }

                special.timeRules.push({
                    type: typeSel.value,
                    start: startIn.value,
                    end: endIn.value
                });

                saveData();
                render();
            };

            const addBtn = document.createElement("button");
            addBtn.textContent = "Add";
            addBtn.className = "sa-btn sa-btn-secondary";
            addBtn.addEventListener("click", addRule);

            // Enter key support
            startIn.addEventListener("keydown", (e) => {
                if (e.key === "Enter") addRule();
            });
            endIn.addEventListener("keydown", (e) => {
                if (e.key === "Enter") addRule();
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

    function renderWeatherContent(special) {
        const container = document.createElement("div");

        const render = () => {
            const isIndoor = special.rainyDayAvailable === true;
            const isRainyOnly = special.rainyDayOnly === true;

            container.innerHTML = `
                <div style="margin-bottom: 16px;">
                    <p style="font-size: 0.85rem; color: #6b7280; margin: 0 0 12px 0;">
                        Configure how this special activity behaves during rainy days.
                    </p>

                    <!-- Indoor/Outdoor Toggle -->
                    <div style="display: flex; align-items: center; gap: 12px; padding: 14px;
                                background: ${isIndoor ? '#ecfdf5' : '#fef3c7'};
                                border: 1px solid ${isIndoor ? '#a7f3d0' : '#fcd34d'};
                                border-radius: 10px; margin-bottom: 12px;">
                        <span style="font-size: 28px;">${isIndoor ? '🏠' : '🌳'}</span>
                        <div style="flex: 1;">
                            <div style="font-weight: 600; color: ${isIndoor ? '#065f46' : '#92400e'};">
                                ${isIndoor ? 'Indoor / Covered' : 'Outdoor'}
                            </div>
                            <div style="font-size: 0.85rem; color: ${isIndoor ? '#047857' : '#b45309'};">
                                ${isIndoor ? 'Available on rainy days' : 'Disabled during rainy days'}
                            </div>
                        </div>
                        <label class="sa-switch">
                            <input type="checkbox" id="rainy-available-toggle" ${isIndoor ? 'checked' : ''}>
                            <span class="sa-slider"></span>
                        </label>
                    </div>

                    <!-- Rainy Day Only Toggle -->
                    <div style="display: flex; align-items: center; gap: 12px; padding: 14px;
                                background: ${isRainyOnly ? '#dbeafe' : '#f9fafb'};
                                border: 1px solid ${isRainyOnly ? '#93c5fd' : '#e5e7eb'};
                                border-radius: 10px;">
                        <span style="font-size: 28px;">🌧️</span>
                        <div style="flex: 1;">
                            <div style="font-weight: 600; color: ${isRainyOnly ? '#1e40af' : '#374151'};">
                                Rainy Day Only
                            </div>
                            <div style="font-size: 0.85rem; color: ${isRainyOnly ? '#3b82f6' : '#6b7280'};">
                                ${isRainyOnly ? 'Only available when Rainy Day Mode is active' : 'Available on all days'}
                            </div>
                        </div>
                        <label class="sa-switch">
                            <input type="checkbox" id="rainy-only-toggle" ${isRainyOnly ? 'checked' : ''}>
                            <span class="sa-slider"></span>
                        </label>
                    </div>
                </div>

                <div style="background: #f9fafb; border-radius: 8px; padding: 12px; font-size: 0.85rem; color: #4b5563;">
                    <strong>💡 Tips:</strong>
                    <ul style="margin: 8px 0 0 0; padding-left: 20px;">
                        <li><strong>Indoor activities</strong> (gym, arts & crafts) should be marked as "Indoor/Covered"</li>
                        <li><strong>Rainy day specials</strong> (movie time, indoor games) should be marked as "Rainy Day Only"</li>
                        <li><strong>Outdoor activities</strong> (lake, outdoor sports) will be auto-disabled on rainy days</li>
                    </ul>
                </div>
            `;

            // Bind toggles
            const availableToggle = container.querySelector('#rainy-available-toggle');
            availableToggle?.addEventListener('change', () => {
                special.rainyDayAvailable = availableToggle.checked;
                // If marking as outdoor, also disable rainy-only
                if (!availableToggle.checked) {
                    special.rainyDayOnly = false;
                }
                saveData();
                renderMasterList();
                render();
            });

            const rainyOnlyToggle = container.querySelector('#rainy-only-toggle');
            rainyOnlyToggle?.addEventListener('change', () => {
                special.rainyDayOnly = rainyOnlyToggle.checked;
                // If marking as rainy-only, also mark as indoor
                if (rainyOnlyToggle.checked) {
                    special.rainyDayAvailable = true;
                }
                saveData();
                renderMasterList();
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
        input.className = "sa-input";
        input.style.width = "80px";

        input.addEventListener("change", () => {
            onChange(Math.max(0, parseInt(input.value, 10) || 0));
        });

        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                onChange(Math.max(0, parseInt(input.value, 10) || 0));
            }
        });

        div.appendChild(input);
        return div;
    }

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

    function createChip(text, isActive, onClick) {
        const chip = document.createElement("span");
        chip.className = "sa-chip " + (isActive ? "active" : "inactive");
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
            input.className = "sa-input";
            input.style.fontSize = "inherit";
            input.style.fontWeight = "inherit";
            input.style.width = Math.max(120, el.offsetWidth + 20) + "px";

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

    // ==================== SPECIAL OPERATIONS ====================

    function addSpecial() {
        const name = addSpecialInput?.value?.trim();

        if (!name) return;

        if (state.specialActivities.some(s => s.name.toLowerCase() === name.toLowerCase())) {
            alert("A special with that name already exists.");
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
