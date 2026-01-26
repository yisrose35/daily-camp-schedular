// =================================================================
// leagues.js — PRODUCTION-READY v2.0
// =================================================================
// v2.0 PRODUCTION FIXES:
// - ★ CLOUD SYNC: Proper cloud sync via saveGlobalSettings
// - ★ TAB REFRESH: Refreshes data when tab becomes visible
// - ★ MEMORY LEAK FIX: Proper cleanup of all event listeners
// - ★ DATA VALIDATION: Validates structure on load
// - ★ TYPE CONSISTENCY: Ensures proper number/string handling
// - ★ NULL SAFETY: Added checks for DOM elements and parameters
// - ★ ORPHAN CLEANUP: Validates divisions on load
// - ★ ERROR HANDLING: Added try/catch around risky operations
// - ★ XSS PREVENTION: Added escapeHtml for user content
// - ★ RBAC: Added permission checks for add/delete operations
// =================================================================
(function () {
    'use strict';
    console.log("🏆 leagues.js v2.0 loading...");

    // =========================================================================
    // GLOBAL LEAGUE STORAGE
    // =========================================================================
    // GCM FIX: Use const so the reference never changes
    const leaguesByName = {};

    // Bind to window immediately
    window.leaguesByName = leaguesByName;
    window.masterLeagues = leaguesByName;
    let leagueRoundState = {};
    window.leagueRoundState = leagueRoundState;

    // =========================================================================
    // UI STATE
    // =========================================================================
    let selectedLeagueName = null;
    let listEl = null;
    let detailPaneEl = null;
    let _isInitialized = false;
    let _refreshTimeout = null;

    // ★ FIX: Track active event listeners for cleanup (with target info)
    let activeEventListeners = [];

    // ★ FIX: Track cloud sync callback for cleanup
    let _cloudSyncCallback = null;

    // ★ FIX: Tab visibility handlers
    let _visibilityHandler = null;
    let _focusHandler = null;
    let _beforeUnloadHandler = null;

    // =========================================================================
    // ★ CLEANUP HELPERS
    // =========================================================================
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

    // =========================================================================
    // ★ TAB VISIBILITY HANDLERS - Refresh data when tab becomes visible
    // =========================================================================
    function setupTabListeners() {
        // Cleanup existing listeners first
        cleanupTabListeners();

        // Visibility change handler
        _visibilityHandler = () => {
            if (document.visibilityState === 'visible' && _isInitialized) {
                // Debounce refresh
                if (_refreshTimeout) {
                    clearTimeout(_refreshTimeout);
                }
                _refreshTimeout = setTimeout(() => {
                    console.log("[LEAGUES] Tab visible - refreshing data...");
                    refreshFromStorage();
                }, 300);
            }
        };
        document.addEventListener('visibilitychange', _visibilityHandler);
        activeEventListeners.push({ type: 'visibilitychange', handler: _visibilityHandler, target: document });

        // Focus handler
        _focusHandler = () => {
            if (_isInitialized) {
                if (_refreshTimeout) {
                    clearTimeout(_refreshTimeout);
                }
                _refreshTimeout = setTimeout(() => {
                    console.log("[LEAGUES] Window focused - refreshing data...");
                    refreshFromStorage();
                }, 300);
            }
        };
        window.addEventListener('focus', _focusHandler);
        activeEventListeners.push({ type: 'focus', handler: _focusHandler, target: window });
    }

    // =========================================================================
    // ★ CLOUD SYNC LISTENER - React to remote changes
    // =========================================================================
    function setupCloudSyncListener() {
        // Cleanup existing
        if (_cloudSyncCallback && window.SupabaseSync?.removeStatusCallback) {
            window.SupabaseSync.removeStatusCallback(_cloudSyncCallback);
        }

        // Listen for cloud sync events (if the sync system provides callbacks)
        if (window.SupabaseSync?.onStatusChange) {
            _cloudSyncCallback = (status) => {
                if (status === 'idle' && _isInitialized) {
                    // After sync completes, refresh our data
                    console.log("[LEAGUES] Cloud sync complete - refreshing...");
                    refreshFromStorage();
                }
            };
            window.SupabaseSync.onStatusChange(_cloudSyncCallback);
        }

        // Also listen for custom campistry events (dispatched by integration_hooks)
        const handleRemoteChange = (event) => {
            if (_isInitialized && (event.detail?.key === 'leaguesByName' || event.detail?.key === 'leagueRoundState')) {
                console.log("[LEAGUES] Remote change detected for:", event.detail?.key);
                refreshFromStorage();
            }
        };
        window.addEventListener('campistry-remote-change', handleRemoteChange);
        activeEventListeners.push({ type: 'campistry-remote-change', handler: handleRemoteChange, target: window });
    }

    // =========================================================================
    // ★ BEFOREUNLOAD HANDLER - Ensure sync on page exit
    // =========================================================================
    function setupBeforeUnloadHandler() {
        // Cleanup existing
        if (_beforeUnloadHandler) {
            window.removeEventListener('beforeunload', _beforeUnloadHandler);
        }

        _beforeUnloadHandler = () => {
            // Force immediate sync on page exit
            window.forceSyncToCloud?.();
        };

        window.addEventListener('beforeunload', _beforeUnloadHandler);
        activeEventListeners.push({ type: 'beforeunload', handler: _beforeUnloadHandler, target: window });
    }

    // =========================================================================
    // ★ HELPER FUNCTIONS
    // =========================================================================
    
    /**
     * Escape HTML to prevent XSS attacks
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
            const divisions = settings.divisions || {};
            return new Set(Object.keys(divisions));
        } catch (e) {
            return null;
        }
    }

    // =========================================================================
    // ★ DATA VALIDATION - Ensure league structure is valid
    // =========================================================================
    function validateLeague(league, leagueName) {
        if (!league || typeof league !== 'object') {
            return {
                name: leagueName,
                teams: [],
                sports: [],
                divisions: [],
                standings: {},
                games: [],
                enabled: true,
                schedulingPriority: 'sport_variety'
            };
        }

        // Get valid divisions for orphan detection
        const validDivisions = getValidDivisionNames();

        // Ensure all required properties exist with correct types
        const validated = {
            name: league.name || leagueName,
            teams: Array.isArray(league.teams) ? league.teams.filter(t => typeof t === 'string') : [],
            sports: Array.isArray(league.sports) ? league.sports.filter(s => typeof s === 'string') : [],
            divisions: Array.isArray(league.divisions) ? league.divisions.filter(d => typeof d === 'string') : [],
            standings: (league.standings && typeof league.standings === 'object') ? league.standings : {},
            games: Array.isArray(league.games) ? league.games : [],
            enabled: league.enabled !== false,
            schedulingPriority: ['sport_variety', 'matchup_variety'].includes(league.schedulingPriority) 
                ? league.schedulingPriority 
                : 'sport_variety'
        };

        // ★ ORPHAN CLEANUP: Remove references to deleted divisions
        if (validDivisions && validDivisions.size > 0) {
            const originalLength = validated.divisions.length;
            validated.divisions = validated.divisions.filter(d => validDivisions.has(d));
            if (validated.divisions.length < originalLength) {
                console.log(`[LEAGUES] Removed ${originalLength - validated.divisions.length} stale division(s) from "${leagueName}"`);
            }
        }

        // Ensure all teams have standings entries
        validated.teams.forEach(team => {
            if (!validated.standings[team] || typeof validated.standings[team] !== 'object') {
                validated.standings[team] = { w: 0, l: 0, t: 0 };
            } else {
                // Ensure w, l, t are numbers
                validated.standings[team] = {
                    w: parseInt(validated.standings[team].w, 10) || 0,
                    l: parseInt(validated.standings[team].l, 10) || 0,
                    t: parseInt(validated.standings[team].t, 10) || 0
                };
            }
        });

        // Clean up standings for teams that no longer exist
        Object.keys(validated.standings).forEach(team => {
            if (!validated.teams.includes(team)) {
                delete validated.standings[team];
            }
        });

        return validated;
    }

    // =========================================================================
    // LOAD + SAVE - ★ CLOUD SYNC AWARE
    // =========================================================================
    function loadRoundState() {
        try {
            const global = window.loadGlobalSettings?.() || {};
            leagueRoundState = global.leagueRoundState || {};
            window.leagueRoundState = leagueRoundState;
        } catch (e) {
            console.error("[LEAGUES] Failed to load league round state:", e);
            leagueRoundState = {};
            window.leagueRoundState = leagueRoundState;
        }
    }

    function saveLeaguesData() {
        // ✅ RBAC Check for modifications
        if (window.AccessControl?.canEditSetup && !window.AccessControl.canEditSetup()) {
            console.warn('[LEAGUES] Save blocked - insufficient permissions');
            return;
        }

        try {
            // ★ Save via saveGlobalSettings (handles batching + cloud sync)
            window.saveGlobalSettings?.('leaguesByName', leaguesByName);
            
            // Note: forceSyncToCloud is already batched by integration_hooks,
            // so we don't need to call it on every save
            console.log("[LEAGUES] Data saved to cloud");
        } catch (e) {
            console.error("[LEAGUES] Save failed:", e);
        }
    }

    function loadLeaguesData() {
        try {
            const global = window.loadGlobalSettings?.() || {};
            const loadedData = global.leaguesByName || {};

            // GCM FIX: Don't replace the object. Clear and refill it.
            // 1. Remove old keys
            Object.keys(leaguesByName).forEach(k => delete leaguesByName[k]);

            // 2. Add new keys with validation
            Object.keys(loadedData).forEach(leagueName => {
                leaguesByName[leagueName] = validateLeague(loadedData[leagueName], leagueName);
            });

            console.log("[LEAGUES] Data loaded:", {
                leagues: Object.keys(leaguesByName).length
            });
        } catch (e) {
            console.error("[LEAGUES] Load failed:", e);
        }
    }

    /**
     * Refresh data from storage (call when tab becomes visible or after cloud sync)
     */
    function refreshFromStorage() {
        // ★ FIX: Store previous state for proper comparison
        const previousDataJson = JSON.stringify(leaguesByName);
        const previousSelected = selectedLeagueName;

        loadLeaguesData();
        loadRoundState();

        // If selected league no longer exists, clear selection
        if (selectedLeagueName && !leaguesByName[selectedLeagueName]) {
            selectedLeagueName = null;
        }

        // ★ FIX: Compare actual content, not just counts
        const newDataJson = JSON.stringify(leaguesByName);
        const dataChanged = previousDataJson !== newDataJson ||
            previousSelected !== selectedLeagueName;

        if (dataChanged && _isInitialized) {
            console.log("[LEAGUES] Data changed - re-rendering UI");
            if (listEl) renderMasterList();
            if (detailPaneEl) renderDetailPane();
        } else {
            console.log("[LEAGUES] Data unchanged - skipping re-render");
        }
    }

    // =========================================================================
    // INLINE EDIT HELPER
    // =========================================================================
    function makeEditable(el, saveCallback) {
        if (!el) return;

        el.ondblclick = function (e) {
            e.stopPropagation();
            const oldText = el.textContent;
            const input = document.createElement('input');
            input.type = 'text';
            input.value = oldText;
            Object.assign(input.style, {
                fontSize: 'inherit',
                fontWeight: 'inherit',
                width: '100%',
                boxSizing: 'border-box',
                border: '1px solid #10B981',
                borderRadius: '4px',
                padding: '2px 6px',
                outline: 'none'
            });
            el.replaceWith(input);
            input.focus();
            input.select();

            const finish = function () {
                const newVal = input.value.trim();
                if (newVal && newVal !== oldText) {
                    saveCallback(newVal);
                } else {
                    el.textContent = oldText;
                    if (input.parentNode) input.replaceWith(el);
                }
            };

            input.onblur = finish;
            input.onkeyup = function (ev) {
                if (ev.key === 'Enter') finish();
                if (ev.key === 'Escape') {
                    el.textContent = oldText;
                    input.replaceWith(el);
                }
            };
        };
    }

    // =========================================================================
    // TIME HELPERS
    // =========================================================================
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
        if (Number.isNaN(hh) || Number.isNaN(mm) || mm < 0 || mm > 59) return null;
        if (mer) {
            if (hh === 12) hh = (mer === "am") ? 0 : 12;
            else if (mer === "pm") hh += 12;
        }
        return hh * 60 + mm;
    }

    function minutesToTimeStr(m) {
        if (m == null || isNaN(m)) return "";
        let hh = Math.floor(m / 60) % 24;
        const mm = m % 60;
        const mer = hh >= 12 ? "pm" : "am";
        if (hh === 0) hh = 12;
        else if (hh > 12) hh -= 12;
        return hh + ":" + String(mm).padStart(2, '0') + mer;
    }

    // =========================================================================
    // INIT - ★ WITH CLOUD SUBSCRIPTION AND TAB VISIBILITY HANDLING
    // =========================================================================
    window.initLeagues = function () {
        const container = document.getElementById('leagues');
        if (!container) return;

        // ★ FIX: Cleanup any previous state when re-initializing
        cleanupEventListeners();
        cleanupTabListeners();

        loadLeaguesData();
        loadRoundState();

        container.innerHTML = '';

        // ★ Setup tab visibility listener to refresh data when tab becomes active
        setupTabListeners();

        // ★ Setup cloud sync listener (if available)
        setupCloudSyncListener();

        // ★ Setup beforeunload handler
        setupBeforeUnloadHandler();

        // STYLES
        const style = document.createElement('style');
        style.innerHTML = `
            /* Master List */
            .master-list { border: 1px solid #E5E7EB; border-radius: 12px; background: #fff; overflow: hidden; }
            .list-item { padding: 12px 14px; border-bottom: 1px solid #F3F4F6; cursor: pointer; display: flex; justify-content: space-between; align-items: center; transition: background 0.15s; }
            .list-item:last-child { border-bottom: none; }
            .list-item:hover { background: #F9FAFB; }
            .list-item.selected { background: #F0FDF4; border-left: 3px solid #10B981; }
            .list-item-name { font-weight: 500; color: #1F2937; font-size: 0.9rem; }

            /* Toggle Switch */
            .switch { position: relative; display: inline-block; width: 36px; height: 20px; flex-shrink: 0; }
            .switch input { opacity: 0; width: 0; height: 0; }
            .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #ccc; transition: .3s; border-radius: 20px; }
            .slider:before { position: absolute; content: ""; height: 14px; width: 14px; left: 3px; bottom: 3px; background-color: white; transition: .3s; border-radius: 50%; }
            input:checked + .slider { background-color: #10B981; }
            input:checked + .slider:before { transform: translateX(16px); }

            /* League Section Cards */
            .league-section-card { border: 1px solid #E5E7EB; border-radius: 12px; padding: 14px 16px; margin-bottom: 12px; background: #fff; }
            .league-section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
            .league-section-title { font-weight: 600; color: #111827; font-size: 0.9rem; }

            /* Chips */
            .chips { display: flex; flex-wrap: wrap; gap: 8px; }
            .chip { padding: 6px 12px; border-radius: 999px; font-size: 0.8rem; cursor: pointer; border: 1px solid #D1D5DB; background: #F9FAFB; color: #374151; transition: all 0.15s; }
            .chip:hover { background: #F3F4F6; }
            .chip.active { background: #10B981; color: #fff; border-color: #10B981; }

            /* Priority Toggle */
            .priority-toggle { display: flex; gap: 10px; }
            .priority-toggle-btn { flex: 1; padding: 12px; border: 2px solid #E5E7EB; border-radius: 12px; background: #fff; cursor: pointer; text-align: center; transition: all 0.2s; }
            .priority-toggle-btn:hover { border-color: #00C896; }
            .priority-toggle-btn.active { border-color: #00C896; background: linear-gradient(135deg, #00C896 0%, #00B386 100%); color: #fff; }

            /* Muted text */
            .muted { color: #9CA3AF; font-style: italic; }
        `;
        container.appendChild(style);

        // LAYOUT
        const contentWrapper = document.createElement('div');
        contentWrapper.innerHTML = `
            <div style="display:flex; gap:24px;">
              <section style="flex: 0 0 260px;">
                <h3 style="margin:0 0 12px 0; font-size:1rem;">Leagues</h3>
                <div style="margin-bottom:12px; display:flex; gap:8px;">
                  <input id="league-add-input" placeholder="League name..." style="flex:1; padding:8px 12px; border:1px solid #D1D5DB; border-radius:8px; font-size:0.9rem;" />
                  <button id="league-add-btn" style="padding:8px 14px; background:#10B981; color:#fff; border:none; border-radius:8px; cursor:pointer; font-weight:500;">+ Add</button>
                </div>
                <div id="leagues-master-list" class="master-list"></div>
              </section>
              <section style="flex:1; min-width:0;">
                <div id="leagues-detail-pane" style="margin-top:8px;"></div>
              </section>
            </div>`;
        container.appendChild(contentWrapper);

        // ★ FIX: Null check all DOM elements
        listEl = document.getElementById('leagues-master-list');
        detailPaneEl = document.getElementById('leagues-detail-pane');
        const addInput = document.getElementById('league-add-input');
        const addBtn = document.getElementById('league-add-btn');

        const addLeague = function () {
            // ✅ RBAC Check
            if (window.AccessControl?.canEditSetup && !window.AccessControl.canEditSetup()) {
                window.AccessControl?.showPermissionDenied?.('add leagues');
                return;
            }

            const name = addInput?.value?.trim();
            if (!name) return;
            if (leaguesByName[name]) {
                alert('League "' + escapeHtml(name) + '" already exists.');
                return;
            }
            leaguesByName[name] = {
                name: name,
                teams: [],
                sports: [],
                divisions: [],
                standings: {},
                games: [],
                enabled: true,
                schedulingPriority: 'sport_variety'
            };
            saveLeaguesData();
            if (addInput) addInput.value = '';
            selectedLeagueName = name;
            renderMasterList();
            renderDetailPane();
        };

        if (addBtn) {
            addBtn.onclick = addLeague;
        }
        if (addInput) {
            addInput.onkeyup = function (e) { if (e.key === 'Enter') addLeague(); };
        }

        _isInitialized = true;

        renderMasterList();
        if (selectedLeagueName && leaguesByName[selectedLeagueName]) {
            renderDetailPane();
        }

        console.log("[LEAGUES] Initialized:", {
            leagues: Object.keys(leaguesByName).length
        });
    };

    // =========================================================================
    // MASTER LIST RENDER
    // =========================================================================
    function renderMasterList() {
        if (!listEl) return;

        listEl.innerHTML = '';
        const keys = Object.keys(leaguesByName).sort();
        if (keys.length === 0) {
            listEl.innerHTML = '<p class="muted">No leagues yet.</p>';
            return;
        }
        keys.forEach(function (name) {
            const item = leaguesByName[name];
            const el = document.createElement('div');
            el.className = 'list-item';
            if (name === selectedLeagueName) el.classList.add('selected');
            el.onclick = function () {
                selectedLeagueName = name;
                renderMasterList();
                renderDetailPane();
            };
            // ★ FIX: Use escapeHtml for user content
            el.innerHTML = '<span class="list-item-name">' + escapeHtml(name) + '</span>';

            const tog = document.createElement('label');
            tog.className = 'switch';
            tog.onclick = function (e) { e.stopPropagation(); };

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = item.enabled;
            cb.onchange = function () {
                item.enabled = cb.checked;
                saveLeaguesData();
            };

            const slider = document.createElement('span');
            slider.className = 'slider';
            tog.append(cb, slider);
            el.appendChild(tog);
            listEl.appendChild(el);
        });
    }

    // =========================================================================
    // DETAIL PANE
    // =========================================================================
    function renderDetailPane() {
        if (!detailPaneEl) return;

        if (!selectedLeagueName || !leaguesByName[selectedLeagueName]) {
            detailPaneEl.innerHTML = '<p class="muted">Select a league.</p>';
            return;
        }
        const league = leaguesByName[selectedLeagueName];
        detailPaneEl.innerHTML = '';

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
        title.textContent = selectedLeagueName;
        title.title = "Double-click to rename";

        makeEditable(title, function (newName) {
            if (newName && !leaguesByName[newName]) {
                // ★ FIX: Update league.name property as well
                league.name = newName;
                leaguesByName[newName] = league;
                delete leaguesByName[selectedLeagueName];
                selectedLeagueName = newName;
                saveLeaguesData();
                renderMasterList();
                renderDetailPane();
            } else if (leaguesByName[newName]) {
                alert('League "' + escapeHtml(newName) + '" already exists.');
            }
        });

        const btnGroup = document.createElement('div');
        btnGroup.style.display = 'flex';
        btnGroup.style.gap = '8px';

        // NEUTRAL BUTTON
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

        // DELETE BUTTON
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
        delBtn.onmouseenter = function () { delBtn.style.background = '#FEE2E2'; };
        delBtn.onmouseleave = function () { delBtn.style.background = '#FFFFFF'; };
        delBtn.onclick = function () {
            // ✅ RBAC Check
            if (window.AccessControl?.canEraseData && !window.AccessControl.canEraseData()) {
                window.AccessControl?.showPermissionDenied?.('delete leagues');
                return;
            }

            if (confirm("Delete league \"" + escapeHtml(selectedLeagueName) + "\"?")) {
                delete leaguesByName[selectedLeagueName];
                selectedLeagueName = null;
                saveLeaguesData();
                renderMasterList();
                detailPaneEl.innerHTML = '<p class="muted">Select a league.</p>';
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

        editConfigBtn.onclick = function () {
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

        // --- MAIN CONTENT (Standings/Results) ---
        const mainContent = document.createElement('div');
        renderGameResultsUI(league, mainContent);
        detailPaneEl.appendChild(mainContent);
    }

    // =========================================================================
    // CONFIG SECTIONS (Cards)
    // =========================================================================
    function renderConfigSections(league, container) {
        if (!container) return;

        container.innerHTML = '';

        // CARD 0: SCHEDULING PRIORITY
        const priorityCard = document.createElement('div');
        priorityCard.className = 'league-section-card';
        priorityCard.innerHTML =
            '<div class="league-section-header">' +
            '<span class="league-section-title">Scheduling Priority</span>' +
            '<span>How to schedule games</span>' +
            '</div>';

        const priorityDesc = document.createElement('p');
        priorityDesc.style.fontSize = '0.8rem';
        priorityDesc.style.color = '#6B7280';
        priorityDesc.style.margin = '0 0 10px 0';
        priorityDesc.textContent = 'Choose what the scheduler prioritizes when assigning games:';
        priorityCard.appendChild(priorityDesc);

        const priorityToggle = document.createElement('div');
        priorityToggle.className = 'priority-toggle';

        const sportBtn = document.createElement('button');
        sportBtn.className = 'priority-toggle-btn' + (league.schedulingPriority === 'sport_variety' ? ' active' : '');
        sportBtn.innerHTML = '<strong>Sport Variety</strong><br><span style="font-size:0.7rem; opacity:0.85;">Play all sports before repeating</span>';
        sportBtn.onclick = function () {
            league.schedulingPriority = 'sport_variety';
            saveLeaguesData();
            renderConfigSections(league, container);
        };

        const matchupBtn = document.createElement('button');
        matchupBtn.className = 'priority-toggle-btn' + (league.schedulingPriority === 'matchup_variety' ? ' active' : '');
        matchupBtn.innerHTML = '<strong>Matchup Variety</strong><br><span style="font-size:0.7rem; opacity:0.85;">Play all teams before repeating</span>';
        matchupBtn.onclick = function () {
            league.schedulingPriority = 'matchup_variety';
            saveLeaguesData();
            renderConfigSections(league, container);
        };

        priorityToggle.append(sportBtn, matchupBtn);
        priorityCard.appendChild(priorityToggle);

        const priorityNote = document.createElement('p');
        priorityNote.style.fontSize = '0.75rem';
        priorityNote.style.color = '#9CA3AF';
        priorityNote.style.margin = '8px 0 0 0';
        priorityNote.style.fontStyle = 'italic';
        if (league.schedulingPriority === 'sport_variety') {
            priorityNote.textContent = 'Teams will rotate through all available sports. Team matchups may repeat if needed to ensure sport variety.';
        } else {
            priorityNote.textContent = 'Teams will play all opponents before rematches. Sports may repeat if needed to ensure matchup variety.';
        }
        priorityCard.appendChild(priorityNote);

        container.appendChild(priorityCard);

        // CARD 1: DIVISIONS
        const divCard = document.createElement('div');
        divCard.className = 'league-section-card';
        divCard.innerHTML =
            '<div class="league-section-header">' +
            '<span class="league-section-title">Divisions</span>' +
            '<span>Who plays?</span>' +
            '</div>';

        const divChips = document.createElement('div');
        divChips.className = 'chips';
        (window.availableDivisions || []).forEach(function (divName) {
            const isActive = league.divisions.includes(divName);
            const chip = document.createElement('span');
            chip.className = 'chip' + (isActive ? ' active' : '');
            chip.textContent = divName; // Safe: textContent auto-escapes
            chip.onclick = function () {
                if (isActive) league.divisions = league.divisions.filter(d => d !== divName);
                else league.divisions.push(divName);
                saveLeaguesData();
                renderConfigSections(league, container);
            };
            divChips.appendChild(chip);
        });
        divCard.appendChild(divChips);
        container.appendChild(divCard);

        // CARD 2: SPORTS
        const sportCard = document.createElement('div');
        sportCard.className = 'league-section-card';
        sportCard.innerHTML =
            '<div class="league-section-header">' +
            '<span class="league-section-title">Sports</span>' +
            '<span>Activity Type</span>' +
            '</div>';

        const sportChips = document.createElement('div');
        sportChips.className = 'chips';
        (window.getAllGlobalSports?.() || []).forEach(function (act) {
            const isActive = league.sports.includes(act);
            const chip = document.createElement('span');
            chip.className = 'chip' + (isActive ? ' active' : '');
            chip.textContent = act; // Safe: textContent auto-escapes
            chip.onclick = function () {
                if (isActive) league.sports = league.sports.filter(s => s !== act);
                else league.sports.push(act);
                saveLeaguesData();
                renderConfigSections(league, container);
            };
            sportChips.appendChild(chip);
        });
        sportCard.appendChild(sportChips);
        container.appendChild(sportCard);

        // CARD 3: TEAMS
        const teamCard = document.createElement('div');
        teamCard.className = 'league-section-card';
        teamCard.innerHTML =
            '<div class="league-section-header">' +
            '<span class="league-section-title">Teams</span>' +
            '<span>Roster</span>' +
            '</div>';

        const teamList = document.createElement('div');
        teamList.className = 'chips';
        league.teams.forEach(function (team) {
            const chip = document.createElement('span');
            chip.className = 'chip active';
            // ★ FIX: Use DOM methods instead of innerHTML with user content
            const teamText = document.createTextNode(team + ' ');
            const removeSpan = document.createElement('span');
            removeSpan.style.opacity = '0.6';
            removeSpan.style.marginLeft = '4px';
            removeSpan.textContent = '×';
            chip.appendChild(teamText);
            chip.appendChild(removeSpan);
            chip.onclick = function () {
                league.teams = league.teams.filter(t => t !== team);
                delete league.standings[team];
                saveLeaguesData();
                renderConfigSections(league, container);
            };
            teamList.appendChild(chip);
        });
        teamCard.appendChild(teamList);

        const teamInput = document.createElement('input');
        teamInput.placeholder = 'Type team name & press Enter...';
        teamInput.style.marginTop = '10px';
        teamInput.style.width = '100%';
        teamInput.style.padding = '8px 12px';
        teamInput.style.border = '1px solid #D1D5DB';
        teamInput.style.borderRadius = '8px';
        teamInput.onkeyup = function (e) {
            if (e.key === 'Enter' && teamInput.value.trim()) {
                const t = teamInput.value.trim();
                if (!league.teams.includes(t)) {
                    league.teams.push(t);
                    league.standings[t] = { w: 0, l: 0, t: 0 };
                    saveLeaguesData();
                    renderConfigSections(league, container);
                    const newInput = container.querySelectorAll('input');
                    if (newInput.length) newInput[newInput.length - 1].focus();
                }
            }
        };
        teamCard.appendChild(teamInput);
        container.appendChild(teamCard);
    }

    // =========================================================================
    // GAME RESULTS VIEW
    // =========================================================================
    function renderGameResultsUI(league, container) {
        if (!container) return;

        container.innerHTML = '';

        const tabNav = document.createElement('div');
        tabNav.style.marginBottom = '15px';
        tabNav.style.display = 'flex';
        tabNav.style.gap = '8px';
        tabNav.innerHTML =
            '<button id="tab-standings" class="active">Current Standings</button>' +
            '<button id="tab-games">Game Results / History</button>';
        container.appendChild(tabNav);

        const standingsDiv = document.createElement('div');
        const gamesDiv = document.createElement('div');
        gamesDiv.style.display = 'none';
        container.appendChild(standingsDiv);
        container.appendChild(gamesDiv);

        const btnStd = tabNav.querySelector('#tab-standings');
        const btnGms = tabNav.querySelector('#tab-games');

        // ★ FIX: Null checks for tab buttons
        if (!btnStd || !btnGms) return;

        const setTab = function (activeBtn, inactiveBtn) {
            Object.assign(activeBtn.style, {
                background: '#00C896',
                color: 'white',
                borderColor: '#00C896',
                borderRadius: '999px',
                padding: '8px 16px',
                boxShadow: '0 3px 8px rgba(0, 200, 150, 0.35)'
            });
            Object.assign(inactiveBtn.style, {
                background: '#F3F4F6',
                color: '#111827',
                borderColor: '#D1D5DB',
                borderRadius: '999px',
                padding: '8px 16px',
                boxShadow: 'none'
            });
        };

        setTab(btnStd, btnGms);

        btnStd.onclick = function () {
            standingsDiv.style.display = 'block';
            gamesDiv.style.display = 'none';
            setTab(btnStd, btnGms);
            renderStandingsTable(league, standingsDiv);
        };

        btnGms.onclick = function () {
            standingsDiv.style.display = 'none';
            gamesDiv.style.display = 'block';
            setTab(btnGms, btnStd);
            renderGameEntryUI(league, gamesDiv);
        };

        renderStandingsTable(league, standingsDiv);
    }

    // =========================================================================
    // STANDINGS TABLE
    // =========================================================================
    function renderStandingsTable(league, container) {
        if (!container) return;

        container.innerHTML = '';
        if (!league.teams || league.teams.length === 0) {
            container.innerHTML = '<p class="muted" style="text-align:center; padding:20px;">No teams in this league.</p>';
            return;
        }

        recalcStandings(league);

        const sorted = league.teams.slice().sort(function (a, b) {
            const sA = league.standings[a] || { w: 0, l: 0, t: 0 };
            const sB = league.standings[b] || { w: 0, l: 0, t: 0 };
            if (sB.w !== sA.w) return sB.w - sA.w;
            if (sA.l !== sB.l) return sA.l - sB.l;
            return 0;
        });

        // ★ FIX: Build table using DOM methods to avoid XSS with team names
        const table = document.createElement('table');
        table.style.cssText = 'width:100%; border-collapse:collapse; background:#fff; border-radius:12px; overflow:hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.06);';

        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        headerRow.style.background = '#F9FAFB';
        
        const headers = ['#', 'Team', 'W', 'L', 'T'];
        const headerWidths = ['', '', '60px', '60px', '60px'];
        const headerAligns = ['left', 'left', 'center', 'center', 'center'];
        
        headers.forEach((text, i) => {
            const th = document.createElement('th');
            th.style.cssText = `padding:12px ${i === 0 || i === 1 ? '16px' : '12px'}; text-align:${headerAligns[i]}; font-weight:600; color:#6B7280; font-size:0.8rem;`;
            if (headerWidths[i]) th.style.width = headerWidths[i];
            th.textContent = text;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        sorted.forEach(function (team, idx) {
            const stats = league.standings[team] || { w: 0, l: 0, t: 0 };
            const borderBottom = idx < sorted.length - 1 ? '1px solid #F3F4F6' : 'none';

            const row = document.createElement('tr');

            // Rank
            const rankCell = document.createElement('td');
            rankCell.style.cssText = `padding:12px 16px; border-bottom:${borderBottom}; font-weight:600; color:#111827;`;
            rankCell.textContent = (idx + 1) + getPlaceSuffix(idx + 1);
            row.appendChild(rankCell);

            // Team name (safe: textContent)
            const teamCell = document.createElement('td');
            teamCell.style.cssText = `padding:12px 16px; border-bottom:${borderBottom}; font-weight:500;`;
            teamCell.textContent = team;
            row.appendChild(teamCell);

            // Wins
            const winsCell = document.createElement('td');
            winsCell.style.cssText = `padding:12px; border-bottom:${borderBottom}; text-align:center; color:#059669; font-weight:600;`;
            winsCell.textContent = stats.w;
            row.appendChild(winsCell);

            // Losses
            const lossCell = document.createElement('td');
            lossCell.style.cssText = `padding:12px; border-bottom:${borderBottom}; text-align:center; color:#DC2626;`;
            lossCell.textContent = stats.l;
            row.appendChild(lossCell);

            // Ties
            const tieCell = document.createElement('td');
            tieCell.style.cssText = `padding:12px; border-bottom:${borderBottom}; text-align:center; color:#6B7280;`;
            tieCell.textContent = stats.t;
            row.appendChild(tieCell);

            tbody.appendChild(row);
        });
        table.appendChild(tbody);
        container.appendChild(table);
    }

    // =========================================================================
    // GAME ENTRY + IMPORT
    // =========================================================================
    function renderGameEntryUI(league, container) {
        if (!container) return;

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
        select.style.padding = "8px";
        select.style.border = "1px solid #D1D5DB";
        select.style.borderRadius = "8px";
        
        // ★ FIX: Build options using DOM to avoid XSS
        const defaultOpt = document.createElement('option');
        defaultOpt.value = 'new';
        defaultOpt.textContent = '-- Enter New Game --';
        select.appendChild(defaultOpt);
        
        (league.games || []).forEach(function (g, i) {
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = 'Game ' + (i + 1) + ' (' + (g.date || 'no date') + ')';
            select.appendChild(opt);
        });
        controls.appendChild(select);

        const importBtn = document.createElement('button');
        importBtn.textContent = 'Import from Schedule';
        importBtn.style.cssText = 'padding:8px 12px; border-radius:8px; background:#3B82F6; color:white; border:none; cursor:pointer;';
        importBtn.onclick = function () {
            importGamesFromSchedule(league);
        };
        controls.appendChild(importBtn);

        container.appendChild(controls);

        const formArea = document.createElement('div');
        container.appendChild(formArea);

        renderGameForm(league, formArea, select.value === 'new' ? null : parseInt(select.value, 10));

        select.onchange = function () {
            renderGameForm(league, formArea, select.value === 'new' ? null : parseInt(select.value, 10));
        };
    }

    function renderGameForm(league, container, gameIdx) {
        if (!container) return;

        container.innerHTML = '';
        const game = gameIdx != null ? league.games[gameIdx] : { date: '', matches: [] };

        // Date input
        const dateRow = document.createElement('div');
        dateRow.style.marginBottom = '12px';
        const dateLabel = document.createElement('label');
        dateLabel.style.cssText = 'font-weight:500; display:block; margin-bottom:4px;';
        dateLabel.textContent = 'Date:';
        dateRow.appendChild(dateLabel);
        
        const dateInput = document.createElement('input');
        dateInput.type = 'date';
        dateInput.value = game.date || '';
        dateInput.style.cssText = 'padding:8px; border:1px solid #D1D5DB; border-radius:8px; width:100%;';
        dateRow.appendChild(dateInput);
        container.appendChild(dateRow);

        // Matches section
        const matchesLabel = document.createElement('label');
        matchesLabel.textContent = 'Matches:';
        matchesLabel.style.cssText = 'font-weight:500; display:block; margin-bottom:8px; margin-top:16px;';
        container.appendChild(matchesLabel);

        // Only show "no matches" message if this is a new game with no matches
        if (gameIdx == null && (!game.matches || game.matches.length === 0)) {
            const noMatchesMsg = document.createElement('p');
            noMatchesMsg.className = 'muted';
            noMatchesMsg.style.cssText = 'text-align:center; padding:12px; background:#F9FAFB; border-radius:8px; margin-bottom:12px;';
            noMatchesMsg.textContent = 'Click "+ Add Match" to add matchups, or use "Import from Schedule" to pull today\'s games.';
            container.appendChild(noMatchesMsg);
        }

        const matchesDiv = document.createElement('div');
        matchesDiv.id = 'matches-container';
        container.appendChild(matchesDiv);

        function renderMatches() {
            matchesDiv.innerHTML = '';
            
            // Only render rows for matches that have teams assigned
            (game.matches || []).forEach(function (m, i) {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex; gap:8px; margin-bottom:10px; align-items:center; padding:10px 12px; background:#FFFFFF; border:1px solid #E5E7EB; border-radius:10px;';

                // Team A selector
                const teamASelect = document.createElement('select');
                teamASelect.style.cssText = 'flex:1; padding:8px; border:1px solid #D1D5DB; border-radius:6px;';
                const teamADefault = document.createElement('option');
                teamADefault.value = '';
                teamADefault.textContent = '-- Select Team --';
                teamASelect.appendChild(teamADefault);
                league.teams.forEach(function (t) {
                    const opt = document.createElement('option');
                    opt.value = t;
                    opt.textContent = t;
                    if (t === m.teamA) opt.selected = true;
                    teamASelect.appendChild(opt);
                });
                teamASelect.onchange = function () { m.teamA = teamASelect.value; };

                // Score A input
                const scoreAInput = document.createElement('input');
                scoreAInput.type = 'number';
                scoreAInput.min = '0';
                scoreAInput.placeholder = '0';
                scoreAInput.value = m.scoreA != null ? m.scoreA : '';
                scoreAInput.style.cssText = 'width:50px; text-align:center; padding:8px; border:1px solid #D1D5DB; border-radius:6px; font-weight:600;';
                scoreAInput.onchange = function () { 
                    m.scoreA = scoreAInput.value !== '' ? parseInt(scoreAInput.value, 10) : null; 
                };

                // VS label
                const vs = document.createElement('span');
                vs.textContent = '-';
                vs.style.cssText = 'color:#6B7280; font-weight:600; padding:0 4px;';

                // Score B input
                const scoreBInput = document.createElement('input');
                scoreBInput.type = 'number';
                scoreBInput.min = '0';
                scoreBInput.placeholder = '0';
                scoreBInput.value = m.scoreB != null ? m.scoreB : '';
                scoreBInput.style.cssText = 'width:50px; text-align:center; padding:8px; border:1px solid #D1D5DB; border-radius:6px; font-weight:600;';
                scoreBInput.onchange = function () { 
                    m.scoreB = scoreBInput.value !== '' ? parseInt(scoreBInput.value, 10) : null; 
                };

                // Team B selector
                const teamBSelect = document.createElement('select');
                teamBSelect.style.cssText = 'flex:1; padding:8px; border:1px solid #D1D5DB; border-radius:6px;';
                const teamBDefault = document.createElement('option');
                teamBDefault.value = '';
                teamBDefault.textContent = '-- Select Team --';
                teamBSelect.appendChild(teamBDefault);
                league.teams.forEach(function (t) {
                    const opt = document.createElement('option');
                    opt.value = t;
                    opt.textContent = t;
                    if (t === m.teamB) opt.selected = true;
                    teamBSelect.appendChild(opt);
                });
                teamBSelect.onchange = function () { m.teamB = teamBSelect.value; };

                // Remove button
                const removeBtn = document.createElement('button');
                removeBtn.textContent = '×';
                removeBtn.style.cssText = 'background:#FEE2E2; color:#DC2626; border:none; border-radius:6px; padding:8px 12px; cursor:pointer; font-weight:600;';
                removeBtn.onclick = function () {
                    game.matches.splice(i, 1);
                    renderMatches();
                };

                row.append(teamASelect, scoreAInput, vs, scoreBInput, teamBSelect, removeBtn);
                matchesDiv.appendChild(row);
            });
        }

        renderMatches();

        const addMatchBtn = document.createElement('button');
        addMatchBtn.textContent = '+ Add Match';
        addMatchBtn.style.cssText = 'margin-top:8px; padding:8px 16px; border:1px dashed #D1D5DB; border-radius:8px; background:#fff; cursor:pointer;';
        addMatchBtn.onclick = function () {
            if (!game.matches) game.matches = [];
            game.matches.push({ teamA: '', teamB: '', scoreA: null, scoreB: null });
            renderMatches();
        };
        container.appendChild(addMatchBtn);

        const saveBtn = document.createElement('button');
        saveBtn.textContent = gameIdx != null ? 'Update Game' : 'Save Game';
        saveBtn.style.cssText = 'margin-top:16px; padding:10px 20px; background:#10B981; color:#fff; border:none; border-radius:8px; cursor:pointer; font-weight:500; display:block;';
        saveBtn.onclick = function () {
            game.date = dateInput.value;

            // Filter out matches without both teams selected
            game.matches = (game.matches || []).filter(m => m.teamA && m.teamB);

            if (game.matches.length === 0) {
                alert('Please add at least one match with both teams selected.');
                return;
            }

            if (gameIdx != null) {
                league.games[gameIdx] = game;
            } else {
                if (!league.games) league.games = [];
                league.games.push(game);
            }

            recalcStandings(league);
            saveLeaguesData();
            renderDetailPane();
        };
        container.appendChild(saveBtn);
    }

    /**
     * ★ Import games from the current day's schedule
     * Finds league matchups and creates game entries for result entry
     */
    function importGamesFromSchedule(league) {
        if (!league) {
            alert('No league selected.');
            return;
        }

        try {
            // Get current schedule data
            const daily = window.loadCurrentDailyData?.() || {};
            const scheduleAssignments = daily.scheduleAssignments || window.scheduleAssignments || {};
            const leagueAssignments = window.leagueAssignments || {};
            const currentDate = window.currentScheduleDate || new Date().toISOString().split('T')[0];

            // Find matchups for this league
            const foundMatchups = [];
            const processedMatchups = new Set(); // Avoid duplicates

            // Method 1: Check leagueAssignments (primary source)
            for (const divName of (league.divisions || [])) {
                const divAssignments = leagueAssignments[divName];
                if (!divAssignments) continue;

                for (const slotIdx of Object.keys(divAssignments)) {
                    const slotData = divAssignments[slotIdx];
                    
                    // Check if this is for our league
                    const isOurLeague = slotData?.leagueName === league.name ||
                        slotData?.gameLabel?.includes(league.name);
                    
                    if (!isOurLeague) continue;

                    const matchups = slotData.matchups || [];

                    matchups.forEach(m => {
                        let teamA, teamB;
                        if (typeof m === 'object') {
                            teamA = m.teamA;
                            teamB = m.teamB;
                        } else if (typeof m === 'string') {
                            const parts = m.split(' vs ');
                            if (parts.length === 2) {
                                teamA = parts[0].trim();
                                teamB = parts[1].split('—')[0].trim();
                            }
                        }

                        if (teamA && teamB && teamA !== 'BYE' && teamB !== 'BYE') {
                            const key = [teamA, teamB].sort().join('|');
                            if (!processedMatchups.has(key)) {
                                processedMatchups.add(key);
                                foundMatchups.push({ teamA, teamB });
                            }
                        }
                    });
                }
            }

            // Method 2: Scan scheduleAssignments for league entries (fallback)
            if (foundMatchups.length === 0) {
                for (const bunkName of Object.keys(scheduleAssignments)) {
                    const bunkSchedule = scheduleAssignments[bunkName];
                    if (!Array.isArray(bunkSchedule)) continue;

                    for (let slotIdx = 0; slotIdx < bunkSchedule.length; slotIdx++) {
                        const entry = bunkSchedule[slotIdx];
                        if (!entry) continue;

                        const activityName = entry._activity || entry.field || '';
                        const entryLeagueName = entry._leagueName || '';
                        const isH2H = entry._h2h === true;

                        const isOurLeague = entryLeagueName === league.name ||
                            activityName.includes(`League: ${league.name}`) ||
                            (isH2H && activityName.includes(league.name));

                        if (!isOurLeague) continue;

                        const allMatchups = entry._allMatchups || [];

                        allMatchups.forEach(m => {
                            let teamA, teamB;
                            if (typeof m === 'string') {
                                const vsMatch = m.match(/^(.+?)\s+vs\s+(.+?)(?:\s*—|$)/i);
                                if (vsMatch) {
                                    teamA = vsMatch[1].trim();
                                    teamB = vsMatch[2].trim();
                                }
                            } else if (typeof m === 'object') {
                                teamA = m.teamA;
                                teamB = m.teamB;
                            }

                            if (teamA && teamB && teamA !== 'BYE' && teamB !== 'BYE') {
                                if (league.teams.includes(teamA) && league.teams.includes(teamB)) {
                                    const key = [teamA, teamB].sort().join('|');
                                    if (!processedMatchups.has(key)) {
                                        processedMatchups.add(key);
                                        foundMatchups.push({ teamA, teamB });
                                    }
                                }
                            }
                        });
                    }
                }
            }

            // Check if we found any matchups
            if (foundMatchups.length === 0) {
                alert(
                    'No league games found in today\'s schedule for "' + league.name + '".\n\n' +
                    'Make sure:\n' +
                    '1. A schedule has been generated for today\n' +
                    '2. This league is assigned to divisions that were scheduled\n' +
                    '3. The league has at least 2 teams configured'
                );
                return;
            }

            // Create a new game entry with the found matchups
            const newGame = {
                date: currentDate,
                matches: foundMatchups.map(m => ({
                    teamA: m.teamA,
                    teamB: m.teamB,
                    scoreA: null,
                    scoreB: null
                })),
                importedFrom: 'schedule',
                importedAt: new Date().toISOString()
            };

            // Check if a game for this date already exists
            if (!league.games) league.games = [];
            const existingGameIdx = league.games.findIndex(g => g.date === currentDate);
            
            if (existingGameIdx >= 0) {
                const overwrite = confirm(
                    'A game entry already exists for ' + currentDate + '.\n\n' +
                    'Do you want to replace it with the imported matchups?\n' +
                    '(Any existing scores will be lost)'
                );
                if (overwrite) {
                    league.games[existingGameIdx] = newGame;
                } else {
                    return;
                }
            } else {
                league.games.push(newGame);
            }

            // Save and refresh
            saveLeaguesData();
            
            alert(
                'Successfully imported ' + foundMatchups.length + ' match(es) from today\'s schedule!\n\n' +
                'Matchups:\n' + foundMatchups.map(m => '• ' + m.teamA + ' vs ' + m.teamB).join('\n') +
                '\n\nYou can now enter the scores.'
            );
            
            renderDetailPane();

        } catch (e) {
            console.error('[LEAGUES] Import error:', e);
            alert('Error importing games: ' + e.message);
        }
    }

    // =========================================================================
    // RECALC STANDINGS - ★ Score-based calculation
    // =========================================================================
    function recalcStandings(league) {
        if (!league || !league.teams) return;

        // Reset all standings
        league.teams.forEach(function (t) {
            league.standings[t] = { w: 0, l: 0, t: 0 };
        });

        // Calculate from games
        (league.games || []).forEach(function (g) {
            (g.matches || []).forEach(function (m) {
                // Skip if teams don't exist or scores aren't entered
                if (!m.teamA || !m.teamB) return;
                if (!league.standings[m.teamA] || !league.standings[m.teamB]) return;
                
                // Check if scores are entered (allow 0 as valid score)
                const hasScoreA = m.scoreA != null && m.scoreA !== '';
                const hasScoreB = m.scoreB != null && m.scoreB !== '';
                
                if (hasScoreA && hasScoreB) {
                    const scoreA = parseInt(m.scoreA, 10) || 0;
                    const scoreB = parseInt(m.scoreB, 10) || 0;
                    
                    if (scoreA > scoreB) {
                        // Team A wins
                        league.standings[m.teamA].w++;
                        league.standings[m.teamB].l++;
                    } else if (scoreB > scoreA) {
                        // Team B wins
                        league.standings[m.teamB].w++;
                        league.standings[m.teamA].l++;
                    } else {
                        // Tie
                        league.standings[m.teamA].t++;
                        league.standings[m.teamB].t++;
                    }
                } else if (m.winner) {
                    // Legacy support: use winner field if scores not available
                    if (m.winner === 'tie') {
                        league.standings[m.teamA].t++;
                        league.standings[m.teamB].t++;
                    } else if (m.winner === m.teamA) {
                        league.standings[m.teamA].w++;
                        league.standings[m.teamB].l++;
                    } else if (m.winner === m.teamB) {
                        league.standings[m.teamB].w++;
                        league.standings[m.teamA].l++;
                    }
                }
            });
        });
    }

    // =========================================================================
    // PUBLIC API EXPORTS
    // =========================================================================
    window.loadLeagueGlobals = function () {
        try {
            loadLeaguesData();
            loadRoundState();
        } catch (e) {
            console.error("[LEAGUES] Load error:", e);
        }
    };

    /**
     * ★ NEW: Get all enabled leagues
     */
    window.getEnabledLeagues = function () {
        return Object.values(leaguesByName).filter(l => l.enabled);
    };

    /**
     * ★ NEW: Get league by name
     */
    window.getLeagueByName = function (name) {
        return leaguesByName[name] || null;
    };

    /**
     * ★ NEW: Refresh leagues from storage
     */
    window.refreshLeagues = function () {
        refreshFromStorage();
    };

    /**
     * ★ NEW: Cleanup function for tab switching
     */
    window.cleanupLeagues = function () {
        cleanupEventListeners();
        cleanupTabListeners();
        _isInitialized = false;
    };

    // Auto-load on script run
    window.loadLeagueGlobals();

    console.log("🏆 leagues.js v2.0: window.initLeagues ready");
})();
