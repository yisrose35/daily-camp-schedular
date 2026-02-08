// ============================================================================
// specialty_leagues.js — PRODUCTION-READY v2.2.6 (EMERALD CAMP THEME)
// ============================================================================
// v2.2.6 SCORE PERSISTENCE FIXES:
// - ★ EXTENDED PROTECTION: 5-second window prevents tab-switch data loss
// - ★ IMMEDIATE SAVE: Scores save on blur AND every 100ms while typing
// - ★ STANDINGS REFRESH: Standings tab refreshes with latest data when opened
//
// v2.2.5 ADVANCED STANDINGS & TIEBREAKERS:
// - ★ AUTO-SORT: Standings automatically re-sort after manual W/L/T changes
// - ★ TIEBREAKER 1: Head-to-head record between tied teams
// - ★ TIEBREAKER 2: Head-to-head point differential
// - ★ TIEBREAKER 3: Overall season point differential
// - ★ +/- COLUMN: Shows each team's point differential
//
// v2.2.4 MANUAL STANDINGS EDITING:
// - ★ EDITABLE W/L/T: Click directly on standings values to edit
// - ★ AUTO-SAVE: Changes save immediately with cloud sync
// - ★ RECALCULATE BUTTON: Reset standings from game results anytime
// - ★ AUTO-SORT: Table re-sorts after manual changes
//
// v2.2.3 CLOUD SYNC FIXES:
// - ★ STANDINGS SYNC: Force immediate cloud sync when standings change
// - ★ DEEP CLONE: Uses JSON.parse(JSON.stringify()) to capture all nested data
// - ★ DEBUG LOGGING: Shows standings being saved for verification
//
// v2.2.2 DATA PROTECTION FIXES:
// - ★ DEFENSIVE LOADING: Won't wipe existing data if loadGlobalSettings returns empty
// - ★ SAFE REFRESH: Checks source before clearing existing leagues
// - ★ SAFE INIT: Preserves data if cloud hasn't hydrated yet
//
// v2.2.1 BACKWARD COMPATIBILITY FIXES:
// - ★ GAME LABEL FIX: Supports both g.name (old) and g.gameLabel (new)
// - ★ AUTO-EXPAND HISTORY: Shows history if no today's games exist
// - ★ ENHANCED DIAGNOSTICS: Shows all games with dates for verification
//
// v2.2 UI ENHANCEMENTS (matches leagues.js v2.5):
// - ★ PROFESSIONAL CARD UI: Today's games shown as cards automatically
// - ★ INLINE SCORE EDITING: Auto-save with debounce and visual feedback
// - ★ COLLAPSIBLE HISTORY: Past games in collapsible section
// - ★ WINNER HIGHLIGHTING: Green for winner, gray for loser
// - ★ ADD GAME/MATCH: Easy buttons to add new games and matches
// - ★ IMPORT V2: Creates game entries that show in Today section
//
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

   console.log("[SPECIALTY_LEAGUES] Module v2.2.7 loading...");

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
                // ★ FIX v2.2.6: Extend protection window to 5 seconds to prevent overwriting scores
                const timeSinceSave = Date.now() - _lastSaveTime;
                if (_saveInProgress || timeSinceSave < 5000) {
                    console.log("[SPECIALTY_LEAGUES] Recent save detected (" + Math.round(timeSinceSave/1000) + "s ago), skipping refresh");
                    return;
                }
                // Debounce refresh
                if (_refreshTimeout) {
                    clearTimeout(_refreshTimeout);
                }
                _refreshTimeout = setTimeout(() => {
                    console.log("[SPECIALTY_LEAGUES] Tab visible - checking for cloud updates...");
                    refreshFromStorage();
                }, 500); // Increased delay
            }
        };
        document.addEventListener('visibilitychange', _visibilityHandler);
        activeEventListeners.push({ type: 'visibilitychange', handler: _visibilityHandler, target: document });

        // Focus handler
        _focusHandler = () => {
            if (_isInitialized) {
                // ★ FIX v2.2.6: Extend protection window to 5 seconds
                const timeSinceSave = Date.now() - _lastSaveTime;
                if (_saveInProgress || timeSinceSave < 5000) {
                    console.log("[SPECIALTY_LEAGUES] Recent save (" + Math.round(timeSinceSave/1000) + "s ago), skipping focus refresh");
                    return;
                }
                if (_refreshTimeout) {
                    clearTimeout(_refreshTimeout);
                }
                _refreshTimeout = setTimeout(() => {
                    console.log("[SPECIALTY_LEAGUES] Window focused - checking for updates...");
                    refreshFromStorage();
                }, 500); // Increased delay
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
            const loadedCount = Object.keys(loaded).length;
            const existingCount = Object.keys(specialtyLeagues).length;
            
            // ★ FIX v2.2.1: DEFENSIVE LOADING - Don't wipe existing data if source is empty
            // This prevents data loss when loadGlobalSettings returns stale/empty cache
            if (loadedCount === 0 && existingCount > 0) {
                console.warn("[SPECIALTY_LEAGUES] ⚠️ loadGlobalSettings returned empty but we have existing data. Keeping existing data.");
                console.log("[SPECIALTY_LEAGUES] Existing leagues:", Object.keys(specialtyLeagues).join(', '));
                return; // Don't wipe existing data
            }
            
            // Clear and fill with validated data
            Object.keys(specialtyLeagues).forEach(k => delete specialtyLeagues[k]);
            
            Object.keys(loaded).forEach(leagueId => {
                specialtyLeagues[leagueId] = validateLeague(loaded[leagueId], leagueId);
            });

            console.log("[SPECIALTY_LEAGUES] Data loaded:", {
                leagues: Object.keys(specialtyLeagues).length,
                leagueNames: Object.values(specialtyLeagues).map(l => l.name).join(', ')
            });
        } catch (e) {
            console.error("[SPECIALTY_LEAGUES] Load failed:", e);
            // ★ FIX: Don't clear data on error
        }
    }

    /**
     * Refresh data from storage (call when tab becomes visible or after cloud sync)
     * ★ FIX v2.2.1: More defensive - won't wipe data if source returns empty
     */
    function refreshFromStorage() {
        // ★ FIX v2.2.6: Extended protection window to 5 seconds
        const timeSinceSave = Date.now() - _lastSaveTime;
        if (_saveInProgress || timeSinceSave < 5000) {
            console.log("[SPECIALTY_LEAGUES] In protection window (" + Math.round(timeSinceSave/1000) + "s since save), skipping refresh");
            return;
        }

        // ★ FIX v2.2.1: Check what loadGlobalSettings would give us BEFORE clearing anything
        const g = window.loadGlobalSettings?.() || {};
        const freshData = g.specialtyLeagues || {};
        const freshCount = Object.keys(freshData).length;
        const existingCount = Object.keys(specialtyLeagues).length;
        
        // Don't refresh if it would wipe our data
        if (freshCount === 0 && existingCount > 0) {
            console.warn("[SPECIALTY_LEAGUES] ⚠️ Refresh skipped - source is empty but we have data");
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

    function saveData(forceCloudSync = false) {
        // ✅ RBAC Check for modifications
        if (window.AccessControl?.canEditSetup && !window.AccessControl.canEditSetup()) {
            console.warn('[SPECIALTY_LEAGUES] Save blocked - insufficient permissions');
            return;
        }

        try {
            // ★ FIX v2.1: Set protection flags (matches leagues.js pattern)
            _saveInProgress = true;
            _lastSaveTime = Date.now();

            // ★ FIX v2.2.3: Debug logging for standings sync
            console.log("[SPECIALTY_LEAGUES] Saving data...");
            Object.entries(specialtyLeagues).forEach(([id, league]) => {
                const standingsCount = Object.keys(league.standings || {}).length;
                const gamesCount = (league.games || []).length;
                if (standingsCount > 0) {
                    console.log(`  - "${league.name}": ${standingsCount} team standings, ${gamesCount} games`);
                    console.log(`    Standings:`, league.standings);
                }
            });

            // ★ FIX v2.1: Write to localStorage immediately (prevents race conditions)
            // Use deep clone to capture all nested objects including standings
            const dataToSave = JSON.parse(JSON.stringify(specialtyLeagues));
            try {
                const lsKey = 'campistryGlobalSettings';
                const lsRaw = localStorage.getItem(lsKey);
                const lsData = lsRaw ? JSON.parse(lsRaw) : {};
                lsData.specialtyLeagues = dataToSave;
                lsData.updated_at = new Date().toISOString();
                localStorage.setItem(lsKey, JSON.stringify(lsData));
                console.log("[SPECIALTY_LEAGUES] ✅ Data written to localStorage");
            } catch (lsErr) {
                console.warn("[SPECIALTY_LEAGUES] localStorage write failed:", lsErr);
            }

            // ★ Save via saveGlobalSettings (handles batching + cloud sync)
            window.saveGlobalSettings?.("specialtyLeagues", dataToSave);
            console.log("[SPECIALTY_LEAGUES] ✅ Data queued for cloud sync");

            // ★ FIX v2.2.3: Force immediate cloud sync when requested (for standings changes)
            if (forceCloudSync) {
                setTimeout(() => {
                    // Try forceSyncToCloud first
                    if (typeof window.forceSyncToCloud === 'function') {
                        window.forceSyncToCloud()
                            .then(() => console.log("[SPECIALTY_LEAGUES] ✅ Cloud sync completed"))
                            .catch(err => console.warn("[SPECIALTY_LEAGUES] Cloud sync error:", err));
                    } 
                    // Fallback: try setCloudState
                    else if (typeof window.setCloudState === 'function') {
                        const settings = window.loadGlobalSettings?.() || {};
                        settings.specialtyLeagues = dataToSave;
                        window.setCloudState(settings, true)
                            .then(() => console.log("[SPECIALTY_LEAGUES] ✅ Cloud sync via setCloudState"))
                            .catch(err => console.warn("[SPECIALTY_LEAGUES] setCloudState error:", err));
                    }
                    // Last resort: manual push to Supabase
                    else if (window.SupabaseSync?.pushChanges) {
                        window.SupabaseSync.pushChanges()
                            .then(() => console.log("[SPECIALTY_LEAGUES] ✅ Cloud sync via SupabaseSync"))
                            .catch(err => console.warn("[SPECIALTY_LEAGUES] SupabaseSync error:", err));
                    }
                }, 100);
            }

            } catch (e) {
            console.error("[SPECIALTY_LEAGUES] Save failed:", e);
        } finally {
            // ★ v2.2.7 FIX: Always schedule _saveInProgress reset, even if save throws
            setTimeout(() => {
                _saveInProgress = false;
            }, 500);
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

        // ★ FIX v2.2.1: Check if we already have data before loading
        // This prevents wiping data if loadGlobalSettings hasn't hydrated yet
        const existingCount = Object.keys(specialtyLeagues).length;
        const g = window.loadGlobalSettings?.() || {};
        const sourceCount = Object.keys(g.specialtyLeagues || {}).length;
        
        if (existingCount > 0 && sourceCount === 0) {
            console.log("[SPECIALTY_LEAGUES] ⚠️ Keeping existing data (source empty, have " + existingCount + " leagues)");
            // Don't call loadData() - keep what we have
        } else {
            loadData();
        }

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
                // ★ v2.2.7 FIX: confirm() renders plain text; escapeHtml produces HTML entities
                // that show as literal "&amp;" etc. Use raw name since confirm() is XSS-safe.
                if (confirm(`Delete "${league.name}"?`)) {
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
                // ★ v2.2.6: Always refresh standings when switching to this tab
                renderStandingsTable(league, standingsDiv);
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

            // ★ v2.2.4: Add header with Recalculate button
            const headerBar = document.createElement('div');
            headerBar.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;';
            
            const headerTitle = document.createElement('div');
            headerTitle.style.cssText = 'font-size:0.75rem; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; color:#6B7280;';
            headerTitle.textContent = 'Standings';
            headerBar.appendChild(headerTitle);
            
            const recalcBtn = document.createElement('button');
            recalcBtn.textContent = '↻ Recalculate from Games';
            recalcBtn.title = 'Reset standings based on game results';
            Object.assign(recalcBtn.style, {
                padding: '6px 12px',
                fontSize: '0.75rem',
                border: '1px solid #E5E7EB',
                borderRadius: '6px',
                background: '#fff',
                color: '#6B7280',
                cursor: 'pointer',
                fontWeight: '500',
                transition: 'all 0.15s'
            });
            recalcBtn.onmouseover = () => { recalcBtn.style.borderColor = '#111827'; recalcBtn.style.color = '#111827'; };
            recalcBtn.onmouseout = () => { recalcBtn.style.borderColor = '#E5E7EB'; recalcBtn.style.color = '#6B7280'; };
            recalcBtn.onclick = () => {
                if (confirm('Recalculate standings from game results? This will overwrite any manual changes.')) {
                    recalcStandings(league);
                    saveData(true);
                    renderStandingsTable(league, container);
                }
            };
            headerBar.appendChild(recalcBtn);
            container.appendChild(headerBar);

            // ★ v2.2.5: Advanced sorting with tiebreakers
            const sorted = sortTeamsWithTiebreakers(league);

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
                    <th style="padding:12px; text-align:center; font-weight:600; color:#6B7280; font-size:0.85rem;" title="Point Differential">+/-</th>
                </tr>
            `;
            table.appendChild(thead);

            const tbody = document.createElement('tbody');
            sorted.forEach((teamData, idx) => {
                const team = teamData.team;
                // Ensure standings object exists
                if (!league.standings[team]) {
                    league.standings[team] = { w: 0, l: 0, t: 0 };
                }
                const stats = league.standings[team];
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
                
                // ★ v2.2.4: Editable Wins
                const tdW = document.createElement('td');
                Object.assign(tdW.style, { padding: '8px', borderBottom, textAlign: 'center' });
                const inputW = createStandingInput(stats.w, '#059669', (val) => {
                    stats.w = val;
                    saveData(true);
                    // Re-sort after change
                    setTimeout(() => renderStandingsTable(league, container), 100);
                });
                tdW.appendChild(inputW);
                row.appendChild(tdW);
                
                // ★ v2.2.4: Editable Losses
                const tdL = document.createElement('td');
                Object.assign(tdL.style, { padding: '8px', borderBottom, textAlign: 'center' });
                const inputL = createStandingInput(stats.l, '#DC2626', (val) => {
                    stats.l = val;
                    saveData(true);
                    setTimeout(() => renderStandingsTable(league, container), 100);
                });
                tdL.appendChild(inputL);
                row.appendChild(tdL);
                
                // ★ v2.2.4: Editable Ties
                const tdT = document.createElement('td');
                Object.assign(tdT.style, { padding: '8px', borderBottom, textAlign: 'center' });
                const inputT = createStandingInput(stats.t, '#6B7280', (val) => {
                    stats.t = val;
                    saveData(true);
                    setTimeout(() => renderStandingsTable(league, container), 100);
                });
                tdT.appendChild(inputT);
                row.appendChild(tdT);
                
                // ★ v2.2.5: Point Differential column
                const tdDiff = document.createElement('td');
                const diff = teamData.pointDiff || 0;
                const diffColor = diff > 0 ? '#059669' : diff < 0 ? '#DC2626' : '#6B7280';
                const diffText = diff > 0 ? `+${diff}` : `${diff}`;
                Object.assign(tdDiff.style, { padding: '12px', borderBottom, textAlign: 'center', color: diffColor, fontWeight: '500', fontSize: '0.85rem' });
                tdDiff.textContent = diffText;
                row.appendChild(tdDiff);
                
                tbody.appendChild(row);
            });
            
            table.appendChild(tbody);
            container.appendChild(table);
            
            // ★ v2.2.5: Updated helper text
            const helperText = document.createElement('div');
            helperText.style.cssText = 'margin-top:8px; font-size:0.75rem; color:#9CA3AF; text-align:center;';
            helperText.textContent = 'Click W/L/T to edit • Tiebreakers: Head-to-head → Point differential';
            container.appendChild(helperText);
            
        } catch (e) {
            console.error("[SPECIALTY_LEAGUES] Error rendering standings table:", e);
        }
    }
    
    /**
     * ★ v2.2.5: Sort teams with advanced tiebreakers
     * 1. Win percentage (W / (W+L+T))
     * 2. Head-to-head record
     * 3. Overall point differential
     */
    function sortTeamsWithTiebreakers(league) {
        const teams = league.teams || [];
        const games = league.games || [];
        
        // Calculate point differential for each team
        const pointDiffs = {};
        const headToHead = {}; // headToHead[teamA][teamB] = { wins: X, losses: Y, pointDiff: Z }
        
        teams.forEach(team => {
            pointDiffs[team] = 0;
            headToHead[team] = {};
            teams.forEach(otherTeam => {
                if (team !== otherTeam) {
                    headToHead[team][otherTeam] = { wins: 0, losses: 0, pointDiff: 0 };
                }
            });
        });
        
        // Process all games to calculate stats
        games.forEach(game => {
            (game.matches || []).forEach(match => {
                const teamA = match.teamA;
                const teamB = match.teamB;
                const scoreA = match.scoreA;
                const scoreB = match.scoreB;
                
                // Only process if we have valid scores and teams
                if (scoreA === null || scoreB === null || scoreA === undefined || scoreB === undefined) return;
                if (!teams.includes(teamA) || !teams.includes(teamB)) return;
                
                const diffA = scoreA - scoreB;
                const diffB = scoreB - scoreA;
                
                // Update point differentials
                pointDiffs[teamA] = (pointDiffs[teamA] || 0) + diffA;
                pointDiffs[teamB] = (pointDiffs[teamB] || 0) + diffB;
                
                // Update head-to-head
                if (headToHead[teamA] && headToHead[teamA][teamB]) {
                    headToHead[teamA][teamB].pointDiff += diffA;
                    if (scoreA > scoreB) {
                        headToHead[teamA][teamB].wins++;
                    } else if (scoreB > scoreA) {
                        headToHead[teamA][teamB].losses++;
                    }
                }
                if (headToHead[teamB] && headToHead[teamB][teamA]) {
                    headToHead[teamB][teamA].pointDiff += diffB;
                    if (scoreB > scoreA) {
                        headToHead[teamB][teamA].wins++;
                    } else if (scoreA > scoreB) {
                        headToHead[teamB][teamA].losses++;
                    }
                }
            });
        });
        
        // Create sortable team objects
        const teamData = teams.map(team => {
            const stats = league.standings[team] || { w: 0, l: 0, t: 0 };
            const totalGames = stats.w + stats.l + stats.t;
            const winPct = totalGames > 0 ? (stats.w + stats.t * 0.5) / totalGames : 0;
            
            return {
                team,
                wins: stats.w,
                losses: stats.l,
                ties: stats.t,
                winPct,
                pointDiff: pointDiffs[team] || 0,
                headToHead: headToHead[team] || {}
            };
        });
        
        // Sort with tiebreakers
        teamData.sort((a, b) => {
            // 1. Compare by wins first
            if (b.wins !== a.wins) return b.wins - a.wins;
            
            // 2. Compare by losses (fewer is better)
            if (a.losses !== b.losses) return a.losses - b.losses;
            
            // 3. Same W-L record - check head-to-head
            const h2h = a.headToHead[b.team];
            if (h2h) {
                const h2hDiff = h2h.wins - h2h.losses;
                if (h2hDiff !== 0) {
                    // a beat b more times = a ranks higher (return negative)
                    return -h2hDiff;
                }
                
                // 4. Head-to-head tied - use head-to-head point differential
                if (h2h.pointDiff !== 0) {
                    return -h2h.pointDiff; // positive diff = a ranks higher
                }
            }
            
            // 5. Fall back to overall point differential
            if (b.pointDiff !== a.pointDiff) return b.pointDiff - a.pointDiff;
            
            // 6. Still tied - alphabetical
            return a.team.localeCompare(b.team);
        });
        
        return teamData;
    }
    
    /**
     * ★ v2.2.4: Create an editable input for standings
     */
    function createStandingInput(value, color, onChange) {
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.value = value || 0;
        Object.assign(input.style, {
            width: '48px',
            textAlign: 'center',
            padding: '6px 4px',
            border: '1px solid transparent',
            borderRadius: '6px',
            fontSize: '0.95rem',
            fontWeight: '600',
            color: color,
            background: 'transparent',
            cursor: 'pointer',
            transition: 'all 0.15s'
        });
        
        // Show border on hover
        input.onmouseover = () => { input.style.borderColor = '#E5E7EB'; input.style.background = '#F9FAFB'; };
        input.onmouseout = () => { 
            if (document.activeElement !== input) {
                input.style.borderColor = 'transparent'; 
                input.style.background = 'transparent'; 
            }
        };
        
        // Highlight on focus
        input.onfocus = () => { input.style.borderColor = color; input.style.background = '#fff'; input.select(); };
        input.onblur = () => { input.style.borderColor = 'transparent'; input.style.background = 'transparent'; };
        
        // Save on change
        let saveTimeout = null;
        input.oninput = () => {
            if (saveTimeout) clearTimeout(saveTimeout);
            saveTimeout = setTimeout(() => {
                const newVal = parseInt(input.value, 10) || 0;
                onChange(newVal);
            }, 300);
        };
        
        // Save on Enter
        input.onkeydown = (e) => {
            if (e.key === 'Enter') {
                input.blur();
                const newVal = parseInt(input.value, 10) || 0;
                onChange(newVal);
            }
        };
        
        return input;
    }

    // =============================================================
    // ★ v2.1: PROFESSIONAL GAME ENTRY UI (matches leagues.js v2.5)
    // =============================================================
    
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
     * Render the main game entry UI with professional styling
     * Shows today's games automatically as cards
     */
    function renderGameEntryUI(league, container) {
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
        importBtn.onclick = () => importGamesFromScheduleV2(league, container);
        header.appendChild(importBtn);
        container.appendChild(header);

        // Get and group games by date
        const games = league.games || [];
        const currentDate = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        
        const todaysGames = [];
        const pastGames = [];
        
        games.forEach((g, idx) => {
            const gameWithIdx = { ...g, _idx: idx };
            // ★ FIX v2.2.1: Handle games without dates (treat as past)
            if (g.date === currentDate) {
                todaysGames.push(gameWithIdx);
            } else {
                // Games with different date OR no date go to history
                pastGames.push(gameWithIdx);
            }
        });
        
        // Sort by game number/label
        const sortByGameNum = (a, b) => {
            // ★ FIX: Support both gameLabel and name fields
            const labelA = a.gameLabel || a.name || '';
            const labelB = b.gameLabel || b.name || '';
            const numA = a.gameNumber || parseInt((labelA).match(/\d+/)?.[0]) || 0;
            const numB = b.gameNumber || parseInt((labelB).match(/\d+/)?.[0]) || 0;
            return numA - numB;
        };
        todaysGames.sort(sortByGameNum);
        pastGames.sort((a, b) => {
            if (a.date !== b.date) return (b.date || '').localeCompare(a.date || '');
            return sortByGameNum(a, b);
        });

        // TODAY'S GAMES SECTION
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
                const card = renderGameCard(league, game, false, container);
                todaySection.appendChild(card);
            });
        }
        
        container.appendChild(todaySection);
        
        // PAST GAMES (collapsible history)
        if (pastGames.length > 0) {
            const pastSection = document.createElement('div');
            pastSection.style.marginBottom = '24px';
            
            // ★ FIX v2.2.1: Auto-expand if no today's games
            const shouldAutoExpand = todaysGames.length === 0;
            
            const pastHeader = document.createElement('div');
            pastHeader.style.cssText = 'font-size:0.75rem; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; color:#9CA3AF; margin-bottom:12px; cursor:pointer; display:flex; align-items:center; gap:6px;';
            pastHeader.innerHTML = '<span id="sl-past-arrow" style="font-size:0.65rem;">' + (shouldAutoExpand ? '▼' : '▶') + '</span> History (' + pastGames.length + ')';
            
            const pastContent = document.createElement('div');
            pastContent.style.display = shouldAutoExpand ? 'block' : 'none';
            
            pastHeader.onclick = () => {
                const isHidden = pastContent.style.display === 'none';
                pastContent.style.display = isHidden ? 'block' : 'none';
                const arrow = pastHeader.querySelector('#sl-past-arrow');
                if (arrow) arrow.textContent = isHidden ? '▼' : '▶';
            };
            
            pastGames.forEach(game => {
                const card = renderGameCard(league, game, true, container);
                pastContent.appendChild(card);
            });
            
            pastSection.appendChild(pastHeader);
            pastSection.appendChild(pastContent);
            container.appendChild(pastSection);
        }
        
        // ADD NEW GAME BUTTON
        const addNewBtn = document.createElement('button');
        addNewBtn.textContent = '+ Add Game';
        addNewBtn.style.cssText = 'padding:10px 16px; border:1px solid #E5E7EB; border-radius:6px; background:#fff; cursor:pointer; color:#6B7280; font-weight:500; font-size:0.875rem; width:100%; transition: all 0.15s ease;';
        addNewBtn.onmouseover = () => { addNewBtn.style.borderColor = '#111827'; addNewBtn.style.color = '#111827'; };
        addNewBtn.onmouseout = () => { addNewBtn.style.borderColor = '#E5E7EB'; addNewBtn.style.color = '#6B7280'; };
        addNewBtn.onclick = () => {
            if (!league.games) league.games = [];
            const newIdx = league.games.length;
            const currentDate = window.currentScheduleDate || new Date().toISOString().split('T')[0];
            league.games.push({
                date: currentDate,
                gameLabel: 'Game ' + (newIdx + 1),
                matches: []
            });
            saveData();
            renderGameEntryUI(league, container);
        };
        container.appendChild(addNewBtn);
    }
    
    /**
     * Render a single game card with inline score editing
     * ★ v2.2.1: Backward compatible with old g.name field
     */
    function renderGameCard(league, game, isPast, parentContainer) {
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
        // ★ FIX: Support both old (name) and new (gameLabel) fields
        gameTitle.textContent = game.gameLabel || game.name || ('Game ' + (game._idx + 1));
        
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
                saveData(true); // ★ Force cloud sync for standings change
                renderGameEntryUI(league, parentContainer);
            }
        };
        
        headerRight.appendChild(gameDate);
        headerRight.appendChild(deleteBtn);
        cardHeader.appendChild(gameTitle);
        cardHeader.appendChild(headerRight);
        card.appendChild(cardHeader);
        
        // Matchups container
        const matchupsContainer = document.createElement('div');
        matchupsContainer.style.padding = '8px 0';
        
        if (!game.matches || game.matches.length === 0) {
            const noMatches = document.createElement('div');
            noMatches.style.cssText = 'text-align:center; padding:16px; color:#9CA3AF; font-size:0.875rem;';
            noMatches.textContent = 'No matchups added';
            matchupsContainer.appendChild(noMatches);
        } else {
            game.matches.forEach((match, mIdx) => {
                const matchRow = renderMatchRow(league, game, match, mIdx, isPast, parentContainer);
                matchupsContainer.appendChild(matchRow);
            });
        }
        
        card.appendChild(matchupsContainer);
        
        // Footer with Add Match button (only for today's games)
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
                // Default to first two teams if available
                const teamA = league.teams?.[0] || '';
                const teamB = league.teams?.[1] || '';
                game.matches.push({ teamA, teamB, scoreA: null, scoreB: null });
                league.games[game._idx] = game;
                saveData();
                renderGameEntryUI(league, parentContainer);
            };
            
            const saveStatus = document.createElement('span');
            saveStatus.id = 'sl-save-status-' + game._idx;
            saveStatus.style.cssText = 'font-size:0.75rem; color:#10B981; opacity:0; transition: opacity 0.3s;';
            saveStatus.textContent = '✓ Saved';
            
            footer.appendChild(addMatchBtn);
            footer.appendChild(saveStatus);
            card.appendChild(footer);
        }
        
        return card;
    }
    
    /**
     * Render a single match row with inline score editing
     */
    function renderMatchRow(league, game, match, matchIdx, isPast, parentContainer) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; gap:8px; padding:8px 16px; border-bottom:1px solid #F9FAFB;';
        
        // Determine winner for highlighting
        const scoreA = match.scoreA !== null && match.scoreA !== undefined ? parseInt(match.scoreA, 10) : null;
        const scoreB = match.scoreB !== null && match.scoreB !== undefined ? parseInt(match.scoreB, 10) : null;
        const hasScores = scoreA !== null && scoreB !== null;
        const isTie = hasScores && scoreA === scoreB;
        const winnerIsA = hasScores && !isTie && scoreA > scoreB;
        const winnerIsB = hasScores && !isTie && scoreB > scoreA;
        
        // Team A
        const teamAEl = document.createElement('div');
        teamAEl.style.cssText = 'flex:1; text-align:right; font-weight:500; font-size:0.9rem;';
        if (winnerIsA) teamAEl.style.color = '#059669';
        else if (winnerIsB) teamAEl.style.color = '#9CA3AF';
        teamAEl.textContent = match.teamA || '—';
        row.appendChild(teamAEl);
        
        // Score A
        const scoreAInput = document.createElement('input');
        scoreAInput.type = 'number';
        scoreAInput.min = '0';
        scoreAInput.value = scoreA !== null ? scoreA : '';
        scoreAInput.placeholder = '-';
        scoreAInput.disabled = isPast;
        Object.assign(scoreAInput.style, {
            width: '44px',
            textAlign: 'center',
            padding: '6px 4px',
            border: '1px solid #E5E7EB',
            borderRadius: '4px',
            fontSize: '0.9rem',
            fontWeight: '600',
            background: isPast ? '#F9FAFB' : '#fff'
        });
        if (winnerIsA) scoreAInput.style.color = '#059669';
        row.appendChild(scoreAInput);
        
        // VS
        const vsEl = document.createElement('span');
        vsEl.style.cssText = 'color:#D1D5DB; font-size:0.75rem; font-weight:500;';
        vsEl.textContent = isTie ? '=' : '—';
        row.appendChild(vsEl);
        
        // Score B
        const scoreBInput = document.createElement('input');
        scoreBInput.type = 'number';
        scoreBInput.min = '0';
        scoreBInput.value = scoreB !== null ? scoreB : '';
        scoreBInput.placeholder = '-';
        scoreBInput.disabled = isPast;
        Object.assign(scoreBInput.style, {
            width: '44px',
            textAlign: 'center',
            padding: '6px 4px',
            border: '1px solid #E5E7EB',
            borderRadius: '4px',
            fontSize: '0.9rem',
            fontWeight: '600',
            background: isPast ? '#F9FAFB' : '#fff'
        });
        if (winnerIsB) scoreBInput.style.color = '#059669';
        row.appendChild(scoreBInput);
        
        // Team B
        const teamBEl = document.createElement('div');
        teamBEl.style.cssText = 'flex:1; font-weight:500; font-size:0.9rem;';
        if (winnerIsB) teamBEl.style.color = '#059669';
        else if (winnerIsA) teamBEl.style.color = '#9CA3AF';
        teamBEl.textContent = match.teamB || '—';
        row.appendChild(teamBEl);
        
        // Delete match button (only for today's games)
        if (!isPast) {
            const deleteMatchBtn = document.createElement('button');
            deleteMatchBtn.innerHTML = '×';
            deleteMatchBtn.style.cssText = 'background:none; border:none; cursor:pointer; color:#D1D5DB; font-size:1.2rem; padding:0 4px; line-height:1; transition: color 0.15s;';
            deleteMatchBtn.onmouseover = () => deleteMatchBtn.style.color = '#DC2626';
            deleteMatchBtn.onmouseout = () => deleteMatchBtn.style.color = '#D1D5DB';
            deleteMatchBtn.onclick = () => {
                game.matches.splice(matchIdx, 1);
                league.games[game._idx] = game;
                recalcStandings(league);
                saveData(true); // ★ Force cloud sync for standings change
                renderGameEntryUI(league, parentContainer);
            };
            row.appendChild(deleteMatchBtn);
        }
        
        // ★ v2.2.6: Improved score handling - saves immediately, updates standings in real-time
        if (!isPast) {
            // Function to save scores and update data
            const saveScores = () => {
                const newScoreA = scoreAInput.value !== '' ? parseInt(scoreAInput.value, 10) : null;
                const newScoreB = scoreBInput.value !== '' ? parseInt(scoreBInput.value, 10) : null;
                
                // Only save if something changed
                if (match.scoreA === newScoreA && match.scoreB === newScoreB) return;
                
                match.scoreA = newScoreA;
                match.scoreB = newScoreB;
                
                // Determine winner
                if (newScoreA !== null && newScoreB !== null) {
                    if (newScoreA > newScoreB) match.winner = match.teamA;
                    else if (newScoreB > newScoreA) match.winner = match.teamB;
                    else match.winner = 'tie';
                } else {
                    match.winner = null;
                }
                
                league.games[game._idx] = game;
                recalcStandings(league);
                saveData(true); // ★ Force cloud sync
                
                console.log('[SPECIALTY_LEAGUES] Score saved:', match.teamA, newScoreA, '-', newScoreB, match.teamB);
                
                // Show save indicator
                const statusEl = document.getElementById('sl-save-status-' + game._idx);
                if (statusEl) {
                    statusEl.style.opacity = '1';
                    setTimeout(() => { statusEl.style.opacity = '0'; }, 1500);
                }
                
                // Update highlighting colors without full re-render
                updateRowHighlighting();
            };
            
            // Function to update visual highlighting without re-render
            const updateRowHighlighting = () => {
                const valA = scoreAInput.value !== '' ? parseInt(scoreAInput.value, 10) : null;
                const valB = scoreBInput.value !== '' ? parseInt(scoreBInput.value, 10) : null;
                const hasScores = valA !== null && valB !== null;
                const winA = hasScores && valA > valB;
                const winB = hasScores && valB > valA;
                const tie = hasScores && valA === valB;
                
                // Update team name colors
                teamAEl.style.color = winA ? '#059669' : (winB ? '#9CA3AF' : '#111827');
                teamBEl.style.color = winB ? '#059669' : (winA ? '#9CA3AF' : '#111827');
                
                // Update score input colors
                scoreAInput.style.color = winA ? '#059669' : '#111827';
                scoreBInput.style.color = winB ? '#059669' : '#111827';
                
                // Update VS indicator
                vsEl.textContent = tie ? '=' : '—';
            };
            
            // ★ Save on blur (when leaving input) - ensures persistence on tab switch
            scoreAInput.onblur = saveScores;
            scoreBInput.onblur = saveScores;
            
            // ★ Debounced update while typing (100ms for quick feedback)
            let inputTimeout = null;
            const handleInput = () => {
                // Update highlighting immediately for visual feedback
                updateRowHighlighting();
                
                // Debounce the actual save
                if (inputTimeout) clearTimeout(inputTimeout);
                inputTimeout = setTimeout(saveScores, 100);
            };
            
            scoreAInput.oninput = handleInput;
            scoreBInput.oninput = handleInput;
            
            // ★ Save on Enter key
            const handleKeydown = (e) => {
                if (e.key === 'Enter') {
                    e.target.blur(); // This triggers saveScores via onblur
                }
            };
            scoreAInput.onkeydown = handleKeydown;
            scoreBInput.onkeydown = handleKeydown;
        }
        
        return row;
    }
    
    /**
     * ★ v2.1: Import games from schedule - creates game entries that show in Today section
     */
    function importGamesFromScheduleV2(league, parentContainer) {
        if (!league.teams || league.teams.length < 2) {
            alert('Add at least 2 teams to this league first.');
            return;
        }

        try {
            const daily = window.loadCurrentDailyData?.() || {};
            const leagueAssignments = window.leagueAssignments || {};
            const scheduleAssignments = daily.scheduleAssignments || window.scheduleAssignments || {};
            const skeleton = daily.manualSkeleton || [];
            const divisions = window.divisions || {};
            const currentDate = window.currentScheduleDate || new Date().toISOString().split('T')[0];

            console.log('[SPECIALTY_LEAGUES] Import: Looking for games for league "' + league.name + '"');

            // Use smart division matching
            const availableScheduleDivisions = Object.keys(leagueAssignments);
            const matchingDivisions = getMatchingScheduleDivisions(league.divisions || [], availableScheduleDivisions);
            
            console.log('[SPECIALTY_LEAGUES] Import: Matching divisions:', matchingDivisions);

            // Group matchups by game label
            const gamesByLabel = {};

            // Method 1: Check leagueAssignments for specialty league entries
            for (const divName of matchingDivisions) {
                const divAssignments = leagueAssignments[divName];
                if (!divAssignments) continue;

                for (const slotIdx of Object.keys(divAssignments)) {
                    const slotData = divAssignments[slotIdx];
                    if (!slotData) continue;
                    
                    const isOurLeague = slotData.isSpecialtyLeague && 
                        (slotData.leagueName === league.name || slotData.sport === league.sport);
                    
                    if (!isOurLeague) continue;

                    const gameLabel = slotData.gameLabel || `Game ${Object.keys(gamesByLabel).length + 1}`;
                    const gameNumber = parseInt((gameLabel.match(/\d+/) || [])[0], 10) || Object.keys(gamesByLabel).length + 1;
                    const matchups = slotData.matchups || [];
                    
                    if (!gamesByLabel[gameLabel]) {
                        gamesByLabel[gameLabel] = { gameLabel, gameNumber, matchups: [] };
                    }
                    
                    matchups.forEach(m => {
                        const teamA = m.teamA?.trim();
                        const teamB = m.teamB?.trim();
                        
                        if (teamA && teamB && league.teams.includes(teamA) && league.teams.includes(teamB)) {
                            const exists = gamesByLabel[gameLabel].matchups.some(g =>
                                (g.teamA === teamA && g.teamB === teamB) ||
                                (g.teamA === teamB && g.teamB === teamA)
                            );
                            
                            if (!exists) {
                                gamesByLabel[gameLabel].matchups.push({ teamA, teamB });
                            }
                        }
                    });
                }
            }

            // Method 2: Fallback to skeleton scan if no leagueAssignments found
            if (Object.keys(gamesByLabel).length === 0) {
                skeleton.forEach(block => {
                    if (!block || !block.division) return;
                    if (!league.divisions.includes(block.division)) return;

                    const startMin = parseTimeToMinutes(block.startTime);
                    if (startMin === null) return;
                    
                    const slotIdx = findSlotIndexForTime(startMin);
                    if (slotIdx === -1) return;

                    const divBunks = divisions[block.division]?.bunks || [];
                    if (divBunks.length === 0) return;
                    
                    const entry = scheduleAssignments[divBunks[0]]?.[slotIdx];
                    if (!entry) return;

                    const entrySport = (entry.sport || "").trim();
                    const entryField = (typeof entry.field === 'string' ? entry.field : "").trim();

                    const matchSport = league.sport && entrySport === league.sport;
                    const matchField = league.fields.includes(entryField);

                    if (!matchSport && !matchField) return;

                    const gameLabel = `${block.event || 'Activity'} (${minutesToTimeLabel(startMin)})`;
                    
                    let linesToScan = [];
                    if (entry._allMatchups && Array.isArray(entry._allMatchups)) {
                        linesToScan = entry._allMatchups;
                    } else if (entryField) {
                        linesToScan = entryField.split('\n');
                    }

                    linesToScan.forEach(line => {
                        if (typeof line !== 'string') return;
                        const m = line.match(/^(.*?)\s+vs\.?\s+(.*?)(?:\s*[@\(]|$)/i);
                        if (m) {
                            const tA = m[1].trim();
                            const tB = m[2].trim();

                            if (league.teams.includes(tA) && league.teams.includes(tB)) {
                                if (!gamesByLabel[gameLabel]) {
                                    gamesByLabel[gameLabel] = { gameLabel, gameNumber: Object.keys(gamesByLabel).length + 1, matchups: [] };
                                }
                                
                                const exists = gamesByLabel[gameLabel].matchups.some(g =>
                                    (g.teamA === tA && g.teamB === tB) ||
                                    (g.teamA === tB && g.teamB === tA)
                                );
                                
                                if (!exists) {
                                    gamesByLabel[gameLabel].matchups.push({ teamA: tA, teamB: tB });
                                }
                            }
                        }
                    });
                });
            }

            const gameLabels = Object.keys(gamesByLabel);
            if (gameLabels.length === 0) {
                alert(
                    'No games found for "' + league.name + '" in today\'s schedule.\n\n' +
                    'Make sure:\n' +
                    '1. A schedule has been generated for today\n' +
                    '2. This league is assigned to scheduled divisions\n' +
                    '3. The league has teams that appear in matchups'
                );
                return;
            }

            // Sort by game number
            gameLabels.sort((a, b) => {
                const numA = gamesByLabel[a].gameNumber || 0;
                const numB = gamesByLabel[b].gameNumber || 0;
                return numA - numB;
            });

            // Create game entries
            if (!league.games) league.games = [];
            
            let importedCount = 0;
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

                // Check if game already exists for today with same label
                const existingIdx = league.games.findIndex(g => 
                    g.date === currentDate && g.gameLabel === gameData.gameLabel
                );

                if (existingIdx >= 0) {
                    league.games[existingIdx] = newGame;
                } else {
                    league.games.push(newGame);
                }

                importedCount++;
                totalMatchups += gameData.matchups.length;
            });

            saveData();
            
            alert('Imported ' + importedCount + ' game(s) with ' + totalMatchups + ' match(es).');
            
            // Refresh to show the new games
            renderGameEntryUI(league, parentContainer);

        } catch (e) {
            console.error('[SPECIALTY_LEAGUES] Import error:', e);
            alert('Error importing games: ' + e.message);
        }
    }

    // =============================================================
    // SAVE GAME RESULTS (legacy - kept for compatibility)
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
                // ★ v2.2.7 FIX: 0-0 draws are valid ties (was requiring scoreA > 0)
                else if (scoreA === scoreB) winner = 'tie';
                
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
            saveData(true); // ★ Force cloud sync for standings change
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
            // Ensure standings object exists
            if (!league.standings) {
                league.standings = {};
            }
            
            // Reset all standings
            league.teams.forEach(t => {
                league.standings[t] = { w: 0, l: 0, t: 0 };
            });

            let gamesProcessed = 0;
            let matchesProcessed = 0;
            
            (league.games || []).forEach(g => {
                gamesProcessed++;
                (g.matches || []).forEach(m => {
                    matchesProcessed++;
                    // ★ v2.2.7 FIX: Derive winner from scores as fallback when m.winner is missing
                    let winner = m.winner;
                    if (!winner && m.scoreA != null && m.scoreB != null) {
                        const sA = parseInt(m.scoreA, 10);
                        const sB = parseInt(m.scoreB, 10);
                        if (!isNaN(sA) && !isNaN(sB)) {
                            if (sA > sB) winner = m.teamA;
                            else if (sB > sA) winner = m.teamB;
                            else winner = 'tie';
                        }
                    }
                    if (winner === 'tie') {
                        if (league.standings[m.teamA]) league.standings[m.teamA].t++;
                        if (league.standings[m.teamB]) league.standings[m.teamB].t++;
                    } else if (winner) {
                        if (league.standings[winner]) league.standings[winner].w++;
                        const loser = winner === m.teamA ? m.teamB : m.teamA;
                        if (league.standings[loser]) league.standings[loser].l++;
                    }
                });
            });
            
            console.log(`[SPECIALTY_LEAGUES] Standings recalculated for "${league.name}":`, {
                games: gamesProcessed,
                matches: matchesProcessed,
                standings: league.standings
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
    // ★ v2.2: DIAGNOSTICS FUNCTION (matches other modules pattern)
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
        
        const currentDate = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        console.log('  Current schedule date:', currentDate);
        
        console.log('\n📋 LEAGUES DETAIL:');
        Object.entries(specialtyLeagues).forEach(([id, league]) => {
            console.log(`\n  [${id}] "${league.name}":`);
            console.log(`    - Enabled: ${league.enabled}`);
            console.log(`    - Divisions: ${(league.divisions || []).join(', ') || 'none'}`);
            console.log(`    - Sport: ${league.sport || 'none'}`);
            console.log(`    - Fields: ${(league.fields || []).join(', ') || 'none'}`);
            console.log(`    - Teams: ${(league.teams || []).length}`);
            console.log(`    - Games recorded: ${(league.games || []).length}`);
            
            // ★ Show all games with their data
            if (league.games && league.games.length > 0) {
                console.log('    - Games breakdown:');
                league.games.forEach((g, idx) => {
                    const label = g.gameLabel || g.name || `Game ${idx + 1}`;
                    const matchCount = (g.matches || []).length;
                    const isToday = g.date === currentDate;
                    console.log(`      [${idx}] "${label}" - Date: ${g.date || 'NO DATE'} ${isToday ? '(TODAY)' : ''} - ${matchCount} matches`);
                });
            }
            
            // Show standings
            if (league.standings && Object.keys(league.standings).length > 0) {
                console.log('    - Standings:');
                Object.entries(league.standings).forEach(([team, stats]) => {
                    console.log(`      ${team}: W${stats.w} L${stats.l} T${stats.t}`);
                });
            }
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
            totalGames: Object.values(specialtyLeagues).reduce((sum, l) => sum + (l.games?.length || 0), 0),
            isInitialized: _isInitialized,
            saveInProgress: _saveInProgress,
            leagues: specialtyLeagues
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

    console.log("[SPECIALTY_LEAGUES] Module v2.2.7 loaded");

})();
