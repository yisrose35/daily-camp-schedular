// =================================================================
// leagues.js — PRODUCTION v2.5
// =================================================================
// v2.5: Professional UI redesign
// - Clean, minimal card-based interface
// - Inline score editing with auto-save
// - Subtle winner/tie highlighting
// - Collapsible history section
// v2.4: Multi-game import, game number preservation
// v2.3: Cross-device sync, race condition protection
// v2.0: Cloud sync, tab refresh, data validation, RBAC
// =================================================================
(function () {
    'use strict';
    console.log("[LEAGUES] v2.5 initializing...");

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
    let _saveInProgress = false;  // ★ Prevent refresh during save
    let _lastSaveTime = 0;        // ★ Track when last save happened

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
            // ★ Set flag to prevent race condition with refresh
            _saveInProgress = true;
            _lastSaveTime = Date.now();
            
            // ★ FIX: Also update localStorage immediately (not just queue for cloud)
            // This prevents the race condition where load reads stale localStorage
            try {
                const lsKey = 'campistryGlobalSettings';
                const lsRaw = localStorage.getItem(lsKey);
                const lsData = lsRaw ? JSON.parse(lsRaw) : {};
                lsData.leaguesByName = leaguesByName;
                lsData.updated_at = new Date().toISOString();
                localStorage.setItem(lsKey, JSON.stringify(lsData));
                console.log("[LEAGUES] Data written to localStorage immediately");
            } catch (lsErr) {
                console.warn("[LEAGUES] localStorage write failed:", lsErr);
            }
            
            // ★ Save via saveGlobalSettings (handles batching + cloud sync)
            window.saveGlobalSettings?.('leaguesByName', leaguesByName);
            
            console.log("[LEAGUES] Data saved to cloud");
            
            // ★ Clear flag after a short delay to allow sync to complete
            setTimeout(() => {
                _saveInProgress = false;
            }, 500);
        } catch (e) {
            console.error("[LEAGUES] Save failed:", e);
            _saveInProgress = false;
        }
    }

    function loadLeaguesData() {
        try {
            // ★ Helper to deep clone an object (prevents mutation issues)
            function deepClone(obj) {
                if (!obj) return {};
                try {
                    return JSON.parse(JSON.stringify(obj));
                } catch (e) {
                    return {};
                }
            }
            
            // ★ Helper to count VALID leagues (not just keys)
            function countValidLeagues(obj) {
                if (!obj || typeof obj !== 'object') return 0;
                let count = 0;
                Object.keys(obj).forEach(key => {
                    const league = obj[key];
                    // A valid league must have a name or teams array
                    if (league && typeof league === 'object' && 
                        (league.name || Array.isArray(league.teams))) {
                        count++;
                    }
                });
                return count;
            }
            
            // ★ Check if we're in the protection window after a save
            const timeSinceSave = Date.now() - _lastSaveTime;
            const inProtectionWindow = timeSinceSave < 5000;
            
            // ★ Check multiple sources for league data
            let loadedData = {};
            let source = 'none';
            
            // Source 1: localStorage directly (most recent local writes)
            let fromLS = {};
            let fromLSCount = 0;
            try {
                const lsRaw = localStorage.getItem('campistryGlobalSettings');
                if (lsRaw) {
                    const lsData = JSON.parse(lsRaw);
                    fromLS = lsData?.leaguesByName || {};
                    fromLSCount = countValidLeagues(fromLS);
                }
            } catch (lsErr) {
                console.log("[LEAGUES] localStorage read failed:", lsErr);
            }
            
            // Source 2: loadGlobalSettings (includes cloud-synced data)
            const global = window.loadGlobalSettings?.() || {};
            const fromGlobal = global.leaguesByName || {};
            const fromGlobalCount = countValidLeagues(fromGlobal);
            
            // Source 3: app1 nested structure (legacy)
            const fromApp1 = global.app1?.leaguesByName || {};
            const fromApp1Count = countValidLeagues(fromApp1);
            
            // ★ SMART SOURCE SELECTION:
            // - During protection window: ALWAYS prefer localStorage (prevents race condition)
            // - Outside protection window: Use whichever has the most valid data (allows cross-device sync)
            
            if (inProtectionWindow) {
                // In protection window - prefer localStorage to prevent race condition
                if (fromLSCount > 0) {
                    loadedData = deepClone(fromLS);
                    source = 'localStorage (protected)';
                } else if (fromGlobalCount > 0) {
                    loadedData = deepClone(fromGlobal);
                    source = 'global (fallback)';
                } else if (fromApp1Count > 0) {
                    loadedData = deepClone(fromApp1);
                    source = 'app1 (fallback)';
                }
            } else {
                // Outside protection window - use the best source (allows cross-device sync)
                if (fromGlobalCount >= fromLSCount && fromGlobalCount >= fromApp1Count && fromGlobalCount > 0) {
                    loadedData = deepClone(fromGlobal);
                    source = 'global';
                } else if (fromLSCount >= fromApp1Count && fromLSCount > 0) {
                    loadedData = deepClone(fromLS);
                    source = 'localStorage';
                } else if (fromApp1Count > 0) {
                    loadedData = deepClone(fromApp1);
                    source = 'app1';
                }
            }
            
            const loadedCount = countValidLeagues(loadedData);
            const currentCount = Object.keys(leaguesByName).length;

            console.log("[LEAGUES] Load sources:", {
                fromLS: fromLSCount,
                fromGlobal: fromGlobalCount,
                fromApp1: fromApp1Count,
                using: source,
                loadedCount: loadedCount,
                currentInMemory: currentCount,
                inProtectionWindow: inProtectionWindow
            });

            // ★ SAFEGUARD: If we have data but loaded empty, this is suspicious
            if (currentCount > 0 && loadedCount === 0) {
                console.warn("[LEAGUES] ⚠️ Refusing to overwrite " + currentCount + " leagues with empty data!");
                console.warn("[LEAGUES] This may be a race condition or sync issue.");
                return; // Keep current in-memory data
            }

            // GCM FIX: Don't replace the object. Clear and refill it.
            // 1. Remove old keys
            Object.keys(leaguesByName).forEach(k => delete leaguesByName[k]);

            // 2. Add new keys with validation (only valid leagues)
            Object.keys(loadedData).forEach(leagueName => {
                const league = loadedData[leagueName];
                if (league && typeof league === 'object' && 
                    (league.name || Array.isArray(league.teams))) {
                    leaguesByName[leagueName] = validateLeague(league, leagueName);
                } else {
                    console.warn("[LEAGUES] Skipping invalid league entry:", leagueName, league);
                }
            });

            console.log("[LEAGUES] Data loaded:", {
                leagues: Object.keys(leaguesByName).length,
                source: source
            });
        } catch (e) {
            console.error("[LEAGUES] Load failed:", e);
        }
    }

    /**
     * Refresh data from storage (call when tab becomes visible or after cloud sync)
     */
    function refreshFromStorage() {
        // ★ FIX: Skip refresh if save is in progress to prevent race condition
        if (_saveInProgress) {
            console.log("[LEAGUES] Skipping refresh - save in progress");
            return;
        }
        
        // ★ FIX: Also skip if we just saved (within last 5 seconds)
        // This prevents the focus event from loading stale data
        const timeSinceSave = Date.now() - _lastSaveTime;
        if (timeSinceSave < 5000) {
            console.log("[LEAGUES] Skipping refresh - recent save (" + timeSinceSave + "ms ago)");
            return;
        }
        
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
    // GAME ENTRY + IMPORT - PROFESSIONAL UI v2.5
    // =========================================================================
    
    /**
     * Render the main game entry UI with professional styling
     */
    function renderGameEntryUI(league, container) {
        renderGameEntryUIWithSelection(league, container, null);
    }
    
    function renderGameEntryUIWithSelection(league, container, highlightGameIdx) {
        if (!container) return;

        container.innerHTML = '';
        container.setAttribute('data-section', 'games');

        // Header bar
        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '20px',
            paddingBottom: '16px',
            borderBottom: '1px solid #E5E7EB'
        });
        
        const headerTitle = document.createElement('div');
        headerTitle.style.cssText = 'font-weight:600; font-size:1.1rem; color:#111827;';
        headerTitle.textContent = 'Game Results';
        header.appendChild(headerTitle);
        
        const importBtn = document.createElement('button');
        importBtn.textContent = 'Import from Schedule';
        Object.assign(importBtn.style, {
            padding: '8px 16px',
            borderRadius: '6px',
            background: '#111827',
            color: '#fff',
            border: 'none',
            cursor: 'pointer',
            fontWeight: '500',
            fontSize: '0.875rem',
            transition: 'background 0.15s ease'
        });
        importBtn.onmouseover = () => importBtn.style.background = '#374151';
        importBtn.onmouseout = () => importBtn.style.background = '#111827';
        importBtn.onclick = () => importGamesFromSchedule(league);
        header.appendChild(importBtn);
        container.appendChild(header);

        // Get and group games by date
        const games = league.games || [];
        const currentDate = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        
        const todaysGames = [];
        const pastGames = [];
        
        games.forEach((g, idx) => {
            const gameWithIdx = { ...g, _idx: idx };
            if (g.date === currentDate) {
                todaysGames.push(gameWithIdx);
            } else {
                pastGames.push(gameWithIdx);
            }
        });
        
        const sortByGameNum = (a, b) => (a.gameNumber || 0) - (b.gameNumber || 0);
        todaysGames.sort(sortByGameNum);
        pastGames.sort((a, b) => {
            if (a.date !== b.date) return (b.date || '').localeCompare(a.date || '');
            return sortByGameNum(a, b);
        });

        // TODAY'S GAMES
        const todaySection = document.createElement('div');
        todaySection.style.marginBottom = '24px';
        
        const todayHeader = document.createElement('div');
        todayHeader.style.cssText = 'font-size:0.75rem; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; color:#6B7280; margin-bottom:12px;';
        todayHeader.textContent = 'Today — ' + formatDateDisplay(currentDate);
        todaySection.appendChild(todayHeader);
        
        if (todaysGames.length === 0) {
            const emptyMsg = document.createElement('div');
            emptyMsg.style.cssText = 'padding:32px 24px; text-align:center; background:#FAFAFA; border-radius:8px; border:1px solid #E5E7EB;';
            emptyMsg.innerHTML = '<div style="font-weight:500; color:#374151; margin-bottom:4px;">No games for today</div>' +
                '<div style="font-size:0.875rem; color:#6B7280;">Import games from the schedule to enter results</div>';
            todaySection.appendChild(emptyMsg);
        } else {
            todaysGames.forEach(game => {
                const card = renderGameCard(league, game, false);
                todaySection.appendChild(card);
            });
        }
        
        container.appendChild(todaySection);
        
        // PAST GAMES (collapsible)
        if (pastGames.length > 0) {
            const pastSection = document.createElement('div');
            pastSection.style.marginBottom = '24px';
            
            const pastHeader = document.createElement('div');
            pastHeader.style.cssText = 'font-size:0.75rem; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; color:#9CA3AF; margin-bottom:12px; cursor:pointer; display:flex; align-items:center; gap:6px;';
            pastHeader.innerHTML = '<span id="past-arrow" style="font-size:0.65rem;">▶</span> History (' + pastGames.length + ')';
            
            const pastContent = document.createElement('div');
            pastContent.style.display = 'none';
            
            pastHeader.onclick = () => {
                const isHidden = pastContent.style.display === 'none';
                pastContent.style.display = isHidden ? 'block' : 'none';
                pastHeader.querySelector('#past-arrow').textContent = isHidden ? '▼' : '▶';
            };
            
            pastGames.forEach(game => {
                const card = renderGameCard(league, game, true);
                pastContent.appendChild(card);
            });
            
            pastSection.appendChild(pastHeader);
            pastSection.appendChild(pastContent);
            container.appendChild(pastSection);
        }
        
        // ADD NEW GAME
        const addNewBtn = document.createElement('button');
        addNewBtn.textContent = '+ Add Game';
        addNewBtn.style.cssText = 'padding:10px 16px; border:1px solid #E5E7EB; border-radius:6px; background:#fff; cursor:pointer; color:#6B7280; font-weight:500; font-size:0.875rem; width:100%; transition: all 0.15s ease;';
        addNewBtn.onmouseover = () => { addNewBtn.style.borderColor = '#111827'; addNewBtn.style.color = '#111827'; };
        addNewBtn.onmouseout = () => { addNewBtn.style.borderColor = '#E5E7EB'; addNewBtn.style.color = '#6B7280'; };
        addNewBtn.onclick = () => {
            if (!league.games) league.games = [];
            const newIdx = league.games.length;
            league.games.push({
                date: currentDate,
                gameLabel: 'Game ' + (newIdx + 1),
                matches: []
            });
            saveLeaguesData();
            renderGameEntryUIWithSelection(league, container, newIdx);
        };
        container.appendChild(addNewBtn);
    }
    
    /**
     * Format date for display
     */
    function formatDateDisplay(dateStr) {
        if (!dateStr) return '';
        try {
            const d = new Date(dateStr + 'T12:00:00');
            return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        } catch (e) {
            return dateStr;
        }
    }
    
    /**
     * Render a single game card
     */
    function renderGameCard(league, game, isPast) {
        const card = document.createElement('div');
        Object.assign(card.style, {
            background: '#fff',
            border: '1px solid #E5E7EB',
            borderRadius: '8px',
            marginBottom: '12px',
            overflow: 'hidden'
        });
        
        // Card Header
        const cardHeader = document.createElement('div');
        cardHeader.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:12px 16px; background:#FAFAFA; border-bottom:1px solid #E5E7EB;';
        
        const gameTitle = document.createElement('div');
        gameTitle.style.cssText = 'font-weight:600; font-size:0.9rem; color:#111827;';
        gameTitle.textContent = game.gameLabel || ('Game ' + (game._idx + 1));
        
        const headerRight = document.createElement('div');
        headerRight.style.cssText = 'display:flex; align-items:center; gap:12px;';
        
        const gameDate = document.createElement('span');
        gameDate.style.cssText = 'font-size:0.8rem; color:#6B7280;';
        gameDate.textContent = formatDateDisplay(game.date);
        
        const deleteBtn = document.createElement('button');
        deleteBtn.textContent = 'Delete';
        deleteBtn.style.cssText = 'background:none; border:none; cursor:pointer; font-size:0.75rem; color:#9CA3AF; padding:4px 8px; transition: color 0.15s;';
        deleteBtn.onmouseover = () => deleteBtn.style.color = '#DC2626';
        deleteBtn.onmouseout = () => deleteBtn.style.color = '#9CA3AF';
        deleteBtn.onclick = (e) => {
            e.stopPropagation();
            if (confirm('Delete this game? This action cannot be undone.')) {
                league.games.splice(game._idx, 1);
                recalcStandings(league);
                saveLeaguesData();
                renderGameEntryUI(league, card.parentElement);
            }
        };
        
        headerRight.appendChild(gameDate);
        headerRight.appendChild(deleteBtn);
        cardHeader.appendChild(gameTitle);
        cardHeader.appendChild(headerRight);
        card.appendChild(cardHeader);
        
        // Matchups
        const matchupsContainer = document.createElement('div');
        matchupsContainer.style.padding = '8px 0';
        
        if (!game.matches || game.matches.length === 0) {
            const noMatches = document.createElement('div');
            noMatches.style.cssText = 'text-align:center; padding:16px; color:#9CA3AF; font-size:0.875rem;';
            noMatches.textContent = 'No matchups added';
            matchupsContainer.appendChild(noMatches);
        } else {
            game.matches.forEach((match, mIdx) => {
                const matchRow = renderMatchRow(league, game, match, mIdx, isPast);
                matchupsContainer.appendChild(matchRow);
            });
        }
        
        card.appendChild(matchupsContainer);
        
        // Footer
        if (!isPast) {
            const footer = document.createElement('div');
            footer.style.cssText = 'padding:8px 16px; border-top:1px solid #F3F4F6; display:flex; justify-content:space-between; align-items:center;';
            
            const addMatchBtn = document.createElement('button');
            addMatchBtn.textContent = '+ Add Match';
            addMatchBtn.style.cssText = 'background:none; border:none; cursor:pointer; color:#6B7280; font-size:0.8rem; font-weight:500; padding:4px 0; transition: color 0.15s;';
            addMatchBtn.onmouseover = () => addMatchBtn.style.color = '#111827';
            addMatchBtn.onmouseout = () => addMatchBtn.style.color = '#6B7280';
            addMatchBtn.onclick = () => {
                if (!game.matches) game.matches = [];
                game.matches.push({ teamA: '', teamB: '', scoreA: null, scoreB: null });
                league.games[game._idx] = game;
                saveLeaguesData();
                renderGameEntryUI(league, card.parentElement);
            };
            
            const saveStatus = document.createElement('span');
            saveStatus.id = 'save-status-' + game._idx;
            saveStatus.style.cssText = 'font-size:0.75rem; color:#10B981; opacity:0; transition: opacity 0.2s;';
            saveStatus.textContent = 'Saved';
            
            footer.appendChild(addMatchBtn);
            footer.appendChild(saveStatus);
            card.appendChild(footer);
        }
        
        return card;
    }
    
    /**
     * Render a single match row
     */
    function renderMatchRow(league, game, match, matchIdx, isPast) {
        const row = document.createElement('div');
        row.style.cssText = 'display:grid; grid-template-columns:1fr auto 1fr auto; align-items:center; padding:10px 16px; border-bottom:1px solid #F3F4F6;';
        
        // Determine winner for styling
        const hasScores = match.scoreA != null && match.scoreB != null;
        const aWins = hasScores && match.scoreA > match.scoreB;
        const bWins = hasScores && match.scoreB > match.scoreA;
        const isTie = hasScores && match.scoreA === match.scoreB;
        
        // Team A
        const teamADiv = document.createElement('div');
        teamADiv.style.cssText = 'text-align:right; padding-right:12px;';
        
        const teamAName = document.createElement('span');
        teamAName.style.cssText = 'font-weight:' + (aWins ? '600' : '400') + '; color:' + (aWins ? '#111827' : '#6B7280') + '; font-size:0.9rem;';
        teamAName.textContent = match.teamA || '—';
        teamADiv.appendChild(teamAName);
        
        // Scores container
        const scoresDiv = document.createElement('div');
        scoresDiv.style.cssText = 'display:flex; align-items:center; gap:4px;';
        
        const scoreAInput = document.createElement('input');
        scoreAInput.type = 'number';
        scoreAInput.min = '0';
        scoreAInput.value = match.scoreA != null ? match.scoreA : '';
        scoreAInput.placeholder = '–';
        Object.assign(scoreAInput.style, {
            width: '40px',
            textAlign: 'center',
            padding: '6px 4px',
            border: '1px solid #E5E7EB',
            borderRadius: '4px',
            fontSize: '0.9rem',
            fontWeight: '600',
            color: '#111827',
            background: aWins ? '#F0FDF4' : (isTie ? '#FFFBEB' : '#fff')
        });
        if (isPast) { scoreAInput.disabled = true; scoreAInput.style.background = '#F9FAFB'; }
        
        const separator = document.createElement('span');
        separator.style.cssText = 'color:#D1D5DB; font-weight:400; padding:0 2px;';
        separator.textContent = '–';
        
        const scoreBInput = document.createElement('input');
        scoreBInput.type = 'number';
        scoreBInput.min = '0';
        scoreBInput.value = match.scoreB != null ? match.scoreB : '';
        scoreBInput.placeholder = '–';
        Object.assign(scoreBInput.style, {
            width: '40px',
            textAlign: 'center',
            padding: '6px 4px',
            border: '1px solid #E5E7EB',
            borderRadius: '4px',
            fontSize: '0.9rem',
            fontWeight: '600',
            color: '#111827',
            background: bWins ? '#F0FDF4' : (isTie ? '#FFFBEB' : '#fff')
        });
        if (isPast) { scoreBInput.disabled = true; scoreBInput.style.background = '#F9FAFB'; }
        
        scoresDiv.appendChild(scoreAInput);
        scoresDiv.appendChild(separator);
        scoresDiv.appendChild(scoreBInput);
        
        // Team B
        const teamBDiv = document.createElement('div');
        teamBDiv.style.cssText = 'padding-left:12px;';
        
        const teamBName = document.createElement('span');
        teamBName.style.cssText = 'font-weight:' + (bWins ? '600' : '400') + '; color:' + (bWins ? '#111827' : '#6B7280') + '; font-size:0.9rem;';
        teamBName.textContent = match.teamB || '—';
        teamBDiv.appendChild(teamBName);
        
        // Delete button
        const actionsDiv = document.createElement('div');
        actionsDiv.style.cssText = 'padding-left:12px;';
        
        if (!isPast) {
            const deleteBtn = document.createElement('button');
            deleteBtn.textContent = '×';
            deleteBtn.style.cssText = 'background:none; border:none; cursor:pointer; color:#D1D5DB; font-size:1.1rem; padding:4px 8px; transition: color 0.15s; line-height:1;';
            deleteBtn.onmouseover = () => deleteBtn.style.color = '#DC2626';
            deleteBtn.onmouseout = () => deleteBtn.style.color = '#D1D5DB';
            deleteBtn.onclick = () => {
                game.matches.splice(matchIdx, 1);
                league.games[game._idx] = game;
                recalcStandings(league);
                saveLeaguesData();
                renderGameEntryUI(league, row.closest('[data-section="games"]'));
            };
            actionsDiv.appendChild(deleteBtn);
        }
        
        // Auto-save handler
        const handleScoreChange = () => {
            match.scoreA = scoreAInput.value !== '' ? parseInt(scoreAInput.value, 10) : null;
            match.scoreB = scoreBInput.value !== '' ? parseInt(scoreBInput.value, 10) : null;
            league.games[game._idx].matches[matchIdx] = match;
            
            recalcStandings(league);
            saveLeaguesData();
            
            // Update styling
            const newHasScores = match.scoreA != null && match.scoreB != null;
            const newAWins = newHasScores && match.scoreA > match.scoreB;
            const newBWins = newHasScores && match.scoreB > match.scoreA;
            const newIsTie = newHasScores && match.scoreA === match.scoreB;
            
            teamAName.style.fontWeight = newAWins ? '600' : '400';
            teamAName.style.color = newAWins ? '#111827' : '#6B7280';
            teamBName.style.fontWeight = newBWins ? '600' : '400';
            teamBName.style.color = newBWins ? '#111827' : '#6B7280';
            
            scoreAInput.style.background = newAWins ? '#F0FDF4' : (newIsTie ? '#FFFBEB' : '#fff');
            scoreBInput.style.background = newBWins ? '#F0FDF4' : (newIsTie ? '#FFFBEB' : '#fff');
            
            // Show save indicator
            const saveStatus = document.getElementById('save-status-' + game._idx);
            if (saveStatus) {
                saveStatus.style.opacity = '1';
                setTimeout(() => { saveStatus.style.opacity = '0'; }, 1500);
            }
        };
        
        scoreAInput.onchange = handleScoreChange;
        scoreBInput.onchange = handleScoreChange;
        
        row.appendChild(teamADiv);
        row.appendChild(scoresDiv);
        row.appendChild(teamBDiv);
        row.appendChild(actionsDiv);
        
        return row;
    }


    // =========================================================================
    // ★ SMART DIVISION MATCHING
    // Handles variations like "1st grade" vs "1", "Grade 1", "1st", etc.
    // But avoids false matches like "1" matching "11"
    // =========================================================================
    
    /**
     * Extract the grade/division number from a string
     * Returns { number: X, suffix: 'st'|'nd'|'rd'|'th'|'', hasGrade: bool }
     */
    function extractDivisionNumber(str) {
        if (!str) return null;
        const s = String(str).toLowerCase().trim();
        
        // Pattern: "1st", "2nd", "3rd", "4th", "11th", etc.
        const ordinalMatch = s.match(/^(\d+)(st|nd|rd|th)?\s*(grade)?$/);
        if (ordinalMatch) {
            return { 
                number: parseInt(ordinalMatch[1], 10), 
                suffix: ordinalMatch[2] || '',
                hasGrade: !!ordinalMatch[3]
            };
        }
        
        // Pattern: "grade 1", "grade 11"
        const gradeMatch = s.match(/^grade\s*(\d+)$/);
        if (gradeMatch) {
            return { 
                number: parseInt(gradeMatch[1], 10), 
                suffix: '',
                hasGrade: true
            };
        }
        
        // Pattern: just a number "1", "11"
        const numMatch = s.match(/^(\d+)$/);
        if (numMatch) {
            return { 
                number: parseInt(numMatch[1], 10), 
                suffix: '',
                hasGrade: false
            };
        }
        
        // Pattern: "division 1", "div 3"
        const divMatch = s.match(/^(?:division|div)\s*(\d+)$/);
        if (divMatch) {
            return { 
                number: parseInt(divMatch[1], 10), 
                suffix: '',
                hasGrade: false
            };
        }
        
        return null;
    }
    
    /**
     * Check if two division names refer to the same division
     * Strict matching to avoid "1" matching "11"
     */
    function divisionsMatch(div1, div2) {
        if (!div1 || !div2) return false;
        
        // Exact match (case-insensitive)
        if (String(div1).toLowerCase().trim() === String(div2).toLowerCase().trim()) {
            return true;
        }
        
        // Extract numbers and compare
        const num1 = extractDivisionNumber(div1);
        const num2 = extractDivisionNumber(div2);
        
        if (num1 && num2) {
            // Numbers must match exactly (prevents "1" matching "11")
            return num1.number === num2.number;
        }
        
        // Check if one contains the other as a word boundary match
        // e.g., "Junior Boys" contains "Junior Boys 1" - but we want exact for numbers
        const s1 = String(div1).toLowerCase().trim();
        const s2 = String(div2).toLowerCase().trim();
        
        // If neither has a number, check for substring with word boundaries
        if (!num1 && !num2) {
            // One must fully contain the other
            return s1.includes(s2) || s2.includes(s1);
        }
        
        return false;
    }
    
    /**
     * Find all schedule divisions that match any of the league's divisions
     */
    function getMatchingScheduleDivisions(leagueDivisions, availableDivisions) {
        const matches = new Set();
        
        for (const leagueDiv of leagueDivisions) {
            for (const schedDiv of availableDivisions) {
                if (divisionsMatch(leagueDiv, schedDiv)) {
                    matches.add(schedDiv);
                    console.log(`[LEAGUES] Division match: "${leagueDiv}" ↔ "${schedDiv}"`);
                }
            }
        }
        
        return Array.from(matches);
    }

    /**
     * ★ Import games from the current day's schedule
     * Finds league matchups and creates game entries for result entry
     * Supports multiple games per day with correct game numbers from schedule
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

            console.log('[LEAGUES] Import: Looking for games for league "' + league.name + '"');
            console.log('[LEAGUES] Import: League divisions:', league.divisions);
            console.log('[LEAGUES] Import: Available leagueAssignments keys:', Object.keys(leagueAssignments));

            // ★ Group matchups by game number/label
            // Structure: { "Game 11": { gameLabel, slotIdx, matchups: [...] }, "Game 12": {...} }
            const gamesByLabel = {};

            // ★ Use smart division matching to find schedule divisions that match league divisions
            const availableScheduleDivisions = Object.keys(leagueAssignments);
            const matchingDivisions = getMatchingScheduleDivisions(league.divisions || [], availableScheduleDivisions);
            
            console.log('[LEAGUES] Import: Matching divisions found:', matchingDivisions);

            // Method 1: Check leagueAssignments using smart-matched divisions (primary source)
            for (const divName of matchingDivisions) {
                const divAssignments = leagueAssignments[divName];
                if (!divAssignments) continue;

                for (const slotIdx of Object.keys(divAssignments)) {
                    const slotData = divAssignments[slotIdx];
                    if (!slotData) continue;
                    
                    const slotLeagueName = slotData?.leagueName || '';
                    const slotGameLabel = slotData?.gameLabel || '';
                    const matchups = slotData.matchups || [];
                    
                    console.log('[LEAGUES] Import: Checking slot', slotIdx, '- leagueName:', slotLeagueName, 'gameLabel:', slotGameLabel, 'matchups:', matchups.length);
                    
                    // Check if this is our league
                    const nameMatches = slotLeagueName === league.name ||
                        slotLeagueName.toLowerCase() === league.name.toLowerCase() ||
                        (slotGameLabel && slotGameLabel.toLowerCase().includes(league.name.toLowerCase()));
                    
                    // If no name match, check if teams belong to this league
                    let teamsMatch = false;
                    if (!nameMatches && matchups.length > 0) {
                        const matchupTeams = new Set();
                        matchups.forEach(m => {
                            if (typeof m === 'object') {
                                if (m.teamA) matchupTeams.add(m.teamA);
                                if (m.teamB) matchupTeams.add(m.teamB);
                            } else if (typeof m === 'string') {
                                const vsMatch = m.match(/^(.+?)\s+vs\s+(.+?)(?:\s+@|\s*—|$)/i);
                                if (vsMatch) {
                                    matchupTeams.add(vsMatch[1].trim());
                                    matchupTeams.add(vsMatch[2].trim());
                                }
                            }
                        });
                        
                        if (matchupTeams.size > 0 && league.teams && league.teams.length > 0) {
                            const leagueTeamsSet = new Set(league.teams);
                            teamsMatch = Array.from(matchupTeams).every(t => 
                                t === 'BYE' || leagueTeamsSet.has(t)
                            );
                        }
                    }
                    
                    if (!nameMatches && !teamsMatch) continue;

                    // ★ Extract game number from gameLabel (e.g., "Game 11" → 11)
                    let gameNumber = null;
                    let gameLabel = slotGameLabel || 'Game';
                    
                    const gameNumMatch = slotGameLabel.match(/Game\s*(\d+)/i);
                    if (gameNumMatch) {
                        gameNumber = parseInt(gameNumMatch[1], 10);
                        gameLabel = 'Game ' + gameNumber;
                    } else {
                        // Fallback: use slot index to differentiate
                        gameLabel = 'Game (Slot ' + slotIdx + ')';
                    }

                    console.log('[LEAGUES] Import: ✓ Found ' + gameLabel + ' in div "' + divName + '" slot ' + slotIdx);

                    // ★ Initialize game entry if not exists
                    if (!gamesByLabel[gameLabel]) {
                        gamesByLabel[gameLabel] = {
                            gameLabel: gameLabel,
                            gameNumber: gameNumber,
                            slotIdx: parseInt(slotIdx, 10),
                            matchups: []
                        };
                    }

                    // ★ Add matchups to this game (avoid duplicates)
                    const existingKeys = new Set(gamesByLabel[gameLabel].matchups.map(m => 
                        [m.teamA, m.teamB].sort().join('|')
                    ));

                    matchups.forEach(m => {
                        let teamA, teamB;
                        if (typeof m === 'object') {
                            teamA = m.teamA;
                            teamB = m.teamB;
                        } else if (typeof m === 'string') {
                            const vsMatch = m.match(/^(.+?)\s+vs\s+(.+?)(?:\s+@|\s*—|$)/i);
                            if (vsMatch) {
                                teamA = vsMatch[1].trim();
                                teamB = vsMatch[2].trim();
                            }
                        }

                        if (teamA && teamB && teamA !== 'BYE' && teamB !== 'BYE') {
                            const key = [teamA, teamB].sort().join('|');
                            if (!existingKeys.has(key)) {
                                existingKeys.add(key);
                                gamesByLabel[gameLabel].matchups.push({ teamA, teamB });
                                console.log('[LEAGUES] Import: Added match:', teamA, 'vs', teamB, 'to', gameLabel);
                            }
                        }
                    });
                }
            }

            // Check if we found any games
            const gameLabels = Object.keys(gamesByLabel);
            if (gameLabels.length === 0) {
                alert(
                    'No league games found in today\'s schedule for "' + league.name + '".\n\n' +
                    'Make sure:\n' +
                    '1. A schedule has been generated for today\n' +
                    '2. This league is assigned to divisions that were scheduled\n' +
                    '3. The league has at least 2 teams configured'
                );
                return;
            }

            // ★ Sort games by game number
            gameLabels.sort((a, b) => {
                const numA = gamesByLabel[a].gameNumber || 0;
                const numB = gamesByLabel[b].gameNumber || 0;
                return numA - numB;
            });

            // ★ Create game entries for each game found
            if (!league.games) league.games = [];
            
            const importedGames = [];
            let totalMatchups = 0;

            gameLabels.forEach(label => {
                const gameData = gamesByLabel[label];
                if (gameData.matchups.length === 0) return;

                const newGame = {
                    date: currentDate,
                    gameLabel: gameData.gameLabel,
                    gameNumber: gameData.gameNumber,
                    matches: gameData.matchups.map(m => ({
                        teamA: m.teamA,
                        teamB: m.teamB,
                        scoreA: null,
                        scoreB: null
                    })),
                    importedFrom: 'schedule',
                    importedAt: new Date().toISOString()
                };

                // Check if this specific game already exists (by date AND game label)
                const existingIdx = league.games.findIndex(g => 
                    g.date === currentDate && g.gameLabel === gameData.gameLabel
                );

                if (existingIdx >= 0) {
                    // Update existing
                    league.games[existingIdx] = newGame;
                } else {
                    // Add new
                    league.games.push(newGame);
                }

                importedGames.push(gameData.gameLabel);
                totalMatchups += gameData.matchups.length;
            });

            // Save
            saveLeaguesData();
            
            // Build summary message
            let summary = 'Imported ' + importedGames.length + ' game(s) with ' + totalMatchups + ' matches.\n\n';
            
            gameLabels.forEach(label => {
                const gameData = gamesByLabel[label];
                if (gameData.matchups.length === 0) return;
                summary += gameData.gameLabel + ':\n';
                gameData.matchups.forEach(m => {
                    summary += '  ' + m.teamA + ' vs ' + m.teamB + '\n';
                });
                summary += '\n';
            });
            
            alert(summary);
            
            // ★ Refresh the games section - all imported games will show automatically
            // The new UI shows all today's games as cards
            const gamesContainer = detailPaneEl?.querySelector('[data-section="games"]');
            if (gamesContainer) {
                renderGameEntryUI(league, gamesContainer);
                gamesContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } else {
                // Fallback - re-render detail pane and switch to games tab
                renderDetailPane();
                setTimeout(() => {
                    const gamesTab = detailPaneEl?.querySelector('#tab-games');
                    if (gamesTab) gamesTab.click();
                }, 100);
            }

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

    console.log("[LEAGUES] v2.5 ready");
})();
