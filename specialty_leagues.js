// ============================================================================
// specialty_leagues.js — PRODUCTION-READY v2.1 (EMERALD CAMP THEME)
// ============================================================================
// v2.1 AUDIT FIXES:
// - ★ RACE CONDITION FIX: Added _saveInProgress and _lastSaveTime flags
// - ★ IMMEDIATE LOCALSTORAGE: saveData() now writes to localStorage immediately
// - ★ IMPORT FUNCTION FIX: Enhanced schedule import with smart division matching
// - ★ MISSING EXPORTS: Added diagnoseSpecialtyLeagues diagnostic function
// - ★ TYPE SAFETY: Enhanced parseInt fallbacks throughout
// - ★ TAB LISTENER FIX: Consistent target tracking for all event listeners
// - ★ CLOUD SYNC: Added remote-change event handler for real-time updates
// - ★ MEMORY SAFETY: Verified all setInterval/setTimeout have cleanup
// 
// v2.0 PRODUCTION FIXES (preserved):
// - ★ CLOUD SYNC: Proper cloud sync via saveGlobalSettings
// - ★ TAB REFRESH: Refreshes data when tab becomes visible
// - ★ MEMORY LEAK FIX: Proper cleanup of all event listeners
// - ★ DATA VALIDATION: Validates structure on load
// - ★ TYPE CONSISTENCY: Ensures proper number/string handling
// - ★ NULL SAFETY: Added checks for DOM elements and parameters
// - ★ ORPHAN CLEANUP: Validates divisions on load
// - ★ ERROR HANDLING: Added try/catch around risky operations
// - ★ XSS PREVENTION: Added escapeHtml for user content
// - ★ RBAC: Added permission checks for add/delete/save operations
// ----------------------------------------------------------------------------
// Mounts to:  #specialty-leagues
// ============================================================================

(function() {
    'use strict';

    console.log("[SPECIALTY_LEAGUES] Module v2.1 loading...");

    // =============================================================
    // STATE & GLOBALS
    // =============================================================
    let specialtyLeagues = {};
    window.specialtyLeagues = specialtyLeagues; // Expose globally

    // UI State
    let activeLeagueId = null;
    let listEl = null;
    let detailPaneEl = null;
    let addInput = null;
    let _isInitialized = false;
    let _refreshTimeout = null;

    // ★ FIX v2.1: Race condition protection (matches leagues.js pattern)
    let _saveInProgress = false;
    let _lastSaveTime = 0;

    // ★ FIX: Track active event listeners for cleanup (with target info)
    let activeEventListeners = [];

    // ★ FIX: Track cloud sync callback for cleanup
    let _cloudSyncCallback = null;

    // ★ FIX: Tab visibility handlers
    let _visibilityHandler = null;
    let _focusHandler = null;
    let _beforeUnloadHandler = null;

    // =============================================================
    // ★ EVENT LISTENER CLEANUP HELPER
    // =============================================================
    function cleanupEventListeners() {
        activeEventListeners.forEach(({ type, handler, options, target }) => {
            const eventTarget = target || window;
            try {
                eventTarget.removeEventListener(type, handler, options);
            } catch (e) {
                // Ignore errors during cleanup
            }
        });
        activeEventListeners = [];

        // Cleanup cloud sync callback
        if (_cloudSyncCallback && window.SupabaseSync?.removeStatusCallback) {
            window.SupabaseSync.removeStatusCallback(_cloudSyncCallback);
            _cloudSyncCallback = null;
        }

        // Clear any pending refresh timeout
        if (_refreshTimeout) {
            clearTimeout(_refreshTimeout);
            _refreshTimeout = null;
        }
        
        // Clear sync timeout
        if (window._specialtyLeaguesSyncTimeout) {
            clearTimeout(window._specialtyLeaguesSyncTimeout);
            window._specialtyLeaguesSyncTimeout = null;
        }
    }

    function cleanupTabListeners() {
        if (_visibilityHandler) {
            document.removeEventListener('visibilitychange', _visibilityHandler);
            _visibilityHandler = null;
        }
        if (_focusHandler) {
            window.removeEventListener('focus', _focusHandler);
            _focusHandler = null;
        }
        if (_beforeUnloadHandler) {
            window.removeEventListener('beforeunload', _beforeUnloadHandler);
            _beforeUnloadHandler = null;
        }
        if (_refreshTimeout) {
            clearTimeout(_refreshTimeout);
            _refreshTimeout = null;
        }
    }

    // =============================================================
    // ★ TAB VISIBILITY HANDLERS - Refresh data when tab becomes visible
    // =============================================================
    function setupTabListeners() {
        // Cleanup existing listeners first
        cleanupTabListeners();

        // Visibility change handler
        _visibilityHandler = () => {
            if (document.visibilityState === 'visible' && _isInitialized) {
                // ★ FIX v2.1: Check save in progress before refresh
                if (_saveInProgress) {
                    console.log("[SPECIALTY_LEAGUES] Save in progress, skipping refresh");
                    return;
                }
                // Debounce refresh
                if (_refreshTimeout) {
                    clearTimeout(_refreshTimeout);
                }
                _refreshTimeout = setTimeout(() => {
                    console.log("[SPECIALTY_LEAGUES] Tab visible - refreshing data...");
                    refreshFromStorage();
                }, 300);
            }
        };
        document.addEventListener('visibilitychange', _visibilityHandler);
        activeEventListeners.push({ type: 'visibilitychange', handler: _visibilityHandler, target: document });

        // Focus handler
        _focusHandler = () => {
            if (_isInitialized) {
                // ★ FIX v2.1: Check save in progress and protection window
                const timeSinceSave = Date.now() - _lastSaveTime;
                if (_saveInProgress || timeSinceSave < 2000) {
                    console.log("[SPECIALTY_LEAGUES] In protection window, skipping focus refresh");
                    return;
                }
                if (_refreshTimeout) {
                    clearTimeout(_refreshTimeout);
                }
                _refreshTimeout = setTimeout(() => {
                    console.log("[SPECIALTY_LEAGUES] Window focused - refreshing data...");
                    refreshFromStorage();
                }, 300);
            }
        };
        window.addEventListener('focus', _focusHandler);
        activeEventListeners.push({ type: 'focus', handler: _focusHandler, target: window });
    }

    // =============================================================
    // ★ CLOUD SYNC LISTENER - React to remote changes
    // =============================================================
    function setupCloudSyncListener() {
        // Cleanup existing
        if (_cloudSyncCallback && window.SupabaseSync?.removeStatusCallback) {
            window.SupabaseSync.removeStatusCallback(_cloudSyncCallback);
        }

        // Listen for cloud sync events (if the sync system provides callbacks)
        if (window.SupabaseSync?.onStatusChange) {
            _cloudSyncCallback = (status) => {
                if (status === 'idle' && _isInitialized && !_saveInProgress) {
                    // After sync completes, refresh our data
                    console.log("[SPECIALTY_LEAGUES] Cloud sync complete - refreshing...");
                    refreshFromStorage();
                }
            };
            window.SupabaseSync.onStatusChange(_cloudSyncCallback);
        }

        // Also listen for custom campistry events (dispatched by integration_hooks)
        const handleRemoteChange = (event) => {
            if (_isInitialized && !_saveInProgress && 
                (event.detail?.key === 'specialtyLeagues' || event.detail?.key === 'specialtyLeagueHistory')) {
                console.log("[SPECIALTY_LEAGUES] Remote change detected for:", event.detail?.key);
                refreshFromStorage();
            }
        };
        window.addEventListener('campistry-remote-change', handleRemoteChange);
        activeEventListeners.push({ type: 'campistry-remote-change', handler: handleRemoteChange, target: window });
    }

    // =============================================================
    // ★ BEFOREUNLOAD HANDLER - Ensure sync on page exit
    // =============================================================
    function setupBeforeUnloadHandler() {
        // Cleanup existing
        if (_beforeUnloadHandler) {
            window.removeEventListener('beforeunload', _beforeUnloadHandler);
        }

        _beforeUnloadHandler = () => {
            // Force immediate sync on page exit
            if (window._specialtyLeaguesSyncTimeout) {
                clearTimeout(window._specialtyLeaguesSyncTimeout);
                window._specialtyLeaguesSyncTimeout = null;
            }
            window.forceSyncToCloud?.();
        };

        window.addEventListener('beforeunload', _beforeUnloadHandler);
        activeEventListeners.push({ type: 'beforeunload', handler: _beforeUnloadHandler, target: window });
    }

    // =============================================================
    // HELPERS
    // =============================================================
    function uid() {
        return "sl_" + Math.random().toString(36).substring(2, 8);
    }

    /**
     * ★ Escape HTML to prevent XSS attacks
     */
    function escapeHtml(str) {
        if (str === null || str === undefined) return "";
        const div = document.createElement("div");
        div.textContent = String(str);
        return div.innerHTML;
    }

    function getPlaceSuffix(n) {
        const s = ['th', 'st', 'nd', 'rd'];
        const v = n % 100;
        return s[(v - 20) % 10] || s[v] || s[0];
    }

    /**
     * Get valid division names for orphan detection
     */
    function getValidDivisionNames() {
        try {
            const settings = window.loadGlobalSettings?.() || {};
            const divisions = settings.divisions || settings.app1?.divisions || {};
            return new Set(Object.keys(divisions));
        } catch (e) {
            return null;
        }
    }

    /**
     * Get available divisions list
     */
    function getAvailableDivisions() {
        try {
            const settings = window.loadGlobalSettings?.() || {};
            return settings.app1?.availableDivisions || Object.keys(settings.divisions || {}) || [];
        } catch (e) {
            return window.availableDivisions || [];
        }
    }

    /**
     * ★ FIX v2.1: Smart division matching for import (matches leagues.js pattern)
     */
    function getMatchingScheduleDivisions(leagueDivisions, availableDivisions) {
        const matches = [];
        
        for (const leagueDiv of leagueDivisions) {
            const leagueDivLower = String(leagueDiv).toLowerCase().trim();
            
            for (const schedDiv of availableDivisions) {
                const schedDivLower = String(schedDiv).toLowerCase().trim();
                
                // Exact match
                if (leagueDivLower === schedDivLower) {
                    if (!matches.includes(schedDiv)) matches.push(schedDiv);
                    continue;
                }
                
                // Partial match (e.g., "Junior Boys" matches "Junior Boys 1-3")
                if (schedDivLower.includes(leagueDivLower) || leagueDivLower.includes(schedDivLower)) {
                    if (!matches.includes(schedDiv)) matches.push(schedDiv);
                }
            }
        }
        
        return matches;
    }

    // Time Helpers (for schedule import)
    function parseTimeToMinutes(str) {
        if (!str || typeof str !== "string") return null;
        let s = str.trim().toLowerCase();
        let mer = null;
        if (s.endsWith("am") || s.endsWith("pm")) {
            mer = s.endsWith("am") ? "am" : "pm";
            s = s.replace(/am|pm/g, "").trim();
        }
        const m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
        if (!m) return null;
        let hh = parseInt(m[1], 10);
        const mm = parseInt(m[2], 10);
        if (Number.isNaN(hh) || Number.isNaN(mm)) return null;

        if (mer) {
            if (hh === 12) hh = mer === "am" ? 0 : 12;
            else if (mer === "pm") hh += 12;
        } else {
            // Assume PM for afternoon hours (1-6)
            if (hh >= 1 && hh <= 6) hh += 12;
        }
        return hh * 60 + mm;
    }

    function minutesToTimeLabel(min) {
        if (min === null || min === undefined || isNaN(min)) return '';
        const h24 = Math.floor(min / 60);
        const m = String(min % 60).padStart(2, "0");
        const ap = h24 >= 12 ? "PM" : "AM";
        const h12 = h24 % 12 || 12;
        return `${h12}:${m} ${ap}`;
    }

    function findSlotIndexForTime(targetMin) {
        const times = window.unifiedTimes || [];
        const INCREMENT_MINS = window.INCREMENT_MINS || 30;

        for (let i = 0; i < times.length; i++) {
            const d = new Date(times[i].start);
            const slotStart = d.getHours() * 60 + d.getMinutes();
            let slotEnd;

            if (times[i].end) {
                const e = new Date(times[i].end);
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

    function makeEditable(el, saveCallback) {
        if (!el) return;
        el.ondblclick = (e) => {
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

            const finish = () => {
                const newVal = input.value.trim();
                if (newVal && newVal !== oldText) saveCallback(newVal);
                el.textContent = newVal || oldText;
                input.replaceWith(el);
            };

            input.onblur = finish;
            input.onkeyup = (ev) => {
                if (ev.key === 'Enter') finish();
            };
        };
    }

    // =============================================================
    // ★ DATA VALIDATION - Ensure league structure is valid
    // =============================================================
    function validateLeague(league, leagueId) {
        if (!league || typeof league !== 'object') {
            return {
                id: leagueId,
                name: 'Unnamed League',
                divisions: [],
                sport: null,
                fields: [],
                teams: [],
                enabled: true,
                standings: {},
                games: []
            };
        }

        // Get valid divisions for orphan detection
        const validDivisions = getValidDivisionNames();

        // Ensure all required properties exist with correct types
        const validated = {
            id: league.id || leagueId,
            name: typeof league.name === 'string' ? league.name : 'Unnamed League',
            divisions: Array.isArray(league.divisions) ? league.divisions.filter(d => typeof d === 'string') : [],
            sport: typeof league.sport === 'string' ? league.sport : null,
            fields: Array.isArray(league.fields) ? league.fields.filter(f => typeof f === 'string') : [],
            teams: Array.isArray(league.teams) ? league.teams.filter(t => typeof t === 'string') : [],
            enabled: league.enabled !== false,
            standings: (league.standings && typeof league.standings === 'object') ? league.standings : {},
            games: Array.isArray(league.games) ? league.games : []
        };

        // ★ Filter out orphaned divisions (divisions that no longer exist)
        if (validDivisions) {
            const originalCount = validated.divisions.length;
            validated.divisions = validated.divisions.filter(d => validDivisions.has(d));
            if (validated.divisions.length < originalCount) {
                console.log(`[SPECIALTY_LEAGUES] Removed ${originalCount - validated.divisions.length} orphaned divisions from league "${validated.name}"`);
            }
        }

        // Ensure standings exist for all teams
        validated.teams.forEach(t => {
            if (!validated.standings[t]) {
                validated.standings[t] = { w: 0, l: 0, t: 0 };
            }
        });

        // Remove standings for teams that no longer exist
        Object.keys(validated.standings).forEach(team => {
            if (!validated.teams.includes(team)) {
                delete validated.standings[team];
            }
        });

        return validated;
    }

    // =============================================================
    // LOAD + SAVE
    // =============================================================
    function loadData() {
        try {
            const g = window.loadGlobalSettings?.() || {};
            const loaded = g.specialtyLeagues || {};
            
            // Clear and fill with validated data
            Object.keys(specialtyLeagues).forEach(k => delete specialtyLeagues[k]);
            
            Object.keys(loaded).forEach(leagueId => {
                specialtyLeagues[leagueId] = validateLeague(loaded[leagueId], leagueId);
            });

            console.log("[SPECIALTY_LEAGUES] Data loaded:", {
                leagues: Object.keys(specialtyLeagues).length
            });
        } catch (e) {
            console.error("[SPECIALTY_LEAGUES] Load failed:", e);
        }
    }

    /**
     * Refresh data from storage (call when tab becomes visible or after cloud sync)
     */
    function refreshFromStorage() {
        // ★ FIX v2.1: Check protection window
        const timeSinceSave = Date.now() - _lastSaveTime;
        if (_saveInProgress || timeSinceSave < 2000) {
            console.log("[SPECIALTY_LEAGUES] In protection window, skipping refresh");
            return;
        }

        // ★ FIX: Store previous state for proper comparison
        const previousDataJson = JSON.stringify(specialtyLeagues);
        const previousSelected = activeLeagueId;

        loadData();

        // If selected league no longer exists, clear selection
        if (activeLeagueId && !specialtyLeagues[activeLeagueId]) {
            activeLeagueId = null;
        }

        // ★ FIX: Compare actual content, not just counts
        const newDataJson = JSON.stringify(specialtyLeagues);
        const dataChanged = previousDataJson !== newDataJson ||
            previousSelected !== activeLeagueId;

        if (dataChanged) {
            console.log("[SPECIALTY_LEAGUES] Data changed - re-rendering UI");
            if (listEl) renderMasterList();
            if (detailPaneEl) renderDetailPane();
        } else {
            console.log("[SPECIALTY_LEAGUES] Data unchanged - skipping re-render");
        }
    }

    function saveData() {
        // ✅ RBAC Check for modifications
        if (window.AccessControl?.canEditSetup && !window.AccessControl.canEditSetup()) {
            console.warn('[SPECIALTY_LEAGUES] Save blocked - insufficient permissions');
            return;
        }

        try {
            // ★ FIX v2.1: Set protection flags (matches leagues.js pattern)
            _saveInProgress = true;
            _lastSaveTime = Date.now();

            // ★ FIX v2.1: Write to localStorage immediately (prevents race conditions)
            try {
                const lsKey = 'campistryGlobalSettings';
                const lsRaw = localStorage.getItem(lsKey);
                const lsData = lsRaw ? JSON.parse(lsRaw) : {};
                lsData.specialtyLeagues = specialtyLeagues;
                lsData.updated_at = new Date().toISOString();
                localStorage.setItem(lsKey, JSON.stringify(lsData));
                console.log("[SPECIALTY_LEAGUES] Data written to localStorage immediately");
            } catch (lsErr) {
                console.warn("[SPECIALTY_LEAGUES] localStorage write failed:", lsErr);
            }

            // ★ Save via saveGlobalSettings (handles batching + cloud sync)
            window.saveGlobalSettings?.("specialtyLeagues", specialtyLeagues);
            
            console.log("[SPECIALTY_LEAGUES] Data saved to cloud");

            // ★ Clear protection flag after delay
            setTimeout(() => {
                _saveInProgress = false;
            }, 500);
        } catch (e) {
            console.error("[SPECIALTY_LEAGUES] Save failed:", e);
            _saveInProgress = false;
        }
    }

    // =============================================================
    // INIT TAB
    // =============================================================
    window.initSpecialtyLeagues = function() {
        const container = document.getElementById("specialty-leagues");
        if (!container) return;

        // ★ Cleanup previous state if re-initializing
        cleanupEventListeners();
        cleanupTabListeners();

        loadData();

        // ---------------------------------------------------------
        // MAIN TEMPLATE
        // ---------------------------------------------------------
        container.innerHTML = `
            <div class="setup-grid">
                <section class="setup-card setup-card-wide">
                    <div class="setup-card-header">
                        <span class="setup-step-pill">Specialty Leagues</span>
                        <div class="setup-card-text">
                            <h3>Manage Specialty Leagues</h3>
                            <p>Configure themed tournaments, one-off cups, and activity-specific leagues.</p>
                        </div>
                    </div>

                    <div style="display:flex; flex-wrap:wrap; gap:20px; margin-top:10px;">
                        <!-- LEFT COL: MASTER LIST -->
                        <div style="flex:1; min-width:260px;">
                            <div class="setup-subtitle">All Leagues</div>
                            <p style="font-size:0.8rem; color:#6b7280; margin-top:4px;">
                                Select a league to edit. Double-click title to rename.
                            </p>
                            
                            <div class="setup-field-row" style="margin-top:10px;">
                                <input id="sl-add-input" placeholder="Name (e.g. 'Soccer Cup')" class="form-input">
                                <button id="sl-add-btn" class="btn btn-primary" style="white-space:nowrap;">+ Add</button>
                            </div>
                            
                            <div id="sl-master-list" class="settings-list" style="margin-top:12px; max-height:420px; overflow-y:auto;"></div>
                        </div>

                        <!-- RIGHT COL: DETAIL PANE -->
                        <div style="flex:1.6; min-width:340px;">
                            <div class="setup-subtitle">League Configuration</div>
                            <div id="sl-detail-pane" style="margin-top:8px;"></div>
                        </div>
                    </div>
                </section>
            </div>`;

        // Cache DOM refs
        listEl = document.getElementById("sl-master-list");
        detailPaneEl = document.getElementById("sl-detail-pane");
        addInput = document.getElementById("sl-add-input");
        const addBtn = document.getElementById("sl-add-btn");

        // ---------------------------------------------------------
        // ADD NEW LEAGUE
        // ---------------------------------------------------------
        const addLeague = () => {
            // RBAC check
            if (!window.AccessControl?.checkSetupAccess('add specialty leagues')) return;

            if (!addInput) return;
            const name = addInput.value.trim();
            if (!name) return;

            const id = uid();
            specialtyLeagues[id] = {
                id,
                name,
                divisions: [],
                sport: null,
                fields: [],
                teams: [],
                enabled: true,
                standings: {},
                games: []
            };

            saveData();
            activeLeagueId = id;
            addInput.value = "";
            renderMasterList();
            renderDetailPane();
        };

        if (addBtn) {
            addBtn.onclick = addLeague;
        }
        if (addInput) {
            addInput.onkeyup = e => e.key === "Enter" && addLeague();
        }

        // ★ Setup event listeners for tab visibility and cloud sync
        setupTabListeners();
        setupCloudSyncListener();
        setupBeforeUnloadHandler();

        _isInitialized = true;

        renderMasterList();
        if (activeLeagueId && specialtyLeagues[activeLeagueId]) {
            renderDetailPane();
        }

        console.log("[SPECIALTY_LEAGUES] Initialized:", {
            leagues: Object.keys(specialtyLeagues).length
        });
    };

    // =============================================================
    // MASTER LIST
    // =============================================================
    function renderMasterList() {
        // ★ NULL SAFETY
        if (!listEl) return;
        
        try {
            listEl.innerHTML = "";
            const items = Object.values(specialtyLeagues).sort((a,b) => a.name.localeCompare(b.name));

            if (items.length === 0) {
                listEl.innerHTML = `<p class="muted">No specialty leagues yet.</p>`;
                return;
            }

            items.forEach(l => {
                const el = document.createElement("div");
                el.className = "list-item";
                if (l.id === activeLeagueId) el.classList.add("selected");
                
                el.onclick = () => {
                    activeLeagueId = l.id;
                    renderMasterList();
                    renderDetailPane();
                };

                // ★ XSS PREVENTION: Use textContent
                const nameSpan = document.createElement("span");
                nameSpan.className = "list-item-name";
                nameSpan.textContent = l.name;
                el.appendChild(nameSpan);

                // Toggle
                const tog = document.createElement("label");
                tog.className = "switch";
                tog.onclick = e => e.stopPropagation();
                
                const cb = document.createElement("input");
                cb.type = "checkbox";
                cb.checked = l.enabled;
                cb.onchange = () => {
                    l.enabled = cb.checked;
                    saveData();
                };
                
                const slider = document.createElement("span");
                slider.className = "slider";
                
                tog.append(cb, slider);
                el.appendChild(tog);
                listEl.appendChild(el);
            });
        } catch (e) {
            console.error("[SPECIALTY_LEAGUES] Error rendering master list:", e);
        }
    }

    // =============================================================
    // DETAIL PANE
    // =============================================================
    function renderDetailPane() {
        // ★ NULL SAFETY
        if (!detailPaneEl) return;
        
        try {
            if (!activeLeagueId || !specialtyLeagues[activeLeagueId]) {
                detailPaneEl.innerHTML = `<p class="muted">Select a league.</p>`;
                return;
            }

            const league = specialtyLeagues[activeLeagueId];
            detailPaneEl.innerHTML = "";

            // --- HEADER ---
            const header = document.createElement('div');
            Object.assign(header.style, {
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '15px',
                borderBottom: '2px solid #E5E7EB',
                paddingBottom: '10px'
            });

            const title = document.createElement('h3');
            title.style.margin = '0';
            title.style.fontSize = '1.1rem';
            title.textContent = league.name;
            title.title = "Double-click to rename";
            makeEditable(title, (newName) => {
                league.name = newName;
                saveData();
                renderMasterList();
            });

            const btnGroup = document.createElement('div');
            btnGroup.style.display = 'flex';
            btnGroup.style.gap = '8px';

            // EDIT SETUP BTN
            const editConfigBtn = document.createElement('button');
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

            // DELETE BTN
            const delBtn = document.createElement('button');
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
            delBtn.onmouseenter = () => { delBtn.style.background = '#FEE2E2'; };
            delBtn.onmouseleave = () => { delBtn.style.background = '#FFFFFF'; };
            delBtn.onclick = () => {
                if (!window.AccessControl?.checkSetupAccess('delete specialty leagues')) return;
                if (confirm(`Delete "${escapeHtml(league.name)}"?`)) {
                    delete specialtyLeagues[league.id];
                    activeLeagueId = null;
                    saveData();
                    renderMasterList();
                    renderDetailPane();
                }
            };

            btnGroup.append(editConfigBtn, delBtn);
            header.append(title, btnGroup);
            detailPaneEl.appendChild(header);

            // --- CONFIG CONTAINER (Hidden by default) ---
            const configContainer = document.createElement('div');
            Object.assign(configContainer.style, {
                display: 'none',
                marginBottom: '20px',
                animation: 'fadeIn 0.2s ease-in-out'
            });

            renderConfigSections(league, configContainer);
            detailPaneEl.appendChild(configContainer);

            editConfigBtn.onclick = () => {
                const hidden = configContainer.style.display === 'none';
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

            // --- MAIN CONTENT ---
            const mainContent = document.createElement('div');
            renderGameResultsUI(league, mainContent);
            detailPaneEl.appendChild(mainContent);
        } catch (e) {
            console.error("[SPECIALTY_LEAGUES] Error rendering detail pane:", e);
        }
    }

    // =============================================================
    // CONFIG SECTIONS (Cards)
    // =============================================================
    function renderConfigSections(league, container) {
        if (!container) return;
        
        try {
            container.innerHTML = '';

            // CARD 1: DIVISIONS
            const divCard = document.createElement('div');
            divCard.className = 'league-section-card';
            divCard.innerHTML = `
                <div class="league-section-header">
                    <span class="league-section-title">Divisions</span>
                    <span>Participants</span>
                </div>
            `;
            const divChips = document.createElement('div');
            divChips.className = 'chips';
            
            // ★ FIX: Use getAvailableDivisions() instead of deprecated window.availableDivisions
            const availableDivs = getAvailableDivisions();
            availableDivs.forEach((divName) => {
                const isActive = league.divisions.includes(divName);
                const chip = document.createElement('span');
                chip.className = 'chip' + (isActive ? ' active' : '');
                chip.textContent = divName;
                chip.onclick = () => {
                    if (isActive) league.divisions = league.divisions.filter(d => d !== divName);
                    else league.divisions.push(divName);
                    saveData();
                    renderConfigSections(league, container);
                };
                divChips.appendChild(chip);
            });
            divCard.appendChild(divChips);
            container.appendChild(divCard);

            // CARD 2: SPORT (Single Select)
            const sportCard = document.createElement('div');
            sportCard.className = 'league-section-card';
            sportCard.innerHTML = `
                <div class="league-section-header">
                    <span class="league-section-title">Sport / Activity</span>
                    <span>Select One</span>
                </div>
            `;
            const sportChips = document.createElement('div');
            sportChips.className = 'chips';
            (window.getAllGlobalSports?.() || []).forEach((act) => {
                const isActive = league.sport === act;
                const chip = document.createElement('span');
                chip.className = 'chip' + (isActive ? ' active' : '');
                chip.textContent = act;
                chip.onclick = () => {
                    league.sport = isActive ? null : act;
                    if(!isActive) league.fields = [];
                    saveData();
                    renderConfigSections(league, container);
                };
                sportChips.appendChild(chip);
            });
            sportCard.appendChild(sportChips);
            container.appendChild(sportCard);

            // CARD 3: FIELDS (Dependent on Sport)
            if (league.sport) {
                const fieldCard = document.createElement('div');
                fieldCard.className = 'league-section-card';
                fieldCard.innerHTML = `
                    <div class="league-section-header">
                        <span class="league-section-title">Fields</span>
                        <span>For Schedule Import</span>
                    </div>
                `;
                const fieldChips = document.createElement('div');
                fieldChips.className = 'chips';
                
                // ★ FIX: Null-safe access to fields
                const settings = window.loadGlobalSettings?.() || {};
                const globalFields = settings.fields || settings.app1?.fields || [];
                const sportFields = globalFields
                    .filter(f => f && f.name && (Array.isArray(f.activities) ? f.activities.includes(league.sport) : false))
                    .map(f => f.name);

                sportFields.forEach((fieldName) => {
                    const isActive = league.fields.includes(fieldName);
                    const chip = document.createElement('span');
                    chip.className = 'chip' + (isActive ? ' active' : '');
                    chip.textContent = fieldName;
                    chip.onclick = () => {
                        if (isActive) league.fields = league.fields.filter(f => f !== fieldName);
                        else league.fields.push(fieldName);
                        saveData();
                        renderConfigSections(league, container);
                    };
                    fieldChips.appendChild(chip);
                });

                if (sportFields.length === 0) {
                    const noFields = document.createElement('p');
                    noFields.className = 'muted';
                    noFields.style.fontSize = '0.8rem';
                    noFields.textContent = `No fields configured for ${league.sport}. Add them in Fields tab.`;
                    fieldChips.appendChild(noFields);
                }

                fieldCard.appendChild(fieldChips);
                container.appendChild(fieldCard);
            }

            // CARD 4: TEAMS
            const teamCard = document.createElement('div');
            teamCard.className = 'league-section-card';
            teamCard.innerHTML = `
                <div class="league-section-header">
                    <span class="league-section-title">Teams</span>
                    <span>Roster</span>
                </div>
            `;
            const teamList = document.createElement('div');
            teamList.className = 'chips';
            (league.teams || []).forEach(t => {
                const chip = document.createElement('span');
                chip.className = 'chip active';
                chip.innerHTML = `${escapeHtml(t)} <span class="remove-btn" style="margin-left:6px; cursor:pointer;">&times;</span>`;
                chip.querySelector('.remove-btn').onclick = (e) => {
                    e.stopPropagation();
                    league.teams = league.teams.filter(x => x !== t);
                    delete league.standings[t];
                    saveData();
                    renderConfigSections(league, container);
                };
                teamList.appendChild(chip);
            });
            teamCard.appendChild(teamList);

            const teamInput = document.createElement('input');
            teamInput.placeholder = 'Type team name & press Enter...';
            teamInput.style.marginTop = '10px';
            teamInput.style.width = '100%';
            teamInput.onkeyup = e => {
                if (e.key === 'Enter' && teamInput.value.trim()) {
                    const t = teamInput.value.trim();
                    if (!league.teams.includes(t)) {
                        league.teams.push(t);
                        league.standings[t] = { w: 0, l: 0, t: 0 };
                        saveData();
                        renderConfigSections(league, container);
                        const inputs = container.querySelectorAll('input');
                        if(inputs.length) inputs[inputs.length - 1].focus();
                    }
                }
            };
            teamCard.appendChild(teamInput);
            container.appendChild(teamCard);
        } catch (e) {
            console.error("[SPECIALTY_LEAGUES] Error rendering config sections:", e);
        }
    }

    // =============================================================
    // MAIN UI: STANDINGS VS GAMES
    // =============================================================
    function renderGameResultsUI(league, container) {
        container.innerHTML = '';
        const tabNav = document.createElement('div');
        tabNav.style.marginBottom = '15px';
        tabNav.style.display = 'flex';
        tabNav.style.gap = '8px';
        tabNav.innerHTML = `
            <button id="sl-tab-standings" class="active">Current Standings</button>
            <button id="sl-tab-games">Game Results / History</button>
        `;
        container.appendChild(tabNav);

        const standingsDiv = document.createElement('div');
        const gamesDiv = document.createElement('div');
        gamesDiv.style.display = 'none';

        renderStandingsTable(league, standingsDiv);
        renderGameEntryUI(league, gamesDiv);

        container.appendChild(standingsDiv);
        container.appendChild(gamesDiv);

        const btnStandings = container.querySelector('#sl-tab-standings');
        const btnGames = container.querySelector('#sl-tab-games');

        if (btnStandings && btnGames) {
            btnStandings.onclick = () => {
                btnStandings.classList.add('active');
                btnGames.classList.remove('active');
                standingsDiv.style.display = 'block';
                gamesDiv.style.display = 'none';
            };
            btnGames.onclick = () => {
                btnGames.classList.add('active');
                btnStandings.classList.remove('active');
                gamesDiv.style.display = 'block';
                standingsDiv.style.display = 'none';
            };
        }
    }

    // =============================================================
    // STANDINGS TABLE
    // =============================================================
    function renderStandingsTable(league, container) {
        if (!container) return;
        
        try {
            container.innerHTML = '';

            if (!league.teams || league.teams.length === 0) {
                container.innerHTML = `<p class="muted" style="text-align:center; margin-top:20px;">Add teams in Edit Setup to see standings.</p>`;
                return;
            }

            // Sort teams by wins, then by losses (ascending)
            const sorted = [...league.teams].sort((a, b) => {
                const sA = league.standings[a] || { w: 0, l: 0, t: 0 };
                const sB = league.standings[b] || { w: 0, l: 0, t: 0 };
                if (sB.w !== sA.w) return sB.w - sA.w;
                if (sA.l !== sB.l) return sA.l - sB.l;
                return sB.t - sA.t;
            });

            const table = document.createElement('table');
            Object.assign(table.style, {
                width: '100%',
                borderCollapse: 'collapse',
                background: '#FFFFFF',
                borderRadius: '12px',
                overflow: 'hidden',
                boxShadow: '0 4px 12px rgba(0,0,0,0.06)'
            });

            // Header
            const thead = document.createElement('thead');
            thead.innerHTML = `
                <tr style="background:#F9FAFB;">
                    <th style="padding:12px 16px; text-align:left; font-weight:600; color:#6B7280; font-size:0.85rem;">Place</th>
                    <th style="padding:12px 16px; text-align:left; font-weight:600; color:#6B7280; font-size:0.85rem;">Team</th>
                    <th style="padding:12px; text-align:center; font-weight:600; color:#6B7280; font-size:0.85rem;">W</th>
                    <th style="padding:12px; text-align:center; font-weight:600; color:#6B7280; font-size:0.85rem;">L</th>
                    <th style="padding:12px; text-align:center; font-weight:600; color:#6B7280; font-size:0.85rem;">T</th>
                </tr>
            `;
            table.appendChild(thead);

            const tbody = document.createElement('tbody');
            sorted.forEach((team, idx) => {
                const stats = league.standings[team] || { w: 0, l: 0, t: 0 };
                const isLast = idx === sorted.length - 1;
                const borderBottom = !isLast ? '1px solid #F3F4F6' : 'none';
                
                const row = document.createElement('tr');
                
                // Place
                const tdPlace = document.createElement('td');
                Object.assign(tdPlace.style, { padding: '12px 16px', borderBottom, fontWeight: '600', color: '#111827' });
                tdPlace.textContent = `${idx + 1}${getPlaceSuffix(idx + 1)}`;
                row.appendChild(tdPlace);
                
                // Team name - ★ XSS SAFE via textContent
                const tdTeam = document.createElement('td');
                Object.assign(tdTeam.style, { padding: '12px 16px', borderBottom, fontWeight: '500' });
                tdTeam.textContent = team;
                row.appendChild(tdTeam);
                
                // Wins
                const tdW = document.createElement('td');
                Object.assign(tdW.style, { padding: '12px', borderBottom, textAlign: 'center', color: '#059669', fontWeight: '600' });
                tdW.textContent = stats.w;
                row.appendChild(tdW);
                
                // Losses
                const tdL = document.createElement('td');
                Object.assign(tdL.style, { padding: '12px', borderBottom, textAlign: 'center', color: '#DC2626' });
                tdL.textContent = stats.l;
                row.appendChild(tdL);
                
                // Ties
                const tdT = document.createElement('td');
                Object.assign(tdT.style, { padding: '12px', borderBottom, textAlign: 'center', color: '#6B7280' });
                tdT.textContent = stats.t;
                row.appendChild(tdT);
                
                tbody.appendChild(row);
            });
            
            table.appendChild(tbody);
            container.appendChild(table);
        } catch (e) {
            console.error("[SPECIALTY_LEAGUES] Error rendering standings table:", e);
        }
    }

    // =============================================================
    // GAME ENTRY
    // =============================================================
    function renderGameEntryUI(league, container) {
        container.innerHTML = '';

        const controls = document.createElement('div');
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

        const select = document.createElement('select');
        select.style.flex = "1";
        select.innerHTML = `<option value="new">-- Enter New Game Results --</option>`;
        (league.games || []).forEach((g, idx) => {
            const label = g.name || `Game ${idx + 1}`;
            select.innerHTML += `<option value="${idx}">${escapeHtml(label)} (${escapeHtml(g.date || 'Unknown')})</option>`;
        });

        const importBtn = document.createElement('button');
        importBtn.textContent = "Import Today's Schedule";
        Object.assign(importBtn.style, {
            background: '#00C896',
            color: 'white',
            border: 'none',
            borderRadius: '8px',
            padding: '8px 16px',
            boxShadow: '0 2px 4px rgba(0, 200, 150, 0.3)',
            fontWeight: '600',
            cursor: 'pointer'
        });

        controls.appendChild(select);
        controls.appendChild(importBtn);

        const matchContainer = document.createElement('div');
        matchContainer.style.maxHeight = '420px';
        matchContainer.style.overflowY = 'auto';
        matchContainer.style.padding = '4px';

        container.appendChild(controls);
        container.appendChild(matchContainer);

        const saveBtn = document.createElement('button');
        saveBtn.textContent = 'Save Game Results';
        Object.assign(saveBtn.style, {
            marginTop: '15px',
            width: '100%',
            background: '#00C896',
            color: 'white',
            border: 'none',
            borderRadius: '8px',
            padding: '12px',
            display: 'none',
            fontWeight: '600',
            cursor: 'pointer',
            boxShadow: '0 3px 8px rgba(0, 200, 150, 0.35)'
        });
        saveBtn.dataset.role = 'save-game-results';
        saveBtn.onclick = () => saveGameResults(league, select.value, matchContainer);

        container.appendChild(saveBtn);

        importBtn.onclick = () => importGamesFromSchedule(league, matchContainer);

        select.onchange = () => {
            matchContainer.innerHTML = '';
            if (select.value === 'new') {
                importBtn.style.display = 'inline-block';
                saveBtn.style.display = 'none';
            } else {
                importBtn.style.display = 'none';
                saveBtn.style.display = 'block';
                loadExistingGame(league, select.value, matchContainer, saveBtn);
            }
        };

        function loadExistingGame(leagueObj, gameIdx, target, saveButton) {
            const game = leagueObj.games[parseInt(gameIdx, 10)];
            if (!game) return;
            const groupedMatches = {};
            (game.matches || []).forEach((m) => {
                const label = m.timeLabel || 'Matchups';
                if (!groupedMatches[label]) groupedMatches[label] = [];
                groupedMatches[label].push(m);
            });

            const labels = Object.keys(groupedMatches).sort((a, b) => {
                return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
            });

            labels.forEach((label) => {
                const header = document.createElement('div');
                header.className = 'group-header';
                header.textContent = label;
                target.appendChild(header);
                groupedMatches[label].forEach((m) => {
                    addMatchRow(target, m.teamA, m.teamB, m.scoreA || '', m.scoreB || '', saveButton, label);
                });
            });
        }
    }

    function addMatchRow(target, teamA, teamB, scoreA = '', scoreB = '', saveButton, timeLabel = '') {
        if (!target) return;
        
        const row = document.createElement('div');
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

        // ★ XSS PREVENTION: Build row using DOM methods
        // Team A
        const teamALabel = document.createElement('strong');
        Object.assign(teamALabel.style, { flex: '1', textAlign: 'right', fontSize: '0.9rem' });
        teamALabel.textContent = teamA;
        row.appendChild(teamALabel);
        
        // Score A input
        const scoreAInput = document.createElement('input');
        scoreAInput.type = 'number';
        scoreAInput.className = 'score-a';
        scoreAInput.value = scoreA;
        Object.assign(scoreAInput.style, { width: '50px', textAlign: 'center', padding: '6px', fontWeight: 'bold', borderColor: '#9CA3AF', borderRadius: '6px', border: '1px solid #D1D5DB' });
        row.appendChild(scoreAInput);
        
        // VS label
        const vsLabel = document.createElement('span');
        Object.assign(vsLabel.style, { color: '#6B7280', fontSize: '0.8rem', fontWeight: 'bold' });
        vsLabel.textContent = 'VS';
        row.appendChild(vsLabel);
        
        // Score B input
        const scoreBInput = document.createElement('input');
        scoreBInput.type = 'number';
        scoreBInput.className = 'score-b';
        scoreBInput.value = scoreB;
        Object.assign(scoreBInput.style, { width: '50px', textAlign: 'center', padding: '6px', fontWeight: 'bold', borderColor: '#9CA3AF', borderRadius: '6px', border: '1px solid #D1D5DB' });
        row.appendChild(scoreBInput);
        
        // Team B
        const teamBLabel = document.createElement('strong');
        Object.assign(teamBLabel.style, { flex: '1', fontSize: '0.9rem' });
        teamBLabel.textContent = teamB;
        row.appendChild(teamBLabel);

        row.dataset.teamA = teamA;
        row.dataset.teamB = teamB;
        if (timeLabel) row.dataset.timeLabel = timeLabel;

        target.appendChild(row);
        if (saveButton) saveButton.style.display = 'block';
    }

    // =============================================================
    // IMPORT LOGIC (SPECIALTY SPECIFIC) - ★ FIX v2.1: Enhanced
    // =============================================================
    function importGamesFromSchedule(league, target) {
        if (!target) return;
        
        try {
            target.innerHTML = '';
            
            const daily = window.loadCurrentDailyData?.() || {};
            const skeleton = daily.manualSkeleton || [];
            const assignments = daily.scheduleAssignments || window.scheduleAssignments || {};
            const leagueAssignments = window.leagueAssignments || {};
            const divisions = window.divisions || {};
            
            const saveButton = target.parentElement?.querySelector('[data-role="save-game-results"]');

            if (!league.teams || league.teams.length === 0) {
                target.innerHTML = `<p class="muted" style="text-align:center; margin-top:20px;">Add teams to this league first.</p>`;
                return;
            }

            const gamesFound = {};

            // ★ FIX v2.1: Use smart division matching (same pattern as leagues.js)
            const availableScheduleDivisions = Object.keys(leagueAssignments);
            const matchingDivisions = getMatchingScheduleDivisions(league.divisions || [], availableScheduleDivisions);
            
            console.log('[SPECIALTY_LEAGUES] Import: Looking for games for league "' + league.name + '"');
            console.log('[SPECIALTY_LEAGUES] Import: League divisions:', league.divisions);
            console.log('[SPECIALTY_LEAGUES] Import: Matching divisions found:', matchingDivisions);

            // Method 1: Check leagueAssignments for specialty league entries
            for (const divName of matchingDivisions) {
                const divAssignments = leagueAssignments[divName];
                if (!divAssignments) continue;

                for (const slotIdx of Object.keys(divAssignments)) {
                    const slotData = divAssignments[slotIdx];
                    if (!slotData) continue;
                    
                    // Check if this is our specialty league
                    const isOurLeague = slotData.isSpecialtyLeague && 
                        (slotData.leagueName === league.name || slotData.sport === league.sport);
                    
                    if (!isOurLeague) continue;

                    const gameLabel = slotData.gameLabel || `Slot ${slotIdx}`;
                    const matchups = slotData.matchups || [];
                    
                    matchups.forEach(m => {
                        const teamA = m.teamA?.trim();
                        const teamB = m.teamB?.trim();
                        
                        if (teamA && teamB && league.teams.includes(teamA) && league.teams.includes(teamB)) {
                            if (!gamesFound[gameLabel]) gamesFound[gameLabel] = [];
                            
                            const exists = gamesFound[gameLabel].some(g =>
                                (g.teamA === teamA && g.teamB === teamB) ||
                                (g.teamA === teamB && g.teamB === teamA)
                            );
                            
                            if (!exists) {
                                gamesFound[gameLabel].push({ teamA, teamB });
                                console.log('[SPECIALTY_LEAGUES] Import: Added match:', teamA, 'vs', teamB, 'to', gameLabel);
                            }
                        }
                    });
                }
            }

            // Method 2: Iterate over skeleton blocks as fallback
            if (Object.keys(gamesFound).length === 0) {
                skeleton.forEach(block => {
                    if (!block || !block.division) return;
                    
                    // Must match division
                    if (!league.divisions.includes(block.division)) return;

                    // Get assignments
                    const startMin = parseTimeToMinutes(block.startTime);
                    if (startMin === null) return;
                    
                    const slotIdx = findSlotIndexForTime(startMin);
                    if (slotIdx === -1) return;

                    const divBunks = divisions[block.division]?.bunks || [];
                    if (divBunks.length === 0) return;
                    const representativeBunk = divBunks[0];
                    
                    const entry = assignments[representativeBunk]?.[slotIdx];
                    if (!entry) return;

                    // CRITERIA FOR SPECIALTY LEAGUES:
                    const entrySport = (entry.sport || "").trim();
                    const entryField = (typeof entry.field === 'string' ? entry.field : "").trim();

                    const matchSport = league.sport && entrySport === league.sport;
                    const matchField = league.fields.includes(entryField);

                    if (!matchSport && !matchField) return;

                    let headerLabel = `${block.event || 'Activity'} (${minutesToTimeLabel(startMin)})`;

                    // Scan for Teams
                    let linesToScan = [];
                    if (entry._allMatchups && Array.isArray(entry._allMatchups) && entry._allMatchups.length > 0) {
                        linesToScan = entry._allMatchups;
                    } else if (entryField) {
                        linesToScan = entryField.split('\n');
                    } else if (entrySport) {
                        linesToScan = [entrySport];
                    }

                    linesToScan.forEach(line => {
                        if (typeof line !== 'string') return;
                        
                        // Regex for "Team A vs Team B"
                        const m = line.match(/^(.*?)\s+vs\.?\s+(.*?)(?:\s*[@\(]|$)/i);
                        if (m) {
                            const tA = m[1].trim();
                            const tB = m[2].trim();

                            if (league.teams.includes(tA) && league.teams.includes(tB)) {
                                if (!gamesFound[headerLabel]) gamesFound[headerLabel] = [];
                                
                                const exists = gamesFound[headerLabel].some(g =>
                                     (g.teamA === tA && g.teamB === tB) ||
                                     (g.teamA === tB && g.teamB === tA)
                                );
                                
                                if (!exists) {
                                    gamesFound[headerLabel].push({ teamA: tA, teamB: tB });
                                }
                            }
                        }
                    });
                });
            }

            const groupNames = Object.keys(gamesFound).sort((a,b) =>
                 a.localeCompare(b, undefined, {numeric: true})
            );

            if (groupNames.length === 0) {
                // ★ XSS PREVENTION: Use textContent
                const noMatchMsg = document.createElement('p');
                noMatchMsg.className = 'muted';
                noMatchMsg.style.cssText = 'text-align:center; padding:10px;';
                noMatchMsg.textContent = `No games found for "${league.name}" in today's schedule. Make sure the schedule has been generated with this league's teams.`;
                target.appendChild(noMatchMsg);
                return;
            }

            groupNames.forEach(label => {
                const header = document.createElement('div');
                header.className = 'group-header';
                header.style.cssText = 'font-weight:600; margin-top:12px; margin-bottom:6px; color:#374151;';
                header.textContent = label;
                target.appendChild(header);
                gamesFound[label].forEach(m => {
                    addMatchRow(target, m.teamA, m.teamB, '', '', saveButton, label);
                });
            });

            if (saveButton) saveButton.style.display = 'block';
        } catch (e) {
            console.error("[SPECIALTY_LEAGUES] Error importing games from schedule:", e);
            target.innerHTML = '<p class="muted" style="text-align:center; padding:10px;">Error importing schedule. Please try again.</p>';
        }
    }

    // =============================================================
    // SAVE GAME RESULTS
    // =============================================================
    function saveGameResults(league, selectValue, matchContainer) {
        try {
            const rows = matchContainer.querySelectorAll('.match-row');
            const matches = [];
            
            rows.forEach(row => {
                const teamA = row.dataset.teamA;
                const teamB = row.dataset.teamB;
                const timeLabel = row.dataset.timeLabel || '';
                const scoreAInput = row.querySelector('.score-a');
                const scoreBInput = row.querySelector('.score-b');
                
                const scoreA = scoreAInput ? parseInt(scoreAInput.value, 10) || 0 : 0;
                const scoreB = scoreBInput ? parseInt(scoreBInput.value, 10) || 0 : 0;
                
                let winner = null;
                if (scoreA > scoreB) winner = teamA;
                else if (scoreB > scoreA) winner = teamB;
                else if (scoreA === scoreB && scoreA > 0) winner = 'tie';
                
                matches.push({ teamA, teamB, scoreA, scoreB, winner, timeLabel });
            });

            if (selectValue === 'new') {
                // Create new game entry
                const currentDate = window.currentScheduleDate || new Date().toISOString().split('T')[0];
                const gameNum = (league.games || []).length + 1;
                
                league.games = league.games || [];
                league.games.push({
                    name: `Game ${gameNum}`,
                    date: currentDate,
                    matches
                });
            } else {
                // Update existing game
                const idx = parseInt(selectValue, 10);
                if (league.games && league.games[idx]) {
                    league.games[idx].matches = matches;
                }
            }

            recalcStandings(league);
            saveData();
            renderDetailPane();
        } catch (e) {
            console.error("[SPECIALTY_LEAGUES] Error saving game results:", e);
            alert('Error saving results. Please try again.');
        }
    }

    // =============================================================
    // RECALC STANDINGS
    // =============================================================
    function recalcStandings(league) {
        if (!league || !league.teams) return;
        
        try {
            // Reset all standings
            league.teams.forEach(t => {
                league.standings[t] = { w: 0, l: 0, t: 0 };
            });

            (league.games || []).forEach(g => {
                (g.matches || []).forEach(m => {
                    if (m.winner === 'tie') {
                        if (league.standings[m.teamA]) league.standings[m.teamA].t++;
                        if (league.standings[m.teamB]) league.standings[m.teamB].t++;
                    } else if (m.winner) {
                        if (league.standings[m.winner]) league.standings[m.winner].w++;
                        const loser = m.winner === m.teamA ? m.teamB : m.teamA;
                        if (league.standings[loser]) league.standings[loser].l++;
                    }
                });
            });
        } catch (e) {
            console.error("[SPECIALTY_LEAGUES] Error recalculating standings:", e);
        }
    }

    // =============================================================
    // ★ CLEANUP / DESTROY FUNCTION
    // =============================================================
    function cleanup() {
        cleanupEventListeners();
        cleanupTabListeners();
        _isInitialized = false;
        _saveInProgress = false;
        activeLeagueId = null;
        listEl = null;
        detailPaneEl = null;
        addInput = null;
        console.log("[SPECIALTY_LEAGUES] Cleanup complete");
    }

    // =============================================================
    // ★ v2.1: DIAGNOSTICS FUNCTION (matches other modules pattern)
    // =============================================================
    function diagnoseSpecialtyLeagues() {
        console.log('\n' + '═'.repeat(60));
        console.log('🔍 SPECIALTY LEAGUES DIAGNOSTICS');
        console.log('═'.repeat(60));
        
        const settings = window.loadGlobalSettings?.() || {};
        const storedLeagues = settings.specialtyLeagues || {};
        
        console.log('\n📊 STORAGE STATE:');
        console.log('  Total leagues stored:', Object.keys(storedLeagues).length);
        console.log('  In-memory leagues:', Object.keys(specialtyLeagues).length);
        console.log('  Data match:', JSON.stringify(storedLeagues) === JSON.stringify(specialtyLeagues) ? '✅' : '❌');
        
        console.log('\n📋 LEAGUES DETAIL:');
        Object.entries(specialtyLeagues).forEach(([id, league]) => {
            console.log(`  [${id}] "${league.name}":`);
            console.log(`    - Enabled: ${league.enabled}`);
            console.log(`    - Divisions: ${(league.divisions || []).join(', ') || 'none'}`);
            console.log(`    - Sport: ${league.sport || 'none'}`);
            console.log(`    - Fields: ${(league.fields || []).join(', ') || 'none'}`);
            console.log(`    - Teams: ${(league.teams || []).length}`);
            console.log(`    - Games recorded: ${(league.games || []).length}`);
        });
        
        console.log('\n🔗 INTEGRATION CHECK:');
        console.log('  loadGlobalSettings:', typeof window.loadGlobalSettings === 'function' ? '✅' : '❌');
        console.log('  saveGlobalSettings:', typeof window.saveGlobalSettings === 'function' ? '✅' : '❌');
        console.log('  AccessControl:', typeof window.AccessControl?.checkSetupAccess === 'function' ? '✅' : '❌');
        console.log('  loadCurrentDailyData:', typeof window.loadCurrentDailyData === 'function' ? '✅' : '❌');
        
        console.log('\n📡 SYNC STATE:');
        console.log('  _isInitialized:', _isInitialized);
        console.log('  _saveInProgress:', _saveInProgress);
        console.log('  _lastSaveTime:', _lastSaveTime ? new Date(_lastSaveTime).toISOString() : 'never');
        console.log('  activeEventListeners:', activeEventListeners.length);
        
        console.log('\n' + '═'.repeat(60));
        
        return {
            leagueCount: Object.keys(specialtyLeagues).length,
            isInitialized: _isInitialized,
            saveInProgress: _saveInProgress
        };
    }

    // =============================================================
    // EXPORTS
    // =============================================================
    window.initSpecialtyLeagues = window.initSpecialtyLeagues;
    window.specialtyLeagues = specialtyLeagues;
    
    // ★ Export helper functions for external use
    window.refreshSpecialtyLeagues = refreshFromStorage;
    window.cleanupSpecialtyLeagues = cleanup;
    
    // ★ Export getter that always returns current state
    window.getSpecialtyLeagues = function() {
        return specialtyLeagues;
    };

    // ★ v2.1: Export diagnostics
    window.diagnoseSpecialtyLeagues = diagnoseSpecialtyLeagues;

    console.log("[SPECIALTY_LEAGUES] Module v2.1 loaded");

})();
