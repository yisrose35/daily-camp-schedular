// =================================================================
// leagues.js — PRODUCTION v2.5
// =================================================================
// v2.5: Professional UI redesign (CSS Class Implementation)
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
    const _advancedOpenLeagues = new Set();
    const _chinuchOverrideOpenLeagues = new Set();
    let _isInitialized = false;
    let _refreshTimeout = null;
    let _saveInProgress = 0;  // ★ Counter: >0 means save in flight (prevents refresh)
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
    function escapeHtml(str) { return window.CampUtils.escapeHtml(str); }  // → campistry_utils.js (canonical)

    /**
     * Get valid division names for orphan detection
     */
    function getValidDivisionNames() {
        try {
            const divisions = window.divisions || window.getGlobalDivisions?.() || {};
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
                : 'sport_variety',
            offCampus: (league.offCampus && typeof league.offCampus === 'object')
                ? { enabled: league.offCampus.enabled === true, zone: typeof league.offCampus.zone === 'string' ? league.offCampus.zone : '', teamsPerDay: parseInt(league.offCampus.teamsPerDay) || 0 }
                : { enabled: false, zone: '', teamsPerDay: 0 },
            // ★ Preserve the playoff sub-object verbatim. Earlier this field
            //   was dropped, so any cloud-sync echo or background re-validation
            //   that ran right after a save (e.g. saving from the Playoff Hub)
            //   wiped enable/style/seeds/rounds and made the bracket appear
            //   to "shut off" until the user re-toggled it.
            playoff: (league.playoff && typeof league.playoff === 'object') ? league.playoff : undefined,
            indoorRequirement: (league.indoorRequirement && typeof league.indoorRequirement === 'object')
                ? {
                    enabled: league.indoorRequirement.enabled === true,
                    op: (['>=', '<=', '='].indexOf(league.indoorRequirement.op) !== -1) ? league.indoorRequirement.op : '>=',
                    count: (Number.isInteger(league.indoorRequirement.count) && league.indoorRequirement.count >= 0) ? league.indoorRequirement.count : 1
                  }
                : { enabled: false, op: '>=', count: 1 },
            chinuch: (league.chinuch && typeof league.chinuch === 'object')
                ? {
                    enabled: league.chinuch.enabled === true,
                    // All override fields are null by default → solver auto-calculates
                    timesPerDay: (Number.isInteger(league.chinuch.timesPerDay) && league.chinuch.timesPerDay > 0) ? league.chinuch.timesPerDay : null,
                    teamsPerRound: (Number.isInteger(league.chinuch.teamsPerRound) && league.chinuch.teamsPerRound > 0) ? league.chinuch.teamsPerRound : null,
                    // Exact per-session counts (most specific). When set, overrides timesPerDay and teamsPerRound.
                    perSessionCounts: (Array.isArray(league.chinuch.perSessionCounts) && league.chinuch.perSessionCounts.length > 0)
                        ? league.chinuch.perSessionCounts
                            .map(function (n) { return Number.isFinite(Number(n)) ? Math.max(0, Math.floor(Number(n))) : null; })
                            .filter(function (n) { return n !== null; })
                        : null,
                    bunkFacilities: (league.chinuch.bunkFacilities && typeof league.chinuch.bunkFacilities === 'object') ? league.chinuch.bunkFacilities : {}
                  }
                : { enabled: false, timesPerDay: null, teamsPerRound: null, perSessionCounts: null, bunkFacilities: {} }
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
        // Clean up standings for teams that no longer exist
        Object.keys(validated.standings).forEach(team => {
            if (!validated.teams.includes(team)) {
                delete validated.standings[team];
            }
        });

        // ★ v2.6: Validate teams against actual bunks in assigned divisions
        if (validDivisions && validDivisions.size > 0 && validated.divisions.length > 0) {
            try {
                const allDivisions = window.divisions || window.getGlobalDivisions?.() || {};
                const validBunks = new Set();
                
                validated.divisions.forEach(divName => {
                    const div = allDivisions[divName];
                    if (div?.bunks && Array.isArray(div.bunks)) {
                        div.bunks.forEach(b => validBunks.add(b));
                    }
                });
                
                // ★ #V2-8 fix: teams are SEPARATE entities from bunks (custom names like
                //   "Cobras" / "Red" / "1" are EXPECTED and correct), so comparing team names
                //   to bunk names false-fired a "team not in any division" warning for EVERY
                //   normally-configured league — and stayed silent for the genuinely-broken
                //   case. The real problem is a league that has teams but NO playable bunks
                //   (no assigned division, or its divisions have no bunks): those games can't
                //   be scheduled. Warn on THAT, not on custom team names.
                if ((validated.teams || []).length > 0 && validBunks.size === 0) {
                    console.warn(`[LEAGUES] "${leagueName}" has ${validated.teams.length} team(s) but no playable bunks (no assigned division with bunks) — its games won't be scheduled.`);
                }
            } catch (e) {
                // Non-critical validation, don't block load
            }
        }

        return validated;
    }
    // =========================================================================
    // LOAD + SAVE - ★ CLOUD SYNC AWARE
    // =========================================================================
    function loadRoundState() {
        try {
            const global = window.loadGlobalSettings?.() || {};
            const raw = global.leagueRoundState || {};
            
            // ★ v2.6: Validate and migrate round state structure
            const validated = {};
            Object.keys(raw).forEach(leagueName => {
                const entry = raw[leagueName];
                if (!entry || typeof entry !== 'object') return;
                
                validated[leagueName] = {
                    currentRound: typeof entry.currentRound === 'number' ? entry.currentRound : 0,
                    gamesPerDate: (entry.gamesPerDate && typeof entry.gamesPerDate === 'object') ? entry.gamesPerDate : {},
                    lastScheduledDate: entry.lastScheduledDate || null,
                    sportRotationIndex: typeof entry.sportRotationIndex === 'number' ? entry.sportRotationIndex : 0,
                    // Preserve any additional properties for forward compatibility
                    ...Object.fromEntries(
                        Object.entries(entry).filter(([k]) => 
                            !['currentRound', 'gamesPerDate', 'lastScheduledDate', 'sportRotationIndex'].includes(k)
                        )
                    )
                };
            });
            
            // Remove round state for leagues that no longer exist
            const existingLeagues = new Set(Object.keys(leaguesByName));
            Object.keys(validated).forEach(name => {
                if (existingLeagues.size > 0 && !existingLeagues.has(name)) {
                    console.log(`[LEAGUES] Removing orphaned round state for deleted league: "${name}"`);
                    delete validated[name];
                }
            });
            
            leagueRoundState = validated;
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
            _saveInProgress++;
            _lastSaveTime = Date.now();
            
            // ★ FIX: Also update localStorage immediately (not just queue for cloud)
            // This prevents the race condition where load reads stale localStorage
            // Strip transient computed fields before persisting
            var cleanData = JSON.parse(JSON.stringify(leaguesByName));
            for (var _lk in cleanData) {
                if (cleanData[_lk] && cleanData[_lk]._h2h) delete cleanData[_lk]._h2h;
            }

            try {
                const lsKey = 'campistryGlobalSettings';
                const lsRaw = localStorage.getItem(lsKey);
                const lsData = lsRaw ? JSON.parse(lsRaw) : {};
                lsData.leaguesByName = cleanData;
                lsData.updated_at = new Date().toISOString();
                localStorage.setItem(lsKey, JSON.stringify(lsData));
                console.log("[LEAGUES] Data written to localStorage immediately");
            } catch (lsErr) {
                console.warn("[LEAGUES] localStorage write failed:", lsErr);
            }

            // ★ Save via saveGlobalSettings (handles batching + cloud sync)
            window.saveGlobalSettings?.('leaguesByName', cleanData);
            
            console.log("[LEAGUES] Data saved to cloud");
            
            // ★ Clear flag after protection window to prevent stale refresh
            // Must match the 5-second window in refreshFromStorage
            setTimeout(() => {
                _saveInProgress = Math.max(0, _saveInProgress - 1);
            }, 5500);
        } catch (e) {
            console.error("[LEAGUES] Save failed:", e);
            _saveInProgress = Math.max(0, _saveInProgress - 1);
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

            // ★ Snapshot in-memory playoff state BEFORE clearing so we can
            //   defend against stale cloud echoes that haven't yet received
            //   the latest bracket save. If cloud says rounds=[] but we have
            //   real rounds in memory, keep ours — local writes always win.
            const _playoffBackup = {};
            Object.keys(leaguesByName).forEach(k => {
                const p = leaguesByName[k] && leaguesByName[k].playoff;
                if (p && Array.isArray(p.rounds) && p.rounds.length > 0) {
                    _playoffBackup[k] = p;
                }
            });

            // GCM FIX: Don't replace the object. Clear and refill it.
            // 1. Remove old keys
            Object.keys(leaguesByName).forEach(k => delete leaguesByName[k]);

            // 2. Add new keys with validation (only valid leagues)
            Object.keys(loadedData).forEach(leagueName => {
                const league = loadedData[leagueName];
                if (league && typeof league === 'object' &&
                    (league.name || Array.isArray(league.teams))) {
                    const validated = validateLeague(league, leagueName);
                    // Restore richer in-memory playoff state if loaded copy has
                    // empty rounds but we had a populated bracket (stale cloud).
                    const backup = _playoffBackup[leagueName];
                    const loadedRoundsEmpty = !validated.playoff
                        || !Array.isArray(validated.playoff.rounds)
                        || validated.playoff.rounds.length === 0;
                    if (backup && loadedRoundsEmpty) {
                        validated.playoff = backup;
                        console.log('[LEAGUES] Preserved in-memory playoff bracket for "' + leagueName + '" (loaded copy had empty rounds)');
                    }
                    leaguesByName[leagueName] = validated;
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
        
        // ★ FIX: Extended protection window to 8 seconds to cover cloud round-trip
        const timeSinceSave = Date.now() - _lastSaveTime;
        if (timeSinceSave < 8000) {
            console.log("[LEAGUES Skipping refresh - recent save (" + timeSinceSave + "ms ago)");
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
            input.className = 'league-inline-edit';
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

        // LAYOUT
       const contentWrapper = document.createElement('div');
        contentWrapper.innerHTML = `
            <div class="setup-grid">
              <section class="setup-card setup-card-wide" style="border:none; box-shadow:none; background:transparent; padding-bottom:0;">
                <div class="setup-card-header" style="margin-bottom:20px;">
                  <span class="setup-step-pill">Leagues</span>
                  <div class="setup-card-text">
                    <h3>Manage Leagues</h3>
                    <p>Configure leagues, teams, standings, and game results.</p>
                  </div>
                </div>

                <div style="display:flex; flex-wrap:wrap; gap:24px;">
                  <!-- LEFT SIDE: MASTER LIST -->
                  <div style="flex:1; min-width:280px;">
                    <div style="display:flex; justify-content:space-between; align-items:end; margin-bottom:8px;">
                      <div class="setup-subtitle">All Leagues</div>
                    </div>

                    <div style="background:white; padding:10px; border-radius:12px; border:1px solid #E5E7EB; margin-bottom:12px; display:flex; gap:8px;">
                      <input id="league-add-input" placeholder="New League (e.g., Soccer League)" style="flex:1; border:none; outline:none; font-size:0.9rem;">
                      <button id="league-add-btn" style="background:#111; color:white; border:none; border-radius:6px; padding:6px 12px; font-size:0.8rem; cursor:pointer;">Add</button>
                    </div>

                    <div id="leagues-master-list" class="master-list" style="max-height:max(360px, calc(100vh - 297px)); overflow-y:auto;"></div>
                  </div>

                  <!-- RIGHT SIDE: DETAIL PANE -->
                  <div style="flex:1.4; min-width:340px;">
                    <div class="setup-subtitle">League Configuration</div>
                    <div id="leagues-detail-pane" style="margin-top:8px;"></div>
                  </div>
                </div>
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
                alert('League "' + name + '" already exists.');
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
            listEl.innerHTML = '<div style="padding:20px; text-align:center; color:#9CA3AF;">No leagues created yet.</div>';
            return;
        }
        keys.forEach(function (name) {
            const item = leaguesByName[name];
            const el = document.createElement('div');
            el.className = 'list-item' + (name === selectedLeagueName ? ' selected' : '');
            el.onclick = function () {
                selectedLeagueName = name;
                renderMasterList();
                renderDetailPane();
            };

            const infoDiv = document.createElement('div');
            const nameEl = document.createElement('div');
            nameEl.className = 'list-item-name';
            nameEl.textContent = name;
            infoDiv.appendChild(nameEl);
            el.appendChild(infoDiv);

            const tog = document.createElement('label');
            tog.className = 'switch list-item-toggle';
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
            tog.appendChild(cb);
            tog.appendChild(slider);
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
            detailPaneEl.innerHTML = '<div style="height:300px; display:flex; align-items:center; justify-content:center; color:#9CA3AF; border:1px dashed #E5E7EB; border-radius:12px;">Select a league to edit details</div>';
            return;
        }
        const league = leaguesByName[selectedLeagueName];
        detailPaneEl.innerHTML = '';

        // --- HEADER ---
        const header = document.createElement('div');
        header.className = 'league-detail-header';

        const title = document.createElement('h3');
        title.className = 'league-detail-title';
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
                alert('League "' + newName + '" already exists.');
            }
        });

        const btnGroup = document.createElement('div');
        btnGroup.className = 'league-btn-group';

        // NEUTRAL BUTTON
        const editConfigBtn = document.createElement('button');
        editConfigBtn.textContent = 'Edit Setup';
        editConfigBtn.className = 'league-btn-neutral';

        // PLAYOFF BUTTON
        const playoffBtn = document.createElement('button');
        const _playoffActive = !!(league.playoff && league.playoff.enabled);
        playoffBtn.textContent = _playoffActive ? 'Playoff: ON' : 'Playoff Mode';
        playoffBtn.className = 'league-btn-neutral' + (_playoffActive ? ' active' : '');

        // DELETE BUTTON
        const delBtn = document.createElement('button');
        delBtn.textContent = 'Delete';
        delBtn.className = 'league-btn-delete';
        delBtn.onclick = function () {
            // Delete is destructive camp-wide — require canEraseData (owner/admin only)
            if (!window.AccessControl?.canEraseData?.()) {
                window.AccessControl?.showPermissionDenied?.('delete leagues');
                return;
            }

            if (confirm("Delete league \"" + selectedLeagueName + "\"?")) {
                delete leaguesByName[selectedLeagueName];
                selectedLeagueName = null;
                saveLeaguesData();
                renderMasterList();
                detailPaneEl.innerHTML = '<div style="height:300px; display:flex; align-items:center; justify-content:center; color:#9CA3AF; border:1px dashed #E5E7EB; border-radius:12px;">Select a league to edit details</div>';
            }
        };

        btnGroup.append(editConfigBtn, playoffBtn, delBtn);
        header.append(title, btnGroup);
        detailPaneEl.appendChild(header);

        // --- CONFIG CONTAINER (Hidden by default) ---
        const configContainer = document.createElement('div');
        configContainer.className = 'league-config-container';
        renderConfigSections(league, configContainer);
        detailPaneEl.appendChild(configContainer);

        editConfigBtn.onclick = function () {
            const isOpen = configContainer.classList.contains('open');
            if (isOpen) {
                configContainer.classList.remove('open');
                editConfigBtn.textContent = 'Edit Setup';
                editConfigBtn.classList.remove('active');
            } else {
                configContainer.classList.add('open');
                editConfigBtn.textContent = 'Close Setup';
                editConfigBtn.classList.add('active');
            }
        };

        // ★ Playoff button now opens the dedicated per-league Playoff Hub
        //   overlay (window.PlayoffHub.open). The old collapsible inline panel
        //   was replaced because users asked for one focused, shared UI per
        //   league. The hub still saves through the same league.playoff
        //   sub-object, so any state set there is read by the scheduler.
        playoffBtn.onclick = function () {
            if (window.PlayoffHub && typeof window.PlayoffHub.open === 'function') {
                window.PlayoffHub.open(league, 'regular');
            } else {
                alert('Playoff Hub module not loaded.');
            }
        };

        // --- MAIN CONTENT (Standings/Results) ---
        const mainContent = document.createElement('div');
        renderGameResultsUI(league, mainContent);
        detailPaneEl.appendChild(mainContent);
    }

    function mountPlayoffUI(mountEl, league) {
        if (!window.PlayoffMode) {
            mountEl.innerHTML = '<div style="padding:12px;color:#9CA3AF;font-size:0.82rem;">Playoff module unavailable.</div>';
            return;
        }
        window.PlayoffMode.render(league, mountEl, {
            onSave: function () { saveLeaguesData(); },
            getSports: function () { return league.sports || []; },
            getActivities: function () {
                var settings = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
                var fields = settings.fields || (settings.app1 && settings.app1.fields) || [];
                var acts = new Set();
                fields.forEach(function (f) { if (f && f.name) acts.add(f.name); });
                (window.getAllGlobalSports ? window.getAllGlobalSports() : []).forEach(function (s) { acts.add(s); });
                return Array.from(acts).sort();
            },
            readOnly: !!(window.AccessControl?.canEditSetup && !window.AccessControl.canEditSetup())
        });
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
        priorityDesc.className = 'league-priority-desc';
        priorityDesc.textContent = 'Choose what the scheduler prioritizes when assigning games:';
        priorityCard.appendChild(priorityDesc);

        const priorityToggle = document.createElement('div');
        priorityToggle.className = 'priority-toggle';

        const sportBtn = document.createElement('button');
        sportBtn.className = 'priority-toggle-btn' + (league.schedulingPriority === 'sport_variety' ? ' active' : '');
        sportBtn.innerHTML = '<strong>Sport Variety</strong><br><span class="league-priority-sub">Play all sports before repeating</span>';
        sportBtn.onclick = function () {
            league.schedulingPriority = 'sport_variety';
            saveLeaguesData();
            renderConfigSections(league, container);
        };

        const matchupBtn = document.createElement('button');
        matchupBtn.className = 'priority-toggle-btn' + (league.schedulingPriority === 'matchup_variety' ? ' active' : '');
        matchupBtn.innerHTML = '<strong>Matchup Variety</strong><br><span class="league-priority-sub">Play all teams before repeating</span>';
        matchupBtn.onclick = function () {
            league.schedulingPriority = 'matchup_variety';
            saveLeaguesData();
            renderConfigSections(league, container);
        };

        priorityToggle.append(sportBtn, matchupBtn);
        priorityCard.appendChild(priorityToggle);

        const priorityNote = document.createElement('p');
        priorityNote.className = 'league-priority-note';
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
        // ★ Day 20 fix #6: use Me-page (Camp Structure) order, not the
        // alphabetized window.availableDivisions. window.divisions is an
        // object keyed by division name in user-defined insertion order;
        // Object.keys preserves that order. Falls back to availableDivisions
        // if window.divisions isn't loaded yet.
        const _meOrder = Object.keys(window.divisions || {});
        const _divOrder = _meOrder.length > 0 ? _meOrder : (window.availableDivisions || []);
        _divOrder.forEach(function (divName) {
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
            removeSpan.className = 'league-chip-remove';
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
        teamInput.className = 'league-team-input';
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

        // \u2500\u2500\u2500 Advanced Settings Collapsible \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
        const advancedOpen = _advancedOpenLeagues.has(league.name);
        const advancedWrap = document.createElement('div');
        advancedWrap.style.cssText = 'margin-top:14px;';

        const advancedToggle = document.createElement('button');
        advancedToggle.type = 'button';
        advancedToggle.style.cssText = 'display:flex; align-items:center; gap:8px; width:100%; padding:10px 12px; background:transparent; border:none; border-top:1px solid #E5E7EB; cursor:pointer; font-size:0.78rem; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; color:#6B7280; text-align:left;';
        const advancedChevron = document.createElement('span');
        advancedChevron.textContent = advancedOpen ? '\u25be' : '\u25b8';
        advancedChevron.style.cssText = 'display:inline-block; width:12px; color:#9CA3AF; font-size:0.85rem;';
        const advancedLabel = document.createElement('span');
        advancedLabel.textContent = 'Advanced Settings';
        advancedToggle.appendChild(advancedChevron);
        advancedToggle.appendChild(advancedLabel);

        // Summary chip when collapsed
        const _summaryBits = [];
        if (league.offCampus?.enabled) _summaryBits.push('Away Games');
        if (league.chinuch?.enabled) _summaryBits.push('Chinuch');
        if (league.indoorRequirement?.enabled) _summaryBits.push('Indoor Rule');
        if (_summaryBits.length > 0) {
            const summary = document.createElement('span');
            summary.textContent = _summaryBits.join(' \u00b7 ');
            summary.style.cssText = 'margin-left:auto; font-size:0.7rem; font-weight:500; text-transform:none; letter-spacing:0; color:#16A34A; background:#F0FDF4; border:1px solid #BBF7D0; border-radius:10px; padding:2px 8px;';
            advancedToggle.appendChild(summary);
        }

        const advancedBody = document.createElement('div');
        advancedBody.style.cssText = 'display:' + (advancedOpen ? 'block' : 'none') + '; padding-top:4px;';

        advancedToggle.onclick = function () {
            const nowOpen = !_advancedOpenLeagues.has(league.name);
            if (nowOpen) _advancedOpenLeagues.add(league.name);
            else _advancedOpenLeagues.delete(league.name);
            advancedBody.style.display = nowOpen ? 'block' : 'none';
            advancedChevron.textContent = nowOpen ? '\u25be' : '\u25b8';
        };

        advancedWrap.appendChild(advancedToggle);
        advancedWrap.appendChild(advancedBody);
        container.appendChild(advancedWrap);

        // \u2500\u2500\u2500 Away Games Card \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
        if (!league.offCampus) league.offCampus = { enabled: false, zone: '', teamsPerDay: 0 };
        const settings = window.loadGlobalSettings?.() || {};
        const locationZones = settings.locationZones || settings.global?.locationZones || {};
        const totalTeams = (league.teams || []).length;

        const awayCard = document.createElement('div');
        awayCard.style.cssText = 'border:1px solid #E2E8F0; border-radius:12px; overflow:hidden; margin-top:8px;';

        // Header bar \u2014 toggle lives here
        const awayHeader = document.createElement('label');
        awayHeader.style.cssText = 'display:flex; align-items:center; gap:10px; padding:12px 14px; cursor:pointer; background:' + (league.offCampus.enabled ? '#EFF6FF' : '#F9FAFB') + '; border-bottom:' + (league.offCampus.enabled ? '1px solid #BFDBFE' : 'none') + ';';
        const awayCb = document.createElement('input');
        awayCb.type = 'checkbox';
        awayCb.checked = league.offCampus.enabled === true;
        awayCb.style.cssText = 'width:16px; height:16px; accent-color:#2563EB;';
        awayCb.onchange = function () { league.offCampus.enabled = awayCb.checked; saveLeaguesData(); renderConfigSections(league, container); };
        awayHeader.appendChild(awayCb);
        const awayTitle = document.createElement('div');
        awayTitle.innerHTML = '<div style="font-size:0.85rem; font-weight:600; color:#1E293B;">Away Games</div><div style="font-size:0.75rem; color:#64748B;">Some teams travel off-campus for back-to-back games</div>';
        awayHeader.appendChild(awayTitle);
        awayCard.appendChild(awayHeader);

        if (league.offCampus.enabled) {
            const awayBody = document.createElement('div');
            awayBody.style.cssText = 'padding:14px;';

            // Inline sentence: "[X] teams go to [Zone \u25BC] each game day"
            const sentenceRow = document.createElement('div');
            sentenceRow.style.cssText = 'display:flex; align-items:center; flex-wrap:wrap; gap:6px; font-size:0.85rem; color:#374151; margin-bottom:14px;';

            const teamsInput = document.createElement('input');
            teamsInput.type = 'number'; teamsInput.min = '2'; teamsInput.max = String(totalTeams);
            teamsInput.step = '2'; teamsInput.value = league.offCampus.teamsPerDay || '';
            teamsInput.placeholder = '#';
            teamsInput.style.cssText = 'width:52px; padding:5px 8px; border:1px solid #D1D5DB; border-radius:6px; font-size:0.85rem; text-align:center; background:white;';
            teamsInput.onchange = function () {
                var val = parseInt(teamsInput.value) || 0;
                if (val % 2 !== 0 && val > 0) val = val + 1;
                if (val >= totalTeams) val = totalTeams - (totalTeams % 2 === 0 ? 2 : 1);
                teamsInput.value = val || '';
                league.offCampus.teamsPerDay = val; saveLeaguesData(); renderConfigSections(league, container);
            };

            const zoneSelect = document.createElement('select');
            zoneSelect.style.cssText = 'padding:5px 10px; border:1px solid #D1D5DB; border-radius:6px; font-size:0.85rem; background:white; max-width:180px;';
            zoneSelect.innerHTML = '<option value="">choose location...</option>';
            Object.keys(locationZones).forEach(function (zoneName) {
                const zone = locationZones[zoneName];
                if (zone.isDefault) return;
                const opt = document.createElement('option');
                opt.value = zoneName;
                opt.textContent = zoneName;
                if (league.offCampus.zone === zoneName) opt.selected = true;
                zoneSelect.appendChild(opt);
            });
            zoneSelect.onchange = function () { league.offCampus.zone = zoneSelect.value; saveLeaguesData(); renderConfigSections(league, container); };

            sentenceRow.appendChild(teamsInput);
            sentenceRow.appendChild(document.createTextNode(' teams travel to '));
            sentenceRow.appendChild(zoneSelect);
            sentenceRow.appendChild(document.createTextNode(' each game day'));
            awayBody.appendChild(sentenceRow);

            // Summary pill
            var numAway = league.offCampus.teamsPerDay || 0;
            var numHome = totalTeams - numAway;
            if (numAway > 0 && league.offCampus.zone) {
                var pill = document.createElement('div');
                pill.style.cssText = 'display:flex; gap:8px; margin-bottom:14px;';
                pill.innerHTML = '<div style="flex:1; background:#DBEAFE; border-radius:8px; padding:8px 10px; text-align:center; font-size:0.78rem; color:#1E40AF;"><strong>' + numAway + '</strong> away<br>' + Math.floor(numAway/2) + ' matchups</div>' +
                    '<div style="flex:1; background:#F0FDF4; border-radius:8px; padding:8px 10px; text-align:center; font-size:0.78rem; color:#166534;"><strong>' + numHome + '</strong> home<br>' + Math.floor(numHome/2) + ' matchups</div>';
                awayBody.appendChild(pill);
            }

            // Trip fairness chips
            var leagueHist = settings.leagueHistory || {};
            var ocCounts = leagueHist.offCampusCounts || {};
            var teamTrips = [], hasHist = false;
            (league.teams || []).forEach(function (team) {
                var c = ocCounts[league.name + '|' + team] || 0;
                teamTrips.push({ name: team, trips: c });
                if (c > 0) hasHist = true;
            });
            if (hasHist) {
                teamTrips.sort(function(a,b){ return a.trips - b.trips; });
                var tripsRow = document.createElement('div');
                tripsRow.style.cssText = 'display:flex; flex-wrap:wrap; gap:5px; margin-bottom:10px;';
                teamTrips.forEach(function(t) {
                    var chip = document.createElement('span');
                    var intensity = Math.min(t.trips * 15, 90);
                    chip.style.cssText = 'padding:3px 8px; border-radius:20px; font-size:0.72rem; font-weight:500; background:hsl(215,' + intensity + '%,95%); color:hsl(215,60%,35%); border:1px solid hsl(215,' + intensity + '%,85%);';
                    chip.textContent = t.name + ' ' + t.trips;
                    tripsRow.appendChild(chip);
                });
                var tripsLabel = document.createElement('div');
                tripsLabel.style.cssText = 'font-size:0.72rem; color:#94A3B8; margin-bottom:4px;';
                tripsLabel.textContent = 'Away trips per team (fewest goes next):';
                awayBody.appendChild(tripsLabel);
                awayBody.appendChild(tripsRow);
            }

            awayCard.appendChild(awayBody);
        }

        advancedBody.appendChild(awayCard);

        // ─── CARD: CHINUCH ──────────────────────────────────────────────────
        if (!league.chinuch) league.chinuch = { enabled: false, timesPerDay: null, teamsPerRound: null, perSessionCounts: null, bunkFacilities: {} };

        const chinuchCard = document.createElement('div');
        chinuchCard.style.cssText = 'border:1px solid #E2E8F0; border-radius:12px; overflow:hidden; margin-top:8px;';

        const chinuchHeader = document.createElement('label');
        chinuchHeader.style.cssText = 'display:flex; align-items:center; gap:10px; padding:12px 14px; cursor:pointer; background:' + (league.chinuch.enabled ? '#F0FDF4' : '#F9FAFB') + '; border-bottom:' + (league.chinuch.enabled ? '1px solid #BBF7D0' : 'none') + ';';
        const chinuchCb = document.createElement('input');
        chinuchCb.type = 'checkbox';
        chinuchCb.checked = league.chinuch.enabled === true;
        chinuchCb.style.cssText = 'width:16px; height:16px; accent-color:#16A34A;';
        chinuchCb.onchange = function () {
            league.chinuch.enabled = chinuchCb.checked;
            saveLeaguesData();
            renderConfigSections(league, container);
        };
        chinuchHeader.appendChild(chinuchCb);
        const chinuchTitle = document.createElement('div');
        chinuchTitle.innerHTML = '<div style="font-size:0.85rem; font-weight:600; color:#1E293B;">Chinuch</div><div style="font-size:0.75rem; color:#64748B;">Teams rotate through chinuch class during league time</div>';
        chinuchHeader.appendChild(chinuchTitle);
        chinuchCard.appendChild(chinuchHeader);

        if (league.chinuch.enabled) {
            const chinuchBody = document.createElement('div');
            chinuchBody.style.cssText = 'padding:14px;';

            // ── Auto-distribution info chip ─────────────────────────────────
            const customArr = Array.isArray(league.chinuch.perSessionCounts) ? league.chinuch.perSessionCounts.filter(function (n) { return Number.isFinite(n) && n >= 0; }) : [];
            const hasCustomArr = customArr.length > 0;
            const hasManualOverride = hasCustomArr || (league.chinuch.timesPerDay > 0) || (league.chinuch.teamsPerRound > 0);
            // Panel is collapsed by default; only opens when the user explicitly toggles it.
            const overrideOpen = _chinuchOverrideOpenLeagues.has(league.name);

            const autoInfo = document.createElement('div');
            autoInfo.style.cssText = 'font-size:0.78rem; color:#374151; background:' + (hasManualOverride ? '#FEF3C7' : '#F0F9FF') + '; border:1px solid ' + (hasManualOverride ? '#FCD34D' : '#BAE6FD') + '; border-radius:8px; padding:8px 10px; margin-bottom:10px;';
            const numTeams = (league.teams || []).length;
            if (hasCustomArr) {
                autoInfo.textContent = 'Manual override active: per-session counts [' + customArr.join(', ') + '].';
            } else if (hasManualOverride) {
                const tp = league.chinuch.timesPerDay ? (league.chinuch.timesPerDay + ' session' + (league.chinuch.timesPerDay === 1 ? '' : 's') + '/day') : 'auto sessions';
                const tr = league.chinuch.teamsPerRound ? (league.chinuch.teamsPerRound + ' team' + (league.chinuch.teamsPerRound === 1 ? '' : 's') + '/session') : 'auto teams';
                autoInfo.textContent = 'Manual override active: ' + tp + ', ' + tr + '.';
            } else {
                autoInfo.textContent = numTeams > 0
                    ? 'Distribution is calculated automatically: ' + numTeams + ' team' + (numTeams === 1 ? '' : 's') + ' spread evenly across league sessions each day.'
                    : 'Add teams above — distribution is calculated automatically based on team count and league sessions per day.';
            }
            chinuchBody.appendChild(autoInfo);

            // ── Manual override toggle (subtle link) ────────────────────────
            const overrideToggleWrap = document.createElement('div');
            overrideToggleWrap.style.cssText = 'margin-bottom:14px;';
            const overrideToggle = document.createElement('button');
            overrideToggle.type = 'button';
            overrideToggle.style.cssText = 'background:none; border:none; color:#2563EB; font-size:0.78rem; cursor:pointer; padding:0; text-decoration:underline;';
            overrideToggle.textContent = overrideOpen ? '▾ Hide manual override' : '▸ Manual override';
            overrideToggle.onclick = function () {
                if (_chinuchOverrideOpenLeagues.has(league.name)) {
                    _chinuchOverrideOpenLeagues.delete(league.name);
                } else {
                    _chinuchOverrideOpenLeagues.add(league.name);
                }
                renderConfigSections(league, container);
            };
            overrideToggleWrap.appendChild(overrideToggle);
            chinuchBody.appendChild(overrideToggleWrap);

            if (overrideOpen) {
                const overrideBox = document.createElement('div');
                overrideBox.style.cssText = 'border:1px dashed #D1D5DB; border-radius:8px; padding:12px; margin-bottom:14px; background:#FAFAFA;';

                // ── Row 1: "X league games per day" ─────────────────────────
                const gamesRow = document.createElement('div');
                gamesRow.style.cssText = 'display:flex; align-items:center; gap:8px; font-size:0.85rem; color:#374151; margin-bottom:10px;';

                const timesInput = document.createElement('input');
                timesInput.type = 'number'; timesInput.min = '1';
                timesInput.value = league.chinuch.timesPerDay || '';
                timesInput.placeholder = 'auto';
                timesInput.style.cssText = 'width:64px; padding:6px 8px; border:1px solid #D1D5DB; border-radius:6px; font-size:0.85rem; text-align:center; background:white;';
                timesInput.title = 'How many league periods get a chinuch session each day (blank = auto)';
                timesInput.onchange = function () {
                    const v = parseInt(timesInput.value);
                    league.chinuch.timesPerDay = (v > 0) ? v : null;
                    saveLeaguesData();
                    renderConfigSections(league, container);
                };
                gamesRow.appendChild(timesInput);
                gamesRow.appendChild(document.createTextNode(' league sessions per day'));
                overrideBox.appendChild(gamesRow);

                // ── Row 2: "Y teams per session" ────────────────────────────
                const perGameRow = document.createElement('div');
                perGameRow.style.cssText = 'display:flex; align-items:center; gap:8px; font-size:0.85rem; color:#374151; margin-bottom:10px;';

                const perRoundInput = document.createElement('input');
                perRoundInput.type = 'number'; perRoundInput.min = '1';
                perRoundInput.value = league.chinuch.teamsPerRound || '';
                perRoundInput.placeholder = 'auto';
                perRoundInput.style.cssText = 'width:64px; padding:6px 8px; border:1px solid #D1D5DB; border-radius:6px; font-size:0.85rem; text-align:center; background:white;';
                perRoundInput.title = 'How many teams attend chinuch simultaneously each session (blank = auto)';
                perRoundInput.onchange = function () {
                    const v = parseInt(perRoundInput.value);
                    league.chinuch.teamsPerRound = (v > 0) ? v : null;
                    saveLeaguesData();
                    renderConfigSections(league, container);
                };
                perGameRow.appendChild(perRoundInput);
                perGameRow.appendChild(document.createTextNode(' teams per session'));
                overrideBox.appendChild(perGameRow);

                // ── Divider ─────────────────────────────────────────────────
                const divider = document.createElement('div');
                divider.style.cssText = 'border-top:1px solid #E5E7EB; margin:10px 0;';
                overrideBox.appendChild(divider);

                // ── Per-session distribution (most specific override) ───────
                const perSessLabel = document.createElement('div');
                perSessLabel.style.cssText = 'font-size:0.78rem; font-weight:600; color:#374151; margin-bottom:4px;';
                perSessLabel.textContent = 'Or set exact counts per session';
                overrideBox.appendChild(perSessLabel);

                const perSessHint = document.createElement('div');
                perSessHint.style.cssText = 'font-size:0.72rem; color:#6B7280; margin-bottom:6px;';
                perSessHint.textContent = 'Comma-separated, one number per league session (e.g. 4, 2, 1, 0). Overrides the two fields above.';
                overrideBox.appendChild(perSessHint);

                const perSessInput = document.createElement('input');
                perSessInput.type = 'text';
                perSessInput.value = hasCustomArr ? customArr.join(', ') : '';
                perSessInput.placeholder = 'e.g. 4, 2, 1, 0';
                perSessInput.style.cssText = 'width:100%; max-width:240px; padding:6px 8px; border:1px solid #D1D5DB; border-radius:6px; font-size:0.85rem; background:white;';
                perSessInput.onchange = function () {
                    const raw = String(perSessInput.value || '').trim();
                    if (!raw) {
                        league.chinuch.perSessionCounts = null;
                    } else {
                        const parsed = raw.split(/[,\s]+/)
                            .map(function (s) { return parseInt(s, 10); })
                            .filter(function (n) { return Number.isFinite(n) && n >= 0; });
                        league.chinuch.perSessionCounts = parsed.length > 0 ? parsed : null;
                    }
                    saveLeaguesData();
                    renderConfigSections(league, container);
                };
                overrideBox.appendChild(perSessInput);

                // ── Reset to auto ───────────────────────────────────────────
                if (hasManualOverride) {
                    const resetBtn = document.createElement('button');
                    resetBtn.type = 'button';
                    resetBtn.style.cssText = 'display:block; margin-top:12px; padding:5px 10px; background:white; color:#374151; border:1px solid #D1D5DB; border-radius:6px; font-size:0.78rem; cursor:pointer;';
                    resetBtn.textContent = 'Reset to auto';
                    resetBtn.onclick = function () {
                        league.chinuch.timesPerDay = null;
                        league.chinuch.teamsPerRound = null;
                        league.chinuch.perSessionCounts = null;
                        saveLeaguesData();
                        renderConfigSections(league, container);
                    };
                    overrideBox.appendChild(resetBtn);
                }

                chinuchBody.appendChild(overrideBox);
            }

            // ── Per-team facility (dropdown from Facilities tab) ────────────
            const facilityHeader = document.createElement('div');
            facilityHeader.style.cssText = 'font-size:0.78rem; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; color:#6B7280; margin-bottom:8px;';
            facilityHeader.textContent = 'Chinuch Location per Team';
            chinuchBody.appendChild(facilityHeader);

            const allFacilities = (typeof window.getFacilities === 'function') ? window.getFacilities() : [];

            if (allFacilities.length === 0) {
                const noFac = document.createElement('div');
                noFac.style.cssText = 'font-size:0.8rem; color:#F59E0B; background:#FFFBEB; border:1px solid #FDE68A; border-radius:8px; padding:8px 10px; margin-bottom:8px;';
                noFac.textContent = 'No facilities found — add rooms in the Facilities tab first, then come back here.';
                chinuchBody.appendChild(noFac);
            }

            (league.teams || []).forEach(function (team) {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex; align-items:center; gap:10px; margin-bottom:8px;';

                const label = document.createElement('span');
                label.style.cssText = 'font-size:0.83rem; font-weight:500; color:#374151; min-width:110px; flex:1;';
                label.textContent = team;

                const facSelect = document.createElement('select');
                facSelect.style.cssText = 'flex:2; padding:5px 8px; border:1px solid #D1D5DB; border-radius:6px; font-size:0.83rem; background:white; max-width:220px;';

                const blankOpt = document.createElement('option');
                blankOpt.value = '';
                blankOpt.textContent = '— choose facility —';
                facSelect.appendChild(blankOpt);

                const currentVal = (league.chinuch.bunkFacilities && league.chinuch.bunkFacilities[team]) || '';
                allFacilities.forEach(function (fac) {
                    const opt = document.createElement('option');
                    opt.value = fac.name;
                    opt.textContent = fac.name;
                    if (fac.name === currentVal) opt.selected = true;
                    facSelect.appendChild(opt);
                });

                facSelect.onchange = function () {
                    if (!league.chinuch.bunkFacilities) league.chinuch.bunkFacilities = {};
                    league.chinuch.bunkFacilities[team] = facSelect.value;
                    saveLeaguesData();
                };

                row.appendChild(label);
                row.appendChild(facSelect);
                chinuchBody.appendChild(row);
            });

            if ((league.teams || []).length === 0) {
                const empty = document.createElement('div');
                empty.style.cssText = 'font-size:0.8rem; color:#9CA3AF; text-align:center; padding:8px;';
                empty.textContent = 'Add teams above to assign chinuch facilities.';
                chinuchBody.appendChild(empty);
            }

            chinuchCard.appendChild(chinuchBody);
        }

        advancedBody.appendChild(chinuchCard);

        // ─── CARD: INDOOR REQUIREMENT ───────────────────────────────────────
        if (!league.indoorRequirement) league.indoorRequirement = { enabled: false, op: '>=', count: 1 };

        const indoorCard = document.createElement('div');
        indoorCard.style.cssText = 'border:1px solid #E2E8F0; border-radius:12px; overflow:hidden; margin-top:8px;';

        const indoorHeader = document.createElement('label');
        indoorHeader.style.cssText = 'display:flex; align-items:center; gap:10px; padding:12px 14px; cursor:pointer; background:' + (league.indoorRequirement.enabled ? '#F0FDF4' : '#F9FAFB') + '; border-bottom:' + (league.indoorRequirement.enabled ? '1px solid #BBF7D0' : 'none') + ';';
        const indoorCb = document.createElement('input');
        indoorCb.type = 'checkbox';
        indoorCb.checked = league.indoorRequirement.enabled === true;
        indoorCb.style.cssText = 'width:16px; height:16px; accent-color:#16A34A;';
        indoorCb.onchange = function () {
            league.indoorRequirement.enabled = indoorCb.checked;
            saveLeaguesData();
            renderConfigSections(league, container);
        };
        indoorHeader.appendChild(indoorCb);
        const indoorTitle = document.createElement('div');
        indoorTitle.innerHTML = '<div style="font-size:0.85rem; font-weight:600; color:#1E293B;">Indoor Court Requirement</div><div style="font-size:0.75rem; color:#64748B;">Steer each team toward a target number of indoor games per day</div>';
        indoorHeader.appendChild(indoorTitle);
        indoorCard.appendChild(indoorHeader);

        if (league.indoorRequirement.enabled) {
            const indoorBody = document.createElement('div');
            indoorBody.style.cssText = 'padding:14px;';

            const ruleRow = document.createElement('div');
            ruleRow.style.cssText = 'display:flex; align-items:center; gap:8px; font-size:0.88rem; color:#374151; flex-wrap:wrap;';

            ruleRow.appendChild(document.createTextNode('Each team plays'));

            const opSelect = document.createElement('select');
            opSelect.style.cssText = 'padding:6px 8px; border:1px solid #D1D5DB; border-radius:6px; font-size:0.88rem; background:white;';
            [
                { v: '>=', label: '≥ (at least)' },
                { v: '=',  label: '= (exactly)' },
                { v: '<=', label: '≤ (at most)' }
            ].forEach(function (o) {
                const opt = document.createElement('option');
                opt.value = o.v;
                opt.textContent = o.label;
                if (league.indoorRequirement.op === o.v) opt.selected = true;
                opSelect.appendChild(opt);
            });
            opSelect.onchange = function () {
                league.indoorRequirement.op = opSelect.value;
                saveLeaguesData();
            };
            ruleRow.appendChild(opSelect);

            const countInput = document.createElement('input');
            countInput.type = 'number'; countInput.min = '0';
            countInput.value = league.indoorRequirement.count;
            countInput.style.cssText = 'width:64px; padding:6px 8px; border:1px solid #D1D5DB; border-radius:6px; font-size:0.88rem; text-align:center; background:white;';
            countInput.onchange = function () {
                const v = parseInt(countInput.value, 10);
                league.indoorRequirement.count = (Number.isFinite(v) && v >= 0) ? v : 1;
                saveLeaguesData();
            };
            ruleRow.appendChild(countInput);

            ruleRow.appendChild(document.createTextNode('indoor game(s) per day'));

            indoorBody.appendChild(ruleRow);

            const hint = document.createElement('div');
            hint.style.cssText = 'font-size:0.72rem; color:#6B7280; margin-top:10px; line-height:1.4;';
            hint.textContent = 'Indoor courts come from facilities marked Indoor in the Facilities tab. The solver biases assignments to meet the rule and runs a post-pass that swaps outdoor matchups for free indoor ones when teams are short.';
            indoorBody.appendChild(hint);

            indoorCard.appendChild(indoorBody);
        }

        advancedBody.appendChild(indoorCard);
    }

    // =========================================================================
   // GAME RESULTS VIEW
    // =========================================================================
    function renderGameResultsUI(league, container) {        
        if (!container) return;

        container.innerHTML = '';

        const tabNav = document.createElement('div');
        tabNav.className = 'league-tab-nav';
        tabNav.innerHTML =
            '<button id="tab-standings" class="league-tab-btn active">Current Standings</button>' +
            '<button id="tab-games" class="league-tab-btn">Game Results / History</button>';
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
            activeBtn.className = 'league-tab-btn active';
            inactiveBtn.className = 'league-tab-btn';
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
    // STANDINGS TABLE - Editable with tiebreakers
    // =========================================================================
    function renderStandingsTable(league, container) {
        if (!container) return;

        container.innerHTML = '';
        if (!league.teams || league.teams.length === 0) {
            container.innerHTML = '<p class="league-empty-state">No teams in this league.</p>';
            return;
        }

        recalcStandings(league);
        const sorted = sortTeamsByStandings(league);

        // Instructions
        const instructions = document.createElement('div');
        instructions.className = 'league-standings-instructions';
        instructions.textContent = 'Click on W/L/T values to edit manually. Tiebreakers: head-to-head, then point differential.';
        container.appendChild(instructions);

        // Table
        const table = document.createElement('table');
        table.className = 'league-standings-table';

        // Header
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        
        const headers = ['#', 'Team', 'W', 'L', 'T', '+/-'];
        const headerWidths = ['40px', '', '50px', '50px', '50px', '60px'];
        const headerAligns = ['center', 'left', 'center', 'center', 'center', 'center'];
        
        headers.forEach((text, i) => {
            const th = document.createElement('th');
            th.className = headerAligns[i] === 'center' ? 'text-center' : 'text-left';
            if (headerWidths[i]) th.style.width = headerWidths[i];
            th.textContent = text;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        // Body
        const tbody = document.createElement('tbody');
        sorted.forEach((team, idx) => {
            const stats = league.standings[team] || { w: 0, l: 0, t: 0, diff: 0 };
            const isManual = stats._manual;
            const borderBottom = idx < sorted.length - 1 ? '1px solid #F3F4F6' : 'none';

            const row = document.createElement('tr');

            // Rank
            const rankCell = document.createElement('td');
            rankCell.className = 'league-rank-cell';
            rankCell.textContent = idx + 1;
            row.appendChild(rankCell);

            // Team name
            const teamCell = document.createElement('td');
            teamCell.className = 'league-team-cell';
            
            const teamName = document.createElement('span');
            teamName.textContent = team;
            teamCell.appendChild(teamName);
            
            // Manual indicator
            if (isManual) {
                const manualBadge = document.createElement('span');
                manualBadge.className = 'league-manual-badge';
                manualBadge.textContent = 'MANUAL';
                teamCell.appendChild(manualBadge);
            }
            row.appendChild(teamCell);

            // Editable W/L/T cells
            const statClasses = ['wins', 'losses', 'ties'];
            ['w', 'l', 't'].forEach((stat, sIdx) => {
                const cell = document.createElement('td');
                cell.className = 'league-stat-cell ' + statClasses[sIdx];
                
                const valueSpan = document.createElement('span');
                valueSpan.textContent = stats[stat] || 0;
                valueSpan.className = 'league-stat-editable';
                valueSpan.title = 'Click to edit';
                
                valueSpan.onclick = () => {
                    // Create input for editing
                    const input = document.createElement('input');
                    input.type = 'number';
                    input.min = '0';
                    input.value = stats[stat] || 0;
                    input.className = 'league-stat-input';
                    
                    const finishEdit = () => {
                        const newVal = parseInt(input.value, 10) || 0;
                        stats[stat] = newVal;
                        stats._manual = true;  // Mark as manually edited
                        saveLeaguesData();
                        renderStandingsTable(league, container);
                    };
                    
                    input.onblur = finishEdit;
                    input.onkeydown = (e) => {
                        if (e.key === 'Enter') finishEdit();
                        if (e.key === 'Escape') renderStandingsTable(league, container);
                    };
                    
                    cell.innerHTML = '';
                    cell.appendChild(input);
                    input.focus();
                    input.select();
                };
                
                cell.appendChild(valueSpan);
                row.appendChild(cell);
            });

            // Point differential
            const diffCell = document.createElement('td');
            const diff = stats.diff || 0;
            const diffClass = diff > 0 ? 'positive' : (diff < 0 ? 'negative' : 'neutral');
            diffCell.className = 'league-diff-cell ' + diffClass;
            diffCell.textContent = (diff > 0 ? '+' : '') + diff;
            row.appendChild(diffCell);

            tbody.appendChild(row);
        });
        table.appendChild(tbody);
        container.appendChild(table);

        // Reset manual edits button
        const hasManualEdits = league.teams.some(t => league.standings[t]?._manual);
        if (hasManualEdits) {
            const resetBtn = document.createElement('button');
            resetBtn.textContent = 'Reset to calculated values';
            resetBtn.style.cssText = 'margin-top:12px; padding:8px 12px; border:1px solid #E5E7EB; border-radius:6px; background:#fff; cursor:pointer; color:#6B7280; font-size:0.8rem; transition: all 0.15s;';
            resetBtn.onmouseover = () => { resetBtn.style.borderColor = '#111827'; resetBtn.style.color = '#111827'; };
            resetBtn.onmouseout = () => { resetBtn.style.borderColor = '#E5E7EB'; resetBtn.style.color = '#6B7280'; };
            resetBtn.onclick = () => {
                if (confirm('Reset all standings to calculated values from game results?')) {
                    league.teams.forEach(t => {
                        if (league.standings[t]) {
                            delete league.standings[t]._manual;
                        }
                    });
                    recalcStandings(league);
                    saveLeaguesData();
                    renderStandingsTable(league, container);
                }
            };
            container.appendChild(resetBtn);
        }
        
        // Tiebreaker explanation (if there are ties)
        const tiebreakInfo = findTiebreakers(league, sorted);
        if (tiebreakInfo.length > 0) {
            const tieSection = document.createElement('div');
            tieSection.style.cssText = 'margin-top:16px; padding:12px; background:#F9FAFB; border-radius:6px; font-size:0.8rem; color:#6B7280;';
            
            const tieTitle = document.createElement('div');
            tieTitle.style.cssText = 'font-weight:600; margin-bottom:6px; color:#374151;';
            tieTitle.textContent = 'Tiebreaker Notes';
            tieSection.appendChild(tieTitle);
            
            tiebreakInfo.forEach(info => {
                const line = document.createElement('div');
                line.style.marginBottom = '2px';
                line.textContent = info;
                tieSection.appendChild(line);
            });
            
            container.appendChild(tieSection);
        }
    }
    
    /**
     * Find tiebreaker explanations for teams with same record
     */
    function findTiebreakers(league, sortedTeams) {
        const notes = [];
        
        for (let i = 0; i < sortedTeams.length - 1; i++) {
            const teamA = sortedTeams[i];
            const teamB = sortedTeams[i + 1];
            const sA = league.standings[teamA] || { w: 0, l: 0, t: 0, diff: 0 };
            const sB = league.standings[teamB] || { w: 0, l: 0, t: 0, diff: 0 };
            
            // Check if same W-L-T record
            if (sA.w === sB.w && sA.l === sB.l && sA.t === sB.t) {
                const h2h = getHeadToHeadResult(league, teamA, teamB);
                if (h2h !== 0) {
                    const winner = h2h > 0 ? teamA : teamB;
                    notes.push(teamA + ' vs ' + teamB + ': ' + winner + ' wins head-to-head tiebreaker');
                } else if (sA.diff !== sB.diff) {
                    notes.push(teamA + ' vs ' + teamB + ': Tied H2H, ' + teamA + ' has better point differential (' + (sA.diff > 0 ? '+' : '') + sA.diff + ' vs ' + (sB.diff > 0 ? '+' : '') + sB.diff + ')');
                }
            }
        }
        
        return notes;
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
        header.className = 'league-games-header';
        
        const headerTitle = document.createElement('div');
        headerTitle.className = 'league-games-title';
        headerTitle.textContent = 'Game Results';
        header.appendChild(headerTitle);
        
        const importBtn = document.createElement('button');
        importBtn.textContent = 'Import from Schedule';
        importBtn.className = 'league-btn-import';
        importBtn.onclick = () => importGamesFromSchedule(league);
        header.appendChild(importBtn);
        container.appendChild(header);

        // Get and group games by date
        const games = league.games || [];
        const currentDate = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        
        const todaysGames = [];
        const pastGames = [];
        
        games.forEach((g) => {
            if (g.date === currentDate) {
                todaysGames.push(g);
            } else {
                pastGames.push(g);
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
            pastHeader.className = 'league-past-header';
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
        addNewBtn.className = 'league-btn-add-game';
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
        card.className = 'league-game-card';
        
        // Card Header
        const cardHeader = document.createElement('div');
        cardHeader.className = 'league-card-header';
        
        const gameTitle = document.createElement('div');
        gameTitle.className = 'league-card-title';
        gameTitle.textContent = game.gameLabel || ('Game ' + (league.games.indexOf(game) + 1));
        
        const headerRight = document.createElement('div');
        headerRight.style.cssText = 'display:flex; align-items:center; gap:12px;';
        
        const gameDate = document.createElement('span');
        gameDate.className = 'league-card-date';
        gameDate.textContent = formatDateDisplay(game.date);
        
        const deleteBtn = document.createElement('button');
        deleteBtn.textContent = 'Delete';
        deleteBtn.style.cssText = 'background:none; border:none; cursor:pointer; font-size:0.75rem; color:#9CA3AF; padding:4px 8px; transition: color 0.15s;';
        deleteBtn.onmouseover = () => deleteBtn.style.color = '#DC2626';
        deleteBtn.onmouseout = () => deleteBtn.style.color = '#9CA3AF';
        deleteBtn.onclick = (e) => {
            e.stopPropagation();
            if (confirm('Delete this game? This action cannot be undone.')) {
                const idx = league.games.indexOf(game);
                if (idx >= 0) league.games.splice(idx, 1);
                recalcStandings(league);
                saveLeaguesData();
                const gamesContainer = card.closest('[data-section="games"]') || card.parentElement;
                renderGameEntryUI(league, gamesContainer);
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
            footer.className = 'league-card-footer';
            
            const addMatchBtn = document.createElement('button');
            addMatchBtn.textContent = '+ Add Match';
            addMatchBtn.className = 'league-add-match-btn';
            addMatchBtn.onclick = () => {
                if (!game.matches) game.matches = [];
                game.matches.push({ teamA: '', teamB: '', scoreA: null, scoreB: null });
                saveLeaguesData();
                const gamesContainer = card.closest('[data-section="games"]') || card.parentElement;
                renderGameEntryUI(league, gamesContainer);
            };
            
            const saveStatus = document.createElement('span');
            saveStatus.id = 'save-status-' + league.games.indexOf(game);
            saveStatus.className = 'league-save-status';
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
        row.className = 'league-match-row';
        
        // Determine winner for styling
        const hasScores = match.scoreA != null && match.scoreB != null;
        const aWins = hasScores && match.scoreA > match.scoreB;
        const bWins = hasScores && match.scoreB > match.scoreA;
        const isTie = hasScores && match.scoreA === match.scoreB;
        
        // Team A
        const teamADiv = document.createElement('div');
        teamADiv.className = 'league-match-team team-a';
        
        const teamAName = document.createElement('span');
        teamAName.className = 'league-match-team' + (aWins ? ' winner' : '');
        teamAName.textContent = match.teamA || '—';
        teamADiv.appendChild(teamAName);
        
        // Scores container
        const scoresDiv = document.createElement('div');
        scoresDiv.className = 'league-scores-container';
        
        const scoreAInput = document.createElement('input');
        scoreAInput.type = 'number';
        scoreAInput.min = '0';
        scoreAInput.value = match.scoreA != null ? match.scoreA : '';
        scoreAInput.placeholder = '–';
        scoreAInput.className = 'league-score-input' + (aWins ? ' winner-bg' : (isTie ? ' tie-bg' : ''));
        if (isPast) { scoreAInput.disabled = true; }
        
        const separator = document.createElement('span');
        separator.className = 'league-score-separator';
        separator.textContent = '–';
        
        const scoreBInput = document.createElement('input');
        scoreBInput.type = 'number';
        scoreBInput.min = '0';
        scoreBInput.value = match.scoreB != null ? match.scoreB : '';
        scoreBInput.placeholder = '–';
        scoreBInput.className = 'league-score-input' + (bWins ? ' winner-bg' : (isTie ? ' tie-bg' : ''));
        if (isPast) { scoreBInput.disabled = true; }
        
        scoresDiv.appendChild(scoreAInput);
        scoresDiv.appendChild(separator);
        scoresDiv.appendChild(scoreBInput);
        
        // Team B
        const teamBDiv = document.createElement('div');
        teamBDiv.className = 'league-match-team team-b';
        
        const teamBName = document.createElement('span');
        teamBName.className = 'league-match-team' + (bWins ? ' winner' : '');
        teamBName.textContent = match.teamB || '—';
        teamBDiv.appendChild(teamBName);
        
        // Delete button
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'league-match-actions';
        
        if (!isPast) {
            const deleteBtn = document.createElement('button');
            deleteBtn.textContent = '×';
            deleteBtn.className = 'league-match-delete';
            deleteBtn.onclick = () => {
                game.matches.splice(matchIdx, 1);
                recalcStandings(league);
                saveLeaguesData();
                const gamesContainer = row.closest('[data-section="games"]');
                if (gamesContainer) renderGameEntryUI(league, gamesContainer);
            };
            actionsDiv.appendChild(deleteBtn);
        }
        
        // Auto-save handler
        const handleScoreChange = () => {
            match.scoreA = scoreAInput.value !== '' ? parseInt(scoreAInput.value, 10) : null;
            match.scoreB = scoreBInput.value !== '' ? parseInt(scoreBInput.value, 10) : null;

            recalcStandings(league);
            saveLeaguesData();

            // Update styling
            const newHasScores = match.scoreA != null && match.scoreB != null;
            const newAWins = newHasScores && match.scoreA > match.scoreB;
            const newBWins = newHasScores && match.scoreB > match.scoreA;
            const newIsTie = newHasScores && match.scoreA === match.scoreB;

            teamAName.className = 'league-match-team' + (newAWins ? ' winner' : '');
            teamBName.className = 'league-match-team' + (newBWins ? ' winner' : '');

            scoreAInput.className = 'league-score-input' + (newAWins ? ' winner-bg' : (newIsTie ? ' tie-bg' : ''));
            scoreBInput.className = 'league-score-input' + (newBWins ? ' winner-bg' : (newIsTie ? ' tie-bg' : ''));

            // Show save indicator
            const saveStatus = document.getElementById('save-status-' + league.games.indexOf(game));
            if (saveStatus) {
                saveStatus.classList.add('visible');
                setTimeout(() => saveStatus.classList.remove('visible'), 1500);
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
                    // Merge: add new matchups but preserve existing scores
                    const existing = league.games[existingIdx];
                    newGame.matches.forEach(nm => {
                        const found = (existing.matches || []).find(em =>
                            em.teamA === nm.teamA && em.teamB === nm.teamB
                        );
                        if (!found) {
                            if (!existing.matches) existing.matches = [];
                            existing.matches.push(nm);
                        }
                    });
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
    // RECALC STANDINGS - Score-based with point differential & head-to-head
    // =========================================================================
    
    /**
     * Recalculate standings from game results
     * Tracks: W, L, T, point differential, head-to-head records
     */
    function recalcStandings(league) {
        if (!league || !league.teams) return;
        if (!league.standings) league.standings = {};

        // Initialize standings for all teams
        league.teams.forEach(function (t) {
            if (!league.standings[t]) {
                league.standings[t] = { w: 0, l: 0, t: 0, pf: 0, pa: 0, diff: 0 };
            } else {
                // Reset calculated fields (preserve manual overrides flag)
                const manual = league.standings[t]._manual;
                if (!manual) {
                    league.standings[t].w = 0;
                    league.standings[t].l = 0;
                    league.standings[t].t = 0;
                }
                league.standings[t].pf = 0;  // Points for
                league.standings[t].pa = 0;  // Points against
                league.standings[t].diff = 0;
            }
        });

        // Initialize head-to-head tracking
        // Structure: league._h2h[teamA][teamB] = { wins: X, losses: Y }
        if (!league._h2h) league._h2h = {};
        league.teams.forEach(t => {
            league._h2h[t] = {};
            league.teams.forEach(opp => {
                if (t !== opp) league._h2h[t][opp] = { wins: 0, losses: 0, pf: 0, pa: 0 };
            });
        });

        // Calculate from games
        (league.games || []).forEach(function (g) {
            (g.matches || []).forEach(function (m) {
                if (!m.teamA || !m.teamB) return;
                if (!league.standings[m.teamA] || !league.standings[m.teamB]) return;
                
                const hasScoreA = m.scoreA != null && m.scoreA !== '';
                const hasScoreB = m.scoreB != null && m.scoreB !== '';
                
                if (hasScoreA && hasScoreB) {
                    const scoreA = parseInt(m.scoreA, 10) || 0;
                    const scoreB = parseInt(m.scoreB, 10) || 0;
                    
                    // Update point differential
                    league.standings[m.teamA].pf += scoreA;
                    league.standings[m.teamA].pa += scoreB;
                    league.standings[m.teamB].pf += scoreB;
                    league.standings[m.teamB].pa += scoreA;
                    
                    // Update head-to-head
                    if (league._h2h[m.teamA] && league._h2h[m.teamA][m.teamB]) {
                        league._h2h[m.teamA][m.teamB].pf += scoreA;
                        league._h2h[m.teamA][m.teamB].pa += scoreB;
                    }
                    if (league._h2h[m.teamB] && league._h2h[m.teamB][m.teamA]) {
                        league._h2h[m.teamB][m.teamA].pf += scoreB;
                        league._h2h[m.teamB][m.teamA].pa += scoreA;
                    }
                    
                    // Skip W/L/T if manual override is set
                    const manualA = league.standings[m.teamA]._manual;
                    const manualB = league.standings[m.teamB]._manual;
                    
                    if (scoreA > scoreB) {
                        if (!manualA) league.standings[m.teamA].w++;
                        if (!manualB) league.standings[m.teamB].l++;
                        if (league._h2h[m.teamA]?.[m.teamB]) league._h2h[m.teamA][m.teamB].wins++;
                        if (league._h2h[m.teamB]?.[m.teamA]) league._h2h[m.teamB][m.teamA].losses++;
                    } else if (scoreB > scoreA) {
                        if (!manualB) league.standings[m.teamB].w++;
                        if (!manualA) league.standings[m.teamA].l++;
                        if (league._h2h[m.teamB]?.[m.teamA]) league._h2h[m.teamB][m.teamA].wins++;
                        if (league._h2h[m.teamA]?.[m.teamB]) league._h2h[m.teamA][m.teamB].losses++;
                    } else {
                        if (!manualA) league.standings[m.teamA].t++;
                        if (!manualB) league.standings[m.teamB].t++;
                    }
                } else if (m.winner) {
                    // Legacy support
                    const manualA = league.standings[m.teamA]._manual;
                    const manualB = league.standings[m.teamB]._manual;
                    
                    if (m.winner === 'tie') {
                        if (!manualA) league.standings[m.teamA].t++;
                        if (!manualB) league.standings[m.teamB].t++;
                    } else if (m.winner === m.teamA) {
                        if (!manualA) league.standings[m.teamA].w++;
                        if (!manualB) league.standings[m.teamB].l++;
                    } else if (m.winner === m.teamB) {
                        if (!manualB) league.standings[m.teamB].w++;
                        if (!manualA) league.standings[m.teamA].l++;
                    }
                }
            });
        });
        
        // Calculate final point differential
        league.teams.forEach(t => {
            const s = league.standings[t];
            s.diff = (s.pf || 0) - (s.pa || 0);
        });
    }
    
    /**
     * Get head-to-head record between two teams
     * Returns: 1 if teamA wins H2H, -1 if teamB wins, 0 if tied
     */
    function getHeadToHeadResult(league, teamA, teamB) {
        if (!league._h2h || !league._h2h[teamA] || !league._h2h[teamA][teamB]) return 0;
        
        const h2h = league._h2h[teamA][teamB];
        if (h2h.wins > h2h.losses) return 1;   // teamA wins H2H
        if (h2h.losses > h2h.wins) return -1;  // teamB wins H2H
        return 0;  // H2H tied
    }
    
    /**
     * Sort teams with tiebreakers:
     * 1. Win percentage (W / (W+L+T))
     * 2. Head-to-head record
     * 3. Point differential
     */
    function sortTeamsByStandings(league) {
        return league.teams.slice().sort((a, b) => {
            const sA = league.standings[a] || { w: 0, l: 0, t: 0, diff: 0 };
            const sB = league.standings[b] || { w: 0, l: 0, t: 0, diff: 0 };
            
            // Primary: More wins
            if (sB.w !== sA.w) return sB.w - sA.w;
            
            // Secondary: Fewer losses
            if (sA.l !== sB.l) return sA.l - sB.l;
            
            // Tertiary: Head-to-head
            const h2h = getHeadToHeadResult(league, a, b);
            if (h2h !== 0) return -h2h;  // Negative because we want winner higher
            
            // Quaternary: Point differential
            const diffA = sA.diff || 0;
            const diffB = sB.diff || 0;
            if (diffB !== diffA) return diffB - diffA;
            
            // Final: Alphabetical
            return a.localeCompare(b);
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

    // =========================================================================
    // ★ FN-58: AUTO-SAVED GAME RESULTS — public API for the league engine
    // =========================================================================
    // The scheduler engine calls syncGamesFromGeneration after every
    // generation that covers a league's day, so games appear in Game Results
    // automatically (no "Import from Schedule" click). A regeneration calls
    // it again with the day's NEW games: the date's auto-saved games are
    // replaced, but scores already entered for matchups that still exist are
    // preserved. Date deletion calls removeAutoGamesForDate. Games the user
    // added manually via "+ Add Game" (no importedFrom flag) are never touched.

    function _pairKeyFor(a, b) { return [a, b].sort().join('|'); }
    function _isAutoGame(g) { return g && (g.importedFrom === 'auto' || g.importedFrom === 'schedule'); }

    function _refreshGamesUIIfShowing(leagueName) {
        try {
            if (!detailPaneEl) return;
            if (leagueName && selectedLeagueName !== leagueName) return;
            const lg = leaguesByName[selectedLeagueName];
            const c = detailPaneEl.querySelector('[data-section="games"]');
            if (lg && c && c.offsetParent) renderGameEntryUI(lg, c);
        } catch (e) { /* display refresh is best-effort */ }
    }

    window.LeaguesAPI = window.LeaguesAPI || {};

    window.LeaguesAPI.syncGamesFromGeneration = function (leagueName, dateKey, gameEntries) {
        try {
            const league = leaguesByName[leagueName];
            if (!league || !dateKey) return false;
            if (!Array.isArray(league.games)) league.games = [];

            // Collect entered scores from the date's outgoing auto games so a
            // regen that keeps a matchup keeps its result. Primary identity:
            // gameLabel + pair; fallback to pair-only when the pair appears
            // exactly once on the date (labels can shift on renumbering).
            const oldByLabelPair = {};
            const oldByPair = {};
            const oldPairCount = {};
            league.games.forEach(function (g) {
                if (g.date !== dateKey || !_isAutoGame(g)) return;
                (g.matches || []).forEach(function (m) {
                    if (m.scoreA == null && m.scoreB == null) return;
                    const pk = _pairKeyFor(m.teamA, m.teamB);
                    oldByLabelPair[(g.gameLabel || '') + '|' + pk] = m;
                    oldByPair[pk] = m;
                    oldPairCount[pk] = (oldPairCount[pk] || 0) + 1;
                });
            });

            // Replace the date's auto games (manual games untouched)
            league.games = league.games.filter(function (g) { return !(g.date === dateKey && _isAutoGame(g)); });

            const newPairCount = {};
            (gameEntries || []).forEach(function (ge) {
                (ge && ge.matches || []).forEach(function (m) {
                    const pk = _pairKeyFor(m.teamA, m.teamB);
                    newPairCount[pk] = (newPairCount[pk] || 0) + 1;
                });
            });

            let totalMatches = 0;
            (gameEntries || []).forEach(function (ge) {
                if (!ge || !Array.isArray(ge.matches) || ge.matches.length === 0) return;
                const numMatch = String(ge.gameLabel || '').match(/Game\s*(\d+)/i);
                league.games.push({
                    date: dateKey,
                    gameLabel: ge.gameLabel || 'Game',
                    gameNumber: ge.gameNumber != null ? ge.gameNumber : (numMatch ? parseInt(numMatch[1], 10) : null),
                    matches: ge.matches.map(function (m) {
                        const pk = _pairKeyFor(m.teamA, m.teamB);
                        let old = oldByLabelPair[(ge.gameLabel || '') + '|' + pk];
                        if (!old && oldPairCount[pk] === 1 && newPairCount[pk] === 1) old = oldByPair[pk];
                        const aligned = old && old.teamA === m.teamA;
                        return {
                            teamA: m.teamA,
                            teamB: m.teamB,
                            scoreA: old ? (aligned ? old.scoreA : old.scoreB) : null,
                            scoreB: old ? (aligned ? old.scoreB : old.scoreA) : null,
                            sport: m.sport || null
                        };
                    }),
                    importedFrom: 'auto',
                    importedAt: new Date().toISOString()
                });
                totalMatches += ge.matches.length;
            });

            league.games.sort(function (a, b) {
                return (a.date || '').localeCompare(b.date || '') || (a.gameNumber || 0) - (b.gameNumber || 0);
            });

            recalcStandings(league);
            saveLeaguesData();
            _refreshGamesUIIfShowing(leagueName);
            console.log('[LEAGUES] 🔄 Auto-saved ' + (gameEntries || []).length + ' game(s) / ' + totalMatches + ' match(es) for "' + leagueName + '" on ' + dateKey);
            return true;
        } catch (e) {
            console.error('[LEAGUES] syncGamesFromGeneration failed:', e);
            return false;
        }
    };

    window.LeaguesAPI.removeAutoGamesForDate = function (dateKey, leagueNames) {
        try {
            if (!dateKey) return;
            const names = (Array.isArray(leagueNames) && leagueNames.length > 0) ? leagueNames : Object.keys(leaguesByName);
            let changed = false;
            names.forEach(function (n) {
                const lg = leaguesByName[n];
                if (!lg || !Array.isArray(lg.games)) return;
                const before = lg.games.length;
                lg.games = lg.games.filter(function (g) { return !(g.date === dateKey && _isAutoGame(g)); });
                if (lg.games.length !== before) {
                    changed = true;
                    recalcStandings(lg);
                }
            });
            if (changed) {
                saveLeaguesData();
                _refreshGamesUIIfShowing(null);
                console.log('[LEAGUES] 🗑️ Removed auto-saved games for ' + dateKey);
            }
        } catch (e) {
            console.error('[LEAGUES] removeAutoGamesForDate failed:', e);
        }
    };

    // Auto-load on script run
    window.loadLeagueGlobals();

    console.log("[LEAGUES] v2.5 ready");
})();
