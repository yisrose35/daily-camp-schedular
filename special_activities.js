// ============================================================================
// special_activities.js — PRODUCTION-READY v3.0 (GRADE RESTRICTIONS / SAME-DIVISION SHARING)
// ============================================================================
// 1. Layout: Apple-inspired Two-Pane with Collapsible Detail Sections.
// 2. Logic: Retains Sharing, Frequency, and Time Rules.
// 3. Style: Matches fields.js for consistent UI/UX across the app.
// 4. Update: Added Location Dropdown for Special Activities.
// 5. Update: Added RBAC Checks for Add/Delete operations.
// 6. Update: Transition/Zone rules removed - now managed in Locations tab.
// ★ v2.1: Enhanced rainy day filtering with multiple flag support
// ★ v2.2: Added comprehensive debug logging for rainy day activity tracking
// ★ v2.3: Added Indoor/Outdoor availability section (matches fields.js pattern)
// ★ v2.4: CRITICAL FIX - Always set type:'Special' for scheduler filtering
//
// v2.0 PRODUCTION FIXES:
// - ★ CLOUD SYNC: Proper cloud sync via saveGlobalSettings
// - ★ TAB REFRESH: Refreshes data when tab becomes visible
// - ★ MEMORY LEAK FIX: Proper cleanup of all event listeners
// - ★ DATA VALIDATION: Validates structure on load
// - ★ TYPE CONSISTENCY: Ensures proper number/string handling
// - ★ NULL SAFETY: Added checks for DOM elements and parameters
// - ★ ORPHAN CLEANUP: Validates divisions and locations on load
// - ★ ERROR HANDLING: Added try/catch around risky operations
//
// v2.1 RAINY DAY FIXES:
// - ★ RAINY DAY FILTERING: getGlobalSpecialActivities now filters by rainy mode
// - ★ ROBUST MODE CHECK: isRainyDayModeActive checks multiple flags
// - ★ SCHEDULER HELPERS: Added getRainyDayOnlySpecials, getIndoorAvailableSpecials
//
// v2.3 INDOOR/OUTDOOR:
// - ★ WEATHER SECTION: Added Weather & Availability collapsible section
// - ★ INDOOR FLAG: isIndoor property determines rainy day availability
// - ★ MATCHES FIELDS: Same UI pattern as fields.js for consistency
//
// v2.4 SCHEDULER FIX:
// - ★ TYPE PROPERTY: Always ensures type:'Special' is set on all activities
// - ★ Fixes issue where activities without type were filtered out by scheduler
// ============================================================================
(function() {
'use strict';

console.log("[SPECIAL_ACTIVITIES] Module v3.0 loading...");

// =========================================================================
// STATE - Internal variables
// =========================================================================
let specialActivities = [];
let rainyDayActivities = [];
let selectedItemId = null;
let specialsListEl = null;
let rainyDayListEl = null;
let detailPaneEl = null;
let addSpecialInput = null;
let addRainyDayInput = null;
let _isInitialized = false;
let _refreshTimeout = null;

// ★ FIX: Track active event listeners for cleanup (with target info)
let activeEventListeners = [];

// ★ FIX: Track cloud sync callback for cleanup
let _cloudSyncCallback = null;

// =========================================================================
// ★ EVENT LISTENER CLEANUP HELPER
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

// =========================================================================
// ★ TAB VISIBILITY HANDLERS - Refresh data when tab becomes visible
// =========================================================================
let _visibilityHandler = null;
let _focusHandler = null;

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
                console.log("[SPECIAL_ACTIVITIES] Tab visible - refreshing data...");
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
                console.log("[SPECIAL_ACTIVITIES] Window focused - refreshing data...");
                refreshFromStorage();
            }, 300);
        }
    };
    window.addEventListener('focus', _focusHandler);
    activeEventListeners.push({ type: 'focus', handler: _focusHandler, target: window });
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
    if (_refreshTimeout) {
        clearTimeout(_refreshTimeout);
        _refreshTimeout = null;
    }
}

// =========================================================================
// ★ CLOUD SYNC LISTENER - React to remote changes
// =========================================================================
function setupCloudSyncListener() {
    // Cleanup existing
    if (_cloudSyncCallback && window.SupabaseSync?.removeStatusCallback) {
        window.SupabaseSync.removeStatusCallback(_cloudSyncCallback);
    }
    
    // Listen for cloud sync events
    if (window.SupabaseSync?.onStatusChange) {
        _cloudSyncCallback = (status) => {
            if (status === 'idle' && _isInitialized) {
                console.log("[SPECIAL_ACTIVITIES] Cloud sync complete - refreshing...");
                refreshFromStorage();
            }
        };
        window.SupabaseSync.onStatusChange(_cloudSyncCallback);
    }
    
    // Also listen for custom campistry events
    const handleRemoteChange = (event) => {
        if (_isInitialized && event.detail?.key === 'specialActivities') {
            console.log("[SPECIAL_ACTIVITIES] Remote specialActivities change detected");
            refreshFromStorage();
        }
    };
    window.addEventListener('campistry-remote-change', handleRemoteChange);
    activeEventListeners.push({ type: 'campistry-remote-change', handler: handleRemoteChange, target: window });
}

// =========================================================================
// ★ BEFOREUNLOAD HANDLER - Ensure sync on page exit
// =========================================================================
let _beforeUnloadHandler = null;

function setupBeforeUnloadHandler() {
    // Cleanup existing
    if (_beforeUnloadHandler) {
        window.removeEventListener('beforeunload', _beforeUnloadHandler);
    }
    
    _beforeUnloadHandler = () => {
        if (window._specialActivitiesSyncTimeout) {
            clearTimeout(window._specialActivitiesSyncTimeout);
            window._specialActivitiesSyncTimeout = null;
            // Force immediate sync
            window.forceSyncToCloud?.();
        }
    };
    
    window.addEventListener('beforeunload', _beforeUnloadHandler);
    activeEventListeners.push({ type: 'beforeunload', handler: _beforeUnloadHandler, target: window });
}

// =========================================================================
// ★ DATA VALIDATION - Ensure activity structure is valid
// =========================================================================
function validateSpecialActivity(activity, activityName) {
    if (!activity || typeof activity !== 'object') {
        return createDefaultActivity(activityName || 'Unknown');
    }
    
    // ★ Get valid division names for orphan detection
    let validDivisions = null;
    try {
        const settings = window.loadGlobalSettings?.() || {};
        const divisions = settings.divisions || {};
        validDivisions = new Set(Object.keys(divisions));
    } catch (e) {
        validDivisions = null;
    }
    
    // ★ Validate sharableWith structure
    let sharableWith = activity.sharableWith;
    if (!sharableWith || typeof sharableWith !== 'object') {
        sharableWith = { type: 'not_sharable', divisions: [], capacity: 2 };
    } else {
        // Validate type
        if (!['not_sharable', 'same_division', 'custom', 'all'].includes(sharableWith.type)) {
            sharableWith.type = 'not_sharable';
        }
        // Validate divisions array and remove orphans
        if (!Array.isArray(sharableWith.divisions)) {
            sharableWith.divisions = [];
        } else if (validDivisions && validDivisions.size > 0) {
            const originalLength = sharableWith.divisions.length;
            sharableWith.divisions = sharableWith.divisions.filter(d => 
                typeof d === 'string' && validDivisions.has(d)
            );
            if (sharableWith.divisions.length < originalLength) {
                console.warn(`[SPECIAL_ACTIVITIES] "${activity.name}": Removed ${originalLength - sharableWith.divisions.length} orphaned division(s) from sharableWith`);
            }
        }
        // ★ FIX: Ensure capacity is a number
        sharableWith.capacity = parseInt(sharableWith.capacity, 10) || 2;
    }
    
    // ★ Validate limitUsage structure (match fields.js pattern)
    let limitUsage = activity.limitUsage;
    if (!limitUsage || typeof limitUsage !== 'object') {
        limitUsage = { enabled: false, divisions: {}, priorityList: [] };
    } else {
        limitUsage.enabled = limitUsage.enabled === true;
        
        // Validate divisions object
        if (typeof limitUsage.divisions !== 'object' || limitUsage.divisions === null) {
            limitUsage.divisions = {};
        } else if (validDivisions && validDivisions.size > 0) {
            // Remove orphaned division keys
            const divKeys = Object.keys(limitUsage.divisions);
            divKeys.forEach(divKey => {
                if (!validDivisions.has(divKey)) {
                    delete limitUsage.divisions[divKey];
                    console.warn(`[SPECIAL_ACTIVITIES] "${activity.name}": Removed orphaned division "${divKey}" from limitUsage`);
                }
            });
        }
        
       // ★ FIX: Ensure priorityList exists and is valid (like fields.js)
        if (!Array.isArray(limitUsage.priorityList)) {
            limitUsage.priorityList = Object.keys(limitUsage.divisions);
        } else if (validDivisions && validDivisions.size > 0) {
            limitUsage.priorityList = limitUsage.priorityList.filter(d => validDivisions.has(d));
        }
        
        // ★★★ v3.0: Ensure usePriority exists ★★★
        if (limitUsage.usePriority === undefined) {
            limitUsage.usePriority = false;
        }
    }
    
    // ★ Validate timeRules with parsed times
    let timeRules = activity.timeRules;
    if (!Array.isArray(timeRules)) {
        timeRules = [];
    } else {
        timeRules = timeRules.map(rule => ({
            type: rule.type || 'Available',
            start: rule.start || '',
            end: rule.end || '',
            startMin: rule.startMin ?? parseTimeToMinutes(rule.start),
            endMin: rule.endMin ?? parseTimeToMinutes(rule.end)
        })).filter(rule => rule.start && rule.end);
    }
    
    // ★ v2.3: Determine isIndoor value - migrate from legacy properties if needed
    let isIndoor = activity.isIndoor;
    if (isIndoor === undefined) {
        // Migrate from legacy properties
        if (activity.rainyDayAvailable === true || activity.availableOnRainyDay === true) {
            isIndoor = true;
        } else if (activity.rainyDayAvailable === false || activity.availableOnRainyDay === false) {
            isIndoor = false;
        } else {
            // Default: special activities are typically indoor
            isIndoor = true;
        }
    }
    
    return {
        name: activity.name || activityName || 'Unknown',
        type: 'Special', // ★ v2.4 FIX: Always ensure type is set for scheduler filtering
        available: activity.available !== false,
        sharableWith: sharableWith,
        limitUsage: limitUsage,
        timeRules: timeRules,
        maxUsage: (activity.maxUsage !== undefined && activity.maxUsage !== "" && activity.maxUsage !== null) 
            ? parseInt(activity.maxUsage, 10) || null 
            : null,
        frequencyWeeks: parseInt(activity.frequencyWeeks, 10) || 0,
        rainyDayExclusive: activity.rainyDayExclusive === true,
       rainyDayOnly: activity.rainyDayOnly === true, // Legacy support
        location: activity.location || null, // ★ v2.5: Field/location this activity takes place on
        // ★ v2.3: Indoor/Outdoor availability (matches fields.js pattern)
        isIndoor: isIndoor,
        rainyDayAvailable: isIndoor, // Keep in sync for backward compatibility
        availableOnRainyDay: isIndoor // Keep in sync for backward compatibility
    };
}

function createDefaultActivity(name) {
    return {
        name: name,
        type: 'Special', // ★ v2.4 FIX: Always ensure type is set for scheduler filtering
        available: true,
        sharableWith: { type: 'not_sharable', divisions: [], capacity: 2 },
         limitUsage: { enabled: false, divisions: {}, priorityList: [], usePriority: false },
        timeRules: [],
        maxUsage: null,
        frequencyWeeks: 0,
        rainyDayExclusive: false,
        location: null, // ★ v2.5: Field/location this activity takes place on
        // ★ v2.3: Default special activities to indoor (typically arts, canteen, etc.)
        isIndoor: true,
        rainyDayAvailable: true,
        availableOnRainyDay: true
    };
}

function validateAllActivities(activities) {
    if (!Array.isArray(activities)) return [];
    return activities.map(a => validateSpecialActivity(a, a?.name));
}

// =========================================================================
// INIT
// =========================================================================
function initSpecialActivitiesTab() {
    const container = document.getElementById("special_activities");
    if (!container) {
        console.warn("[SPECIAL_ACTIVITIES] Container element not found");
        return;
    }

    // ★ FIX: Clean up any existing state before re-init
    cleanupEventListeners();
    cleanupTabListeners();
    
    loadData();
    container.innerHTML = "";

    // Inject Styles - ★ UNIFIED with fields.js styling (no sa- prefix)
    const style = document.createElement('style');
    style.innerHTML = `
        /* Master List - matches fields.js */
        .master-list { border: 1px solid #E5E7EB; border-radius: 12px; background: #fff; overflow: hidden; }
        .list-item { padding: 12px 14px; border-bottom: 1px solid #F3F4F6; cursor: pointer; display: flex; justify-content: space-between; align-items: center; transition: background 0.15s; }
        .list-item:last-child { border-bottom: none; }
        .list-item:hover { background: #F9FAFB; }
        .list-item.selected { background: #F0FDF4; border-left: 3px solid #10B981; }
        .list-item-name { font-weight: 500; color: #1F2937; font-size: 0.9rem; }
        .list-item-meta { font-size: 0.75rem; color: #6B7280; margin-left: 6px; }

        /* Accordion / Collapsible Sections - matches fields.js */
        .detail-section { margin-bottom: 12px; border: 1px solid #E5E7EB; border-radius: 12px; background: #fff; overflow: hidden; }
        .detail-section-header { padding: 12px 16px; background: #F9FAFB; cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none; }
        .detail-section-header:hover { background: #F3F4F6; }
        .detail-section-title { font-size: 0.9rem; font-weight: 600; color: #111; }
        .detail-section-summary { font-size: 0.8rem; color: #6B7280; margin-top: 2px; }
        .detail-section-body { display: none; padding: 16px; border-top: 1px solid #E5E7EB; }

        /* Chips - matches fields.js */
        .chip { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 0.75rem; cursor: pointer; border: 1px solid #E5E7EB; margin-right: 4px; margin-bottom: 4px; transition: all 0.2s; }
        .chip.active { background: #10B981; color: white; border-color: #10B981; box-shadow: 0 2px 5px rgba(16, 185, 129, 0.3); }
        .chip.inactive { background: #F3F4F6; color: #374151; }
        .chip:hover { transform: translateY(-1px); }

        /* Toggle Switch - matches fields.js */
        .switch { position: relative; display: inline-block; width: 34px; height: 20px; flex-shrink: 0; }
        .switch input { opacity: 0; width: 0; height: 0; }
        .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #ccc; transition: .4s; border-radius: 34px; }
        .slider:before { position: absolute; content: ""; height: 14px; width: 14px; left: 3px; bottom: 3px; background-color: white; transition: .4s; border-radius: 50%; }
        input:checked + .slider { background-color: #10B981; }
        input:checked + .slider:before { transform: translateX(14px); }

        /* Muted / Empty - matches fields.js */
        .muted { color: #9CA3AF; font-style: italic; text-align: center; padding: 20px; }

        /* Rainy Day List Styles */
        .rainy-list { background: linear-gradient(to bottom, #f0f9ff, #fff) !important; border-color: #7dd3fc !important; }
        .rainy-badge { display: inline-flex; align-items: center; gap: 3px; font-size: 0.7rem; color: #0284c7; background: #e0f2fe; padding: 2px 8px; border-radius: 999px; margin-left: 8px; }
        
        /* ★ v2.3: Indoor/Outdoor badge styles */
        .weather-badge { display: inline-flex; align-items: center; gap: 3px; font-size: 0.65rem; padding: 2px 6px; border-radius: 999px; margin-left: 6px; }
        .weather-badge.indoor { color: #065f46; background: #d1fae5; }
        .weather-badge.outdoor { color: #92400e; background: #fef3c7; }
    `;
    container.appendChild(style);

    const contentWrapper = document.createElement('div');
    contentWrapper.innerHTML = `
        <div class="setup-panel">
          <section>
            <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:16px; margin-bottom:24px;">
              <div>
                <div class="setup-title">Special Activities</div>
                <p class="setup-description">Manage special camp programs and their availability, sharing, division access, and rotation rules.</p>
              </div>
            </div>

            <div style="display:flex; flex-wrap:wrap; gap:24px;">
              <!-- LEFT SIDE: MASTER LISTS -->
              <div style="flex:1; min-width:280px;">
                <!-- Regular Special Activities -->
                <div style="display:flex; justify-content:space-between; align-items:end; margin-bottom:8px;">
                    <div class="setup-subtitle">All Specials</div>
                </div>
                
                <div style="background:white; padding:10px; border-radius:12px; border:1px solid #E5E7EB; margin-bottom:12px; display:flex; gap:8px;">
                  <input id="new-special-input" placeholder="New Special (e.g., Canteen)" style="flex:1; border:none; outline:none; font-size:0.9rem;">
                  <button id="add-special-btn" style="background:#111; color:white; border:none; border-radius:6px; padding:6px 12px; font-size:0.8rem; cursor:pointer;">Add</button>
                </div>
                <div id="specials-master-list" class="master-list" style="max-height:280px; overflow-y:auto;"></div>

                <!-- Rainy Day Special Activities -->
                <div style="margin-top:24px;">
                  <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                    <span style="font-size:1.2rem;">🌧️</span>
                    <div class="setup-subtitle" style="margin:0;">Rainy Day Activities</div>
                  </div>
                  <p style="font-size:0.75rem; color:#6B7280; margin:0 0 8px 0;">Exclusively available during rainy days</p>
                  
                  <div style="background:linear-gradient(135deg, #e0f2fe 0%, #f0f9ff 100%); padding:10px; border-radius:12px; border:1px solid #7dd3fc; margin-bottom:12px; display:flex; gap:8px;">
                    <input id="new-rainy-day-input" placeholder="New Rainy Day Activity" style="flex:1; border:none; outline:none; font-size:0.9rem; background:transparent;">
                    <button id="add-rainy-day-btn" style="background:#0284c7; color:white; border:none; border-radius:6px; padding:6px 12px; font-size:0.8rem; cursor:pointer;">Add</button>
                  </div>
                  <div id="rainy-day-master-list" class="master-list rainy-list" style="max-height:200px; overflow-y:auto;"></div>
                </div>
              </div>

              <!-- RIGHT SIDE: DETAIL PANE -->
              <div style="flex:1.4; min-width:340px;">
                <div class="setup-subtitle">Special Configuration</div>
                <div id="specials-detail-pane" style="margin-top:8px;"></div>
              </div>
            </div>
          </section>
        </div>`;
    container.appendChild(contentWrapper);

    // ★ FIX: Null check all DOM elements
    specialsListEl = document.getElementById("specials-master-list");
    rainyDayListEl = document.getElementById("rainy-day-master-list");
    detailPaneEl = document.getElementById("specials-detail-pane");
    addSpecialInput = document.getElementById("new-special-input");
    addRainyDayInput = document.getElementById("new-rainy-day-input");

    const addSpecialBtn = document.getElementById("add-special-btn");
    const addRainyDayBtn = document.getElementById("add-rainy-day-btn");

    if (addSpecialBtn) {
        addSpecialBtn.onclick = addSpecial;
    }
    if (addSpecialInput) {
        addSpecialInput.onkeyup = e => { if (e.key === "Enter") addSpecial(); };
    }

    if (addRainyDayBtn) {
        addRainyDayBtn.onclick = addRainyDayActivity;
    }
    if (addRainyDayInput) {
        addRainyDayInput.onkeyup = e => { if (e.key === "Enter") addRainyDayActivity(); };
    }

    // ★ Setup event listeners for tab visibility and cloud sync
    setupTabListeners();
    setupCloudSyncListener();
    setupBeforeUnloadHandler();
    
    _isInitialized = true;

    renderMasterList();
    renderRainyDayList();
    renderDetailPane();
    
    console.log("[SPECIAL_ACTIVITIES] Initialized:", {
        specials: specialActivities.length,
        rainyDay: rainyDayActivities.length
    });
}

// =========================================================================
// DATA LOADING / SAVING - ★ CLOUD SYNC AWARE
// =========================================================================

/**
 * Load data from persisted storage (localStorage/cloud cache)
 * Always reads fresh from loadGlobalSettings to stay in sync
 */
function loadData() {
    try {
        // ★ Use raw getter to avoid circular filtering
        const settings = window.loadGlobalSettings?.() || {};
        const allActivities = settings.specialActivities || settings.app1?.specialActivities || [];
        
        // ★★★ DEBUG: Log what we loaded from storage ★★★
        const rawRainyOnly = allActivities.filter(s => 
            s.rainyDayOnly === true || s.rainyDayExclusive === true
        );
        console.log(`[SPECIAL_ACTIVITIES] loadData: Found ${allActivities.length} total activities in storage`);
        console.log(`[SPECIAL_ACTIVITIES] loadData: ${rawRainyOnly.length} have rainyDayOnly/rainyDayExclusive=true`);
        if (rawRainyOnly.length > 0) {
            console.log(`[SPECIAL_ACTIVITIES] loadData: Rainy-only names: ${rawRainyOnly.map(s => s.name).join(', ')}`);
        }
        
        // Separate regular and rainy day exclusive activities
        specialActivities = [];
        rainyDayActivities = [];
        
        allActivities.forEach(s => {
            // ★ FIX: Validate each activity on load (this now adds type:'Special')
            const validated = validateSpecialActivity(s, s?.name);
            
            // Also support legacy property name from daily_adjustments.js
            if (validated.rainyDayOnly === true) {
                validated.rainyDayExclusive = true;
            }
            
            // Separate into appropriate list
            if (validated.rainyDayExclusive) {
                rainyDayActivities.push(validated);
            } else {
                specialActivities.push(validated);
            }
        });
        
        console.log("[SPECIAL_ACTIVITIES] Data loaded:", {
            specials: specialActivities.length,
            rainyDay: rainyDayActivities.length,
            rainyDayNames: rainyDayActivities.map(s => s.name)
        });
    } catch (e) {
        console.error("[SPECIAL_ACTIVITIES] Error loading data:", e);
        specialActivities = [];
        rainyDayActivities = [];
    }
}

/**
 * Refresh data from storage (call when tab becomes visible or after cloud sync)
 */
function refreshFromStorage() {
    // ★ FIX: Store previous state for proper comparison
    const previousSpecialsJson = JSON.stringify(specialActivities);
    const previousRainyJson = JSON.stringify(rainyDayActivities);
    const previousSelected = selectedItemId;
    
    loadData();
    
    // If selected item no longer exists, clear selection
    if (selectedItemId) {
        const [, name] = selectedItemId.split(/-(.+)/);
        const exists = specialActivities.some(s => s.name === name) || 
                       rainyDayActivities.some(s => s.name === name);
        if (!exists) {
            selectedItemId = null;
        }
    }
    
    // ★ FIX: Compare actual content, not just counts
    const newSpecialsJson = JSON.stringify(specialActivities);
    const newRainyJson = JSON.stringify(rainyDayActivities);
    const dataChanged = previousSpecialsJson !== newSpecialsJson || 
                        previousRainyJson !== newRainyJson ||
                        previousSelected !== selectedItemId;
    
    if (dataChanged) {
        console.log("[SPECIAL_ACTIVITIES] Data changed - re-rendering UI");
        if (specialsListEl) renderMasterList();
        if (rainyDayListEl) renderRainyDayList();
        if (detailPaneEl) renderDetailPane();
    } else {
        console.log("[SPECIAL_ACTIVITIES] Data unchanged - skipping re-render");
    }
}

/**
 * Save data to persisted storage and queue for cloud sync
 * ★ Uses saveGlobalSpecialActivities which handles cloud sync
 */
function saveData() {
    // ✅ RBAC Check for modifications
    if (window.AccessControl?.canEditSetup && !window.AccessControl.canEditSetup()) {
        console.warn('[SPECIAL_ACTIVITIES] Save blocked - insufficient permissions');
        return;
    }
    
    try {
        // ★ Validate before saving
        const validatedSpecials = validateAllActivities(specialActivities);
        const validatedRainy = validateAllActivities(rainyDayActivities);
        
        // Update internal state with validated data
        specialActivities = validatedSpecials;
        rainyDayActivities = validatedRainy;
        
        // Combine both lists for saving
        const allActivities = [...specialActivities, ...rainyDayActivities];
        window.saveGlobalSpecialActivities?.(allActivities);
        
        // ⭐ Trigger cloud sync to ensure data persists
        if (typeof window.forceSyncToCloud === 'function') {
            // Use a slight delay to batch multiple rapid saves
            if (window._specialActivitiesSyncTimeout) {
                clearTimeout(window._specialActivitiesSyncTimeout);
            }
            window._specialActivitiesSyncTimeout = setTimeout(() => {
                window.forceSyncToCloud();
                window._specialActivitiesSyncTimeout = null;
            }, 500);
        }
    } catch (e) {
        console.error("[SPECIAL_ACTIVITIES] Error saving data:", e);
    }
}

// =========================================================================
// LEFT LIST (Master List)
// =========================================================================
function renderMasterList() {
    if (!specialsListEl) return;
    
    specialsListEl.innerHTML = "";
    
    if (specialActivities.length === 0) {
        specialsListEl.innerHTML = `<div style="padding:20px; text-align:center; color:#9CA3AF;">No special activities yet.</div>`;
        return;
    }
    
    specialActivities.forEach(item => {
        specialsListEl.appendChild(createMasterListItem(item, false));
    });
}

function renderRainyDayList() {
    if (!rainyDayListEl) return;
    
    rainyDayListEl.innerHTML = "";
    
    if (rainyDayActivities.length === 0) {
        rainyDayListEl.innerHTML = `<div style="padding:16px; text-align:center; color:#0369a1; font-size:0.85rem;">
            <span style="font-size:1.5rem;">☔</span><br>
            No rainy day activities yet.<br>
            <span style="font-size:0.75rem; opacity:0.7;">Add activities that only appear during rainy days.</span>
        </div>`;
        return;
    }
    
    rainyDayActivities.forEach(item => {
        rainyDayListEl.appendChild(createMasterListItem(item, true));
    });
}

function createMasterListItem(item, isRainyDay = false) {
    if (!item || !item.name) return document.createElement('div');
    
    const id = `special-${item.name}`;
    const el = document.createElement("div");
    el.className = "list-item" + (id === selectedItemId ? " selected" : "");
    el.onclick = () => { 
        selectedItemId = id; 
        renderMasterList(); 
        renderRainyDayList();
        renderDetailPane(); 
    };

    const infoDiv = document.createElement("div");
    
    const nameEl = document.createElement("div");
    nameEl.className = "list-item-name";
    nameEl.textContent = item.name; // ★ FIX: Use textContent for safety

    // Add rainy day badge for rainy exclusive items
    if (isRainyDay) {
        const badge = document.createElement("span");
        badge.className = "rainy-badge";
        badge.textContent = "🌧️ Rainy Only";
        nameEl.appendChild(badge);
    } else {
        // ★ v2.3: Add indoor/outdoor badge for regular specials
        const weatherBadge = document.createElement("span");
        weatherBadge.className = `weather-badge ${item.isIndoor ? 'indoor' : 'outdoor'}`;
        weatherBadge.textContent = item.isIndoor ? '🏠' : '🌳';
        nameEl.appendChild(weatherBadge);
    }

    infoDiv.appendChild(nameEl);
    el.appendChild(infoDiv);

    // Toggle Switch
    const tog = document.createElement("label");
    tog.className = "switch";
    tog.onclick = e => e.stopPropagation();

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = item.available;
    cb.onchange = () => { 
        item.available = cb.checked; 
        saveData(); 
        renderDetailPane(); 
    };

    const slider = document.createElement("span");
    slider.className = "slider";
    tog.appendChild(cb);
    tog.appendChild(slider);
    el.appendChild(tog);

    return el;
}

// =========================================================================
// RIGHT PANEL — APPLE STYLE COLLAPSIBLE SECTIONS
// =========================================================================
function renderDetailPane() {
    if (!detailPaneEl) return;
    
    if (!selectedItemId) {
        detailPaneEl.innerHTML = `
            <div style="height:300px; display:flex; align-items:center; justify-content:center; color:#9CA3AF; border:1px dashed #E5E7EB; border-radius:12px;">
                Select a special to edit details
            </div>`;
        return;
    }

    const [, name] = selectedItemId.split(/-(.+)/);
    if (!name) {
        detailPaneEl.innerHTML = `<p class='muted'>Invalid selection.</p>`;
        selectedItemId = null;
        return;
    }
    
    // Search in both regular and rainy day activities
    let item = specialActivities.find(s => s.name === name);
    let isRainyDayItem = false;
    
    if (!item) {
        item = rainyDayActivities.find(s => s.name === name);
        isRainyDayItem = true;
    }
    
    if (!item) {
        detailPaneEl.innerHTML = `<p class='muted'>Not found.</p>`;
        selectedItemId = null;
        return;
    }

    detailPaneEl.innerHTML = "";

    // -- 1. HEADER (Title & Delete) --
    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.alignItems = "center";
    header.style.marginBottom = "16px";

    const titleContainer = document.createElement("div");
    titleContainer.style.display = "flex";
    titleContainer.style.alignItems = "center";
    titleContainer.style.gap = "10px";

    const title = document.createElement("h2");
    title.textContent = item.name;
    title.style.margin = "0";
    title.style.fontSize = "1.25rem";
    title.title = "Double click to rename";
    makeEditable(title, newName => {
        if (!newName.trim()) return;
        const oldName = item.name;
        if (oldName === newName) return;
        
        // ★ FIX: Check for duplicate names in both lists
        if (specialActivities.some(s => s !== item && s.name.toLowerCase() === newName.toLowerCase()) ||
            rainyDayActivities.some(s => s !== item && s.name.toLowerCase() === newName.toLowerCase())) {
            alert(`A special activity named "${newName}" already exists.`);
            return;
        }
        
        item.name = newName;
        selectedItemId = `special-${newName}`;
        
        // ★ FIX: Propagate rename to schedules (like fields.js does)
        propagateSpecialActivityRename(oldName, newName);
        
        saveData();
        renderMasterList();
        renderRainyDayList();
        renderDetailPane();
    });
    titleContainer.appendChild(title);

    // Add rainy day badge in detail pane header
    if (isRainyDayItem) {
        const badge = document.createElement("span");
        badge.style.cssText = "display:inline-flex; align-items:center; gap:4px; padding:4px 10px; background:linear-gradient(135deg, #0ea5e9, #0284c7); color:white; border-radius:999px; font-size:0.75rem; font-weight:600;";
        badge.textContent = "🌧️ Rainy Day Only";
        titleContainer.appendChild(badge);
    }

    const delBtn = document.createElement("button");
    delBtn.innerHTML = `
        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
        </svg> Delete`;
    delBtn.style.color = "#DC2626";
    delBtn.style.background = "#FEF2F2";
    delBtn.style.border = "1px solid #FECACA";
    delBtn.style.padding = "6px 12px";
    delBtn.style.borderRadius = "6px";
    delBtn.style.cursor = "pointer";
    delBtn.style.display = "flex";
    delBtn.style.gap = "6px";
    delBtn.style.alignItems = "center";
    delBtn.onclick = () => {
        // ✅ RBAC Check
        if (window.AccessControl?.canEraseData && !window.AccessControl.canEraseData()) {
            window.AccessControl?.showPermissionDenied?.('delete special activities');
            return;
        }
        if (!window.AccessControl?.checkSetupAccess?.('delete special activities')) return;

        if (confirm(`Delete "${escapeHtml(item.name)}"?\n\nThis will also remove references from all schedules.`)) {
            const deletedName = item.name;
            
            // ★ FIX: Cleanup before removing (like fields.js)
            cleanupDeletedSpecialActivity(deletedName);
            
            if (isRainyDayItem) {
                rainyDayActivities = rainyDayActivities.filter(s => s.name !== item.name);
            } else {
                specialActivities = specialActivities.filter(s => s.name !== item.name);
            }
            saveData();
            selectedItemId = null;
            renderMasterList();
            renderRainyDayList();
            renderDetailPane();
        }
    };

    header.appendChild(titleContainer);
    header.appendChild(delBtn);
    detailPaneEl.appendChild(header);

    // -- 2. COLLAPSIBLE SECTIONS --
    // ★ v2.3: Added Weather & Availability section (only for regular specials, not rainy-day-only)
    const sections = [
        { title: "Field / Location", summary: summaryLocation(item), render: () => renderLocationSettings(item) },
        { title: "Sharing Rules", summary: summarySharing(item), render: () => renderSharing(item) },
        { title: "Division Access", summary: summaryAccess(item), render: () => renderAccess(item) },
        { title: "Time Availability", summary: summaryTime(item), render: () => renderTimeRules(item) }
    ];
    
    // Add Weather section only for regular specials (not rainy-day-exclusive ones)
    if (!isRainyDayItem) {
        sections.push({ 
            title: "Weather & Availability", 
            summary: summaryWeather(item), 
            render: () => renderWeatherSettings(item) 
        });
    }

    sections.forEach(sec => {
        const section = document.createElement("div");
        section.className = "detail-section";

        const hdr = document.createElement("div");
        hdr.className = "detail-section-header";
        hdr.innerHTML = `<div>
            <div class="detail-section-title">${escapeHtml(sec.title)}</div>
            <div class="detail-section-summary">${escapeHtml(sec.summary)}</div>
        </div>
        <span style="font-size:1rem;">▸</span>`;

        const body = document.createElement("div");
        body.className = "detail-section-body";
        body.appendChild(sec.render());

        hdr.onclick = () => {
            const isOpen = body.style.display === "block";
            body.style.display = isOpen ? "none" : "block";
            hdr.querySelector("span").textContent = isOpen ? "▸" : "▾";
        };

        section.appendChild(hdr);
        section.appendChild(body);
        detailPaneEl.appendChild(section);
    });
}

// =========================================================================
// SUMMARIES
// =========================================================================
function summarySharing(item) { 
    if (!item.sharableWith || item.sharableWith.type === 'not_sharable') return "No sharing (1 bunk only)";
    const cap = parseInt(item.sharableWith.capacity, 10) || 2;
    return `Up to ${cap} bunks (same grade)`; 
}

function summaryAccess(item) {
    if (!item.limitUsage || !item.limitUsage.enabled) return "Open to all grades";
    const allowedCount = Object.keys(item.limitUsage.divisions || {}).length;
    if (allowedCount === 0) return "⚠ Restricted (none selected)";
    const pStr = item.limitUsage.usePriority ? " · prioritized" : "";
    return `${allowedCount} grade${allowedCount !== 1 ? 's' : ''} allowed${pStr}`;
}

function summaryTime(item) { 
    const count = (item.timeRules || []).length;
    return count ? `${count} rule(s) active` : "Available all day"; 
}

// ★ v2.3: Weather summary (matches fields.js pattern)
function summaryWeather(item) {
    return item.isIndoor ? "🏠 Indoor - Available on rainy days" : "🌳 Outdoor - Disabled on rainy days";
}

// ★ v2.5: Location summary
function summaryLocation(item) {
    return item.location ? `📍 ${item.location}` : "No field assigned";
}

// =========================================================================
// CONTENT RENDERERS
// =========================================================================

// 1. SHARING RULES
function renderSharing(item) {
    const container = document.createElement("div");

    const updateSummary = () => {
        const summaryEl = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if (summaryEl) summaryEl.textContent = summarySharing(item);
    };

    const renderContent = () => {
        container.innerHTML = "";

        const rules = item.sharableWith || { type: 'not_sharable', divisions: [], capacity: 2 };

        // Mode Buttons
        const modeWrap = document.createElement("div");
        modeWrap.style.display = "flex";
        modeWrap.style.gap = "12px";
        modeWrap.style.marginBottom = "16px";

        const btnNot = document.createElement("button");
        btnNot.textContent = "Not Sharable";
        btnNot.style.cssText = `flex:1; padding:8px; border-radius:6px; border:1px solid #E5E7EB; cursor:pointer; background:${rules.type === 'not_sharable' ? '#ECFDF5' : '#fff'}; color:${rules.type === 'not_sharable' ? '#047857' : '#333'}; border-color:${rules.type === 'not_sharable' ? '#10B981' : '#E5E7EB'}; font-weight:${rules.type === 'not_sharable' ? '600' : '400'}; transition:all 0.2s;`;

        const btnSha = document.createElement("button");
        btnSha.textContent = "Sharable";
        btnSha.style.cssText = `flex:1; padding:8px; border-radius:6px; border:1px solid #E5E7EB; cursor:pointer; background:${rules.type !== 'not_sharable' ? '#ECFDF5' : '#fff'}; color:${rules.type !== 'not_sharable' ? '#047857' : '#333'}; border-color:${rules.type !== 'not_sharable' ? '#10B981' : '#E5E7EB'}; font-weight:${rules.type !== 'not_sharable' ? '600' : '400'}; transition:all 0.2s;`;

        btnNot.onclick = () => { 
            rules.type = 'not_sharable'; 
            rules.divisions = [];
            saveData(); 
            renderContent(); 
            updateSummary(); 
        };
        btnSha.onclick = () => { 
            rules.type = 'custom'; 
            saveData(); 
            renderContent(); 
            updateSummary(); 
        };

        modeWrap.appendChild(btnNot);
        modeWrap.appendChild(btnSha);
        container.appendChild(modeWrap);

        // Detail if Sharable
        if (rules.type !== 'not_sharable') {
            const det = document.createElement("div");
            det.style.background = "#F9FAFB";
            det.style.padding = "12px";
            det.style.borderRadius = "8px";

            // Capacity
            const capRow = document.createElement("div");
            capRow.style.marginBottom = "12px";
            capRow.innerHTML = `<label style="font-size:0.85rem;font-weight:500;">Max Groups at Once</label>`;
            const capIn = document.createElement("input");
            capIn.type = "number";
            capIn.min = "2";
            capIn.max = "99";
            capIn.value = parseInt(rules.capacity, 10) || 2;
            capIn.style.cssText = "width:60px; padding:6px; margin-left:8px; border:1px solid #E5E7EB; border-radius:4px;";
            capIn.onchange = () => { 
                rules.capacity = Math.max(2, parseInt(capIn.value, 10) || 2); 
                saveData(); 
                updateSummary(); 
            };
            capRow.appendChild(capIn);
            det.appendChild(capRow);

            // Division Chips
            const chipLabel = document.createElement("div");
            chipLabel.textContent = "Limit to Divisions (optional):";
            chipLabel.style.fontSize = "0.85rem";
            chipLabel.style.fontWeight = "500";
            chipLabel.style.marginBottom = "6px";
            det.appendChild(chipLabel);

            const chipWrap = document.createElement("div");
            const availableDivisions = window.availableDivisions || Object.keys(window.divisions || {});
            availableDivisions.forEach(d => {
                const isActive = rules.divisions.includes(d);
                const chip = document.createElement("span");
                chip.className = "chip " + (isActive ? "active" : "inactive");
                chip.textContent = d;
                chip.onclick = () => {
                    if (isActive) {
                        rules.divisions = rules.divisions.filter(x => x !== d);
                    } else {
                        rules.divisions.push(d);
                    }
                    rules.type = rules.divisions.length > 0 ? 'custom' : 'all';
                    saveData();
                    chip.className = "chip " + (rules.divisions.includes(d) ? "active" : "inactive");
                };
                chipWrap.appendChild(chip);
            });
            det.appendChild(chipWrap);
            container.appendChild(det);
        }
    };

    renderContent();
    return container;
}

// 2. ACCESS & RESTRICTIONS
function renderAccess(item) {
    const container = document.createElement("div");

    const updateSummary = () => {
        const summaryEl = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if (summaryEl) summaryEl.textContent = summaryAccess(item);
    };

    const renderContent = () => {
        container.innerHTML = "";

        const rules = item.limitUsage || { enabled: false, divisions: {}, priorityList: [] };
        // ★ FIX: Ensure priorityList exists
        if (!rules.priorityList) {
            rules.priorityList = Object.keys(rules.divisions || {});
        }

        // Toggle Mode Buttons
        const modeWrap = document.createElement("div");
        modeWrap.style.display = "flex";
        modeWrap.style.gap = "12px";
        modeWrap.style.marginBottom = "16px";

        const btnAll = document.createElement("button");
        btnAll.textContent = "Open to All";
        btnAll.style.cssText = `flex:1; padding:8px; border-radius:6px; border:1px solid #E5E7EB; cursor:pointer; background:${!rules.enabled ? '#ECFDF5' : '#fff'}; color:${!rules.enabled ? '#047857' : '#333'}; border-color:${!rules.enabled ? '#10B981' : '#E5E7EB'}; font-weight:${!rules.enabled ? '600' : '400'}; transition:all 0.2s;`;

        const btnRes = document.createElement("button");
        btnRes.textContent = "Restricted";
        btnRes.style.cssText = `flex:1; padding:8px; border-radius:6px; border:1px solid #E5E7EB; cursor:pointer; background:${rules.enabled ? '#ECFDF5' : '#fff'}; color:${rules.enabled ? '#047857' : '#333'}; border-color:${rules.enabled ? '#10B981' : '#E5E7EB'}; font-weight:${rules.enabled ? '600' : '400'}; transition:all 0.2s;`;

        btnAll.onclick = () => { 
            rules.enabled = false; 
            item.limitUsage = rules;
            saveData(); 
            renderContent(); 
            updateSummary(); 
        };
        btnRes.onclick = () => { 
            rules.enabled = true; 
            item.limitUsage = rules;
            saveData(); 
            renderContent(); 
            updateSummary(); 
        };

        modeWrap.appendChild(btnAll);
        modeWrap.appendChild(btnRes);
        container.appendChild(modeWrap);

        // Restricted Details
        if (rules.enabled) {
            const body = document.createElement("div");
            body.style.background = "#F9FAFB";
            body.style.padding = "12px";
            body.style.borderRadius = "8px";

            // Priority List
            const listContainer = document.createElement("div");
            listContainer.style.marginBottom = "16px";

            if (rules.priorityList.length === 0) {
                listContainer.innerHTML = `<div style="color:#9CA3AF; font-style:italic; font-size:0.85rem;">Click divisions below to allow access.</div>`;
            }

            rules.priorityList.forEach((divName, idx) => {
                const row = document.createElement("div");
                row.style.cssText = "display:flex; align-items:center; justify-content:space-between; padding:8px 10px; background:white; border:1px solid #E5E7EB; border-radius:6px; margin-bottom:6px;";
                row.innerHTML = `<span style="font-weight:bold; color:#10B981; width:20px;">${idx + 1}</span> <span style="flex:1;">${escapeHtml(divName)}</span>`;

                const ctrls = document.createElement("div");
                ctrls.style.display = "flex";
                ctrls.style.gap = "4px";

                const mkBtn = (txt, fn, dis) => {
                    const b = document.createElement("button");
                    b.style.cssText = "padding:4px 8px; border:1px solid #E5E7EB; border-radius:4px; background:white; cursor:pointer; font-size:0.8rem;";
                    b.textContent = txt;
                    if (dis) {
                        b.disabled = true;
                        b.style.opacity = "0.5";
                        b.style.cursor = "not-allowed";
                    } else {
                        b.onclick = fn;
                    }
                    return b;
                };

                ctrls.appendChild(mkBtn("↑", () => {
                    [rules.priorityList[idx - 1], rules.priorityList[idx]] = [rules.priorityList[idx], rules.priorityList[idx - 1]];
                    saveData();
                    renderContent();
                }, idx === 0));

                ctrls.appendChild(mkBtn("↓", () => {
                    [rules.priorityList[idx + 1], rules.priorityList[idx]] = [rules.priorityList[idx], rules.priorityList[idx + 1]];
                    saveData();
                    renderContent();
                }, idx === rules.priorityList.length - 1));

                const rm = mkBtn("✕", () => {
                    rules.priorityList = rules.priorityList.filter(d => d !== divName);
                    delete rules.divisions[divName];
                    saveData();
                    renderContent();
                    updateSummary();
                }, false);
                rm.style.color = "#DC2626";
                rm.style.borderColor = "#FECACA";
                ctrls.appendChild(rm);

                row.appendChild(ctrls);
                listContainer.appendChild(row);
            });

            body.appendChild(listContainer);

            // Division Selector Chips
            const divHeader = document.createElement("div");
            divHeader.textContent = "Allowed Divisions (Click to add/remove):";
            divHeader.style.fontSize = "0.85rem";
            divHeader.style.fontWeight = "600";
            divHeader.style.marginTop = "16px";
            divHeader.style.marginBottom = "6px";
            body.appendChild(divHeader);

            const chipWrap = document.createElement("div");
            const availableDivisions = window.availableDivisions || Object.keys(window.divisions || {});

            availableDivisions.forEach(divName => {
                const isAllowed = divName in rules.divisions;
                const c = document.createElement("span");
                c.className = "chip " + (isAllowed ? "active" : "inactive");
                c.textContent = divName;
                c.onclick = () => {
                    if (isAllowed) {
                        delete rules.divisions[divName];
                        rules.priorityList = rules.priorityList.filter(d => d !== divName);
                    } else {
                        rules.divisions[divName] = [];
                        if (!rules.priorityList.includes(divName)) rules.priorityList.push(divName);
                    }
                    saveData();
                    renderContent();
                    updateSummary();
                };
                chipWrap.appendChild(c);
            });

            body.appendChild(chipWrap);
            container.appendChild(body);
        }
    };

    renderContent();
    return container;
}

// 3. TIME RULES
function renderTimeRules(item) {
    const container = document.createElement("div");

    const updateSummary = () => {
        const summaryEl = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if (summaryEl) summaryEl.textContent = summaryTime(item);
    };

    const renderContent = () => {
        container.innerHTML = "";

        // Ensure timeRules is an array
        if (!Array.isArray(item.timeRules)) {
            item.timeRules = [];
        }

        // Existing Rules
        if (item.timeRules.length > 0) {
            item.timeRules.forEach((r, i) => {
                const row = document.createElement("div");
                row.style.display = "flex";
                row.style.justifyContent = "space-between";
                row.style.alignItems = "center";
                row.style.background = "#F9FAFB";
                row.style.padding = "8px";
                row.style.marginBottom = "6px";
                row.style.borderRadius = "6px";
                row.style.border = "1px solid #E5E7EB";

                const txt = document.createElement("span");
                const colorClass = r.type === 'Available' ? '#10B981' : '#DC2626';
                txt.innerHTML = `<strong style="color:${colorClass}">${escapeHtml(r.type)}</strong> ${escapeHtml(r.start)} - ${escapeHtml(r.end)}`;
                row.appendChild(txt);

                const delBtn = document.createElement("button");
                delBtn.textContent = "✕";
                delBtn.style.cssText = "background:none; border:none; color:#DC2626; cursor:pointer; font-size:1rem;";
                delBtn.onclick = () => {
                    item.timeRules.splice(i, 1);
                    saveData();
                    renderContent();
                    updateSummary();
                };
                row.appendChild(delBtn);

                container.appendChild(row);
            });
        }

        // Add New Rule
        const addRow = document.createElement("div");
        addRow.style.display = "flex";
        addRow.style.gap = "8px";
        addRow.style.alignItems = "center";
        addRow.style.flexWrap = "wrap";
        addRow.style.marginTop = "12px";

        const typeSel = document.createElement("select");
        typeSel.innerHTML = `<option value="Available">Available</option><option value="Unavailable">Unavailable</option>`;
        typeSel.style.cssText = "padding:6px; border:1px solid #E5E7EB; border-radius:4px;";

        const startIn = document.createElement("input");
        startIn.type = "text";
        startIn.placeholder = "9:00am";
        startIn.style.cssText = "width:80px; padding:6px; border:1px solid #E5E7EB; border-radius:4px;";

        const endIn = document.createElement("input");
        endIn.type = "text";
        endIn.placeholder = "10:00am";
        endIn.style.cssText = "width:80px; padding:6px; border:1px solid #E5E7EB; border-radius:4px;";

        const btn = document.createElement("button");
        btn.textContent = "+ Add";
        btn.style.cssText = "padding:6px 12px; background:#10B981; color:white; border:none; border-radius:4px; cursor:pointer;";
        btn.onclick = () => {
            if (!startIn.value.trim() || !endIn.value.trim()) {
                alert("Please enter both start and end times.");
                return;
            }
            const startMin = parseTimeToMinutes(startIn.value);
            const endMin = parseTimeToMinutes(endIn.value);
            if (startMin === null) {
                alert("Invalid Start Time format. Use format like 9:00am");
                return;
            }
            if (endMin === null) {
                alert("Invalid End Time format. Use format like 10:00am");
                return;
            }
            if (startMin >= endMin) {
                alert("End time must be after start time.");
                return;
            }
            item.timeRules.push({
                type: typeSel.value,
                start: startIn.value,
                end: endIn.value,
                startMin: startMin,
                endMin: endMin
            });
            saveData();
            renderContent();
            updateSummary();
        };

        addRow.appendChild(typeSel);
        addRow.appendChild(startIn);
        addRow.appendChild(document.createTextNode(" to "));
        addRow.appendChild(endIn);
        addRow.appendChild(btn);

        container.appendChild(addRow);
    };

    renderContent();
    return container;
}
// ★ v2.5: FIELD / LOCATION ASSIGNMENT
function renderLocationSettings(item) {
    const container = document.createElement("div");
    
    const updateSummary = () => {
        const summaryEl = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if (summaryEl) summaryEl.textContent = summaryLocation(item);
    };
    
    const renderContent = () => {
        container.innerHTML = "";
        
        // Description
        const desc = document.createElement("p");
        desc.style.cssText = "font-size:0.85rem; color:#6b7280; margin:0 0 12px 0;";
        desc.textContent = "Assign a field or facility where this activity takes place. When scheduled, that field will be locked so no other activity can use it at the same time.";
        container.appendChild(desc);
        
        // Current assignment display
        if (item.location) {
            const current = document.createElement("div");
            current.style.cssText = "display:flex; align-items:center; gap:10px; padding:12px; background:#f0fdf4; border:1px solid #bbf7d0; border-radius:10px; margin-bottom:12px;";
            current.innerHTML = `
                <span style="font-size:24px;">📍</span>
                <div style="flex:1;">
                    <div style="font-weight:600; color:#065f46;">${escapeHtml(item.location)}</div>
                    <div style="font-size:0.8rem; color:#047857;">Field will be locked when this activity is scheduled</div>
                </div>
            `;
            const clearBtn = document.createElement("button");
            clearBtn.textContent = "✕ Remove";
            clearBtn.style.cssText = "padding:4px 10px; background:#fef2f2; color:#dc2626; border:1px solid #fecaca; border-radius:6px; cursor:pointer; font-size:0.8rem;";
            clearBtn.onclick = () => {
                item.location = null;
                saveData();
                renderContent();
                updateSummary();
                renderMasterList();
            };
            current.appendChild(clearBtn);
            container.appendChild(current);
        }
        
        // Field picker
        const pickerLabel = document.createElement("div");
        pickerLabel.style.cssText = "font-size:0.85rem; font-weight:500; margin-bottom:6px;";
        pickerLabel.textContent = item.location ? "Change field:" : "Select a field:";
        container.appendChild(pickerLabel);
        
        const select = document.createElement("select");
        select.style.cssText = "width:100%; padding:8px 10px; border:1px solid #E5E7EB; border-radius:8px; font-size:0.9rem; background:white; cursor:pointer;";
        
        // Default option
        const defaultOpt = document.createElement("option");
        defaultOpt.value = "";
        defaultOpt.textContent = "-- None (no field assigned) --";
        select.appendChild(defaultOpt);
        
        // Fields group
        const allFields = window.getFields?.() || [];
        if (allFields.length > 0) {
            const fieldGroup = document.createElement("optgroup");
            fieldGroup.label = "\u{1F3DF}\uFE0F Fields";
            allFields.sort((a, b) => a.name.localeCompare(b.name)).forEach(field => {
                if (!field.name) return;
                const opt = document.createElement("option");
                opt.value = field.name;
                opt.textContent = field.name + (field.rainyDayAvailable ? ' \u{1F3E0}' : '');
                if (item.location === field.name) opt.selected = true;
                fieldGroup.appendChild(opt);
            });
            select.appendChild(fieldGroup);
        }
        
        // Facilities group (from locations/zones)
        const settings = window.loadGlobalSettings?.() || {};
        const zones = settings.locationZones || {};
        const facilities = [];
        Object.entries(zones).forEach(([zoneName, zone]) => {
            if (!zone || typeof zone !== 'object') return;
            Object.keys(zone.locations || {}).forEach(locName => {
                facilities.push({ name: locName, zone: zoneName });
            });
        });
        
        if (facilities.length > 0) {
            const facGroup = document.createElement("optgroup");
            facGroup.label = "\u{1F3E2} Facilities";
            facilities.sort((a, b) => a.name.localeCompare(b.name)).forEach(fac => {
                const opt = document.createElement("option");
                opt.value = fac.name;
                opt.textContent = `${fac.name} (${fac.zone})`;
                if (item.location === fac.name) opt.selected = true;
                facGroup.appendChild(opt);
            });
            select.appendChild(facGroup);
        }
        
        select.onchange = () => {
            item.location = select.value || null;
            saveData();
            renderContent();
            updateSummary();
            renderMasterList();
        };
        
        container.appendChild(select);
        
        // Info box
        const infoBox = document.createElement("div");
        infoBox.style.cssText = "background:#f9fafb; border-radius:8px; padding:12px; font-size:0.85rem; color:#4b5563; margin-top:12px;";
        infoBox.innerHTML = `<strong>\u{1F4A1} How it works:</strong> When the scheduler assigns this special activity to a bunk, 
            the selected field will be automatically locked via Global Field Locks. 
            No other sport or activity can use that field during the same time slots.`;
        container.appendChild(infoBox);
    };
    
    renderContent();
    return container;
}


// ★ v2.3: 4. WEATHER & AVAILABILITY (matches fields.js pattern)
function renderWeatherSettings(item) {
    const container = document.createElement("div");
    
    const isIndoor = item.isIndoor === true;
    
    const updateSummary = () => {
        const summaryEl = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if (summaryEl) summaryEl.textContent = summaryWeather(item);
    };
    
    container.innerHTML = `
        <div style="margin-bottom: 16px;">
            <p style="font-size: 0.85rem; color: #6b7280; margin: 0 0 12px 0;">
                Mark this special activity as indoor to keep it available during Rainy Day Mode.
                Outdoor activities will be automatically disabled when rainy weather is activated.
            </p>
            
            <div style="display: flex; align-items: center; gap: 12px; padding: 14px; 
                        background: ${isIndoor ? '#ecfdf5' : '#fef3c7'}; 
                        border: 1px solid ${isIndoor ? '#a7f3d0' : '#fcd34d'};
                        border-radius: 10px; transition: all 0.2s ease;">
                <span style="font-size: 28px;">${isIndoor ? '🏠' : '🌳'}</span>
                <div style="flex: 1;">
                    <div style="font-weight: 600; color: ${isIndoor ? '#065f46' : '#92400e'};">
                        ${isIndoor ? 'Indoor Activity' : 'Outdoor Activity'}
                    </div>
                    <div style="font-size: 0.85rem; color: ${isIndoor ? '#047857' : '#b45309'};">
                        ${isIndoor ? 'Available on rainy days' : 'Disabled during rainy days'}
                    </div>
                </div>
                <label class="switch">
                    <input type="checkbox" id="weather-toggle" ${isIndoor ? 'checked' : ''}>
                    <span class="slider"></span>
                </label>
            </div>
        </div>
        
        <div style="background: #f9fafb; border-radius: 8px; padding: 12px; font-size: 0.85rem; color: #4b5563;">
            <strong>💡 Tip:</strong> Indoor activities like arts & crafts, canteen, game rooms, and 
            indoor sports should be marked as indoor. Outdoor activities like nature walks, 
            outdoor adventure courses, and field activities should remain as outdoor.
        </div>
    `;
    
    // Bind toggle
    const toggle = container.querySelector('#weather-toggle');
    if (toggle) {
        toggle.onchange = function() {
            item.isIndoor = this.checked;
            // Keep legacy properties in sync
            item.rainyDayAvailable = this.checked;
            item.availableOnRainyDay = this.checked;
            saveData();

            // Update the parent container to reflect the change
            const parentContainer = container.parentElement;
            if (parentContainer) {
                parentContainer.innerHTML = '';
                parentContainer.appendChild(renderWeatherSettings(item));
            }

            // Update summary
            updateSummary();
            
            // Update master list to show new badge
            renderMasterList();
        };
    }
    
    return container;
}

// =========================================================================
// ADD SPECIAL
// =========================================================================
function addSpecial() {
    // ✅ RBAC Check
    if (!window.AccessControl?.checkSetupAccess?.('add special activities')) return;
    
    if (!addSpecialInput) return;
    
    const n = addSpecialInput.value.trim();
    if (!n) return;

    // Check both lists for name conflicts
    if (specialActivities.some(s => s.name.toLowerCase() === n.toLowerCase()) ||
        rainyDayActivities.some(s => s.name.toLowerCase() === n.toLowerCase())) {
        alert("A special activity with that name already exists.");
        return;
    }

    specialActivities.push(createDefaultActivity(n));

    addSpecialInput.value = "";
    saveData();
    selectedItemId = `special-${n}`;
    renderMasterList();
    renderRainyDayList();
    renderDetailPane();
}

// =========================================================================
// ADD RAINY DAY ACTIVITY
// =========================================================================
function addRainyDayActivity() {
    // ✅ RBAC Check
    if (!window.AccessControl?.checkSetupAccess?.('add rainy day activities')) return;
    
    if (!addRainyDayInput) return;
    
    const n = addRainyDayInput.value.trim();
    if (!n) return;

    // Check both lists for name conflicts
    if (specialActivities.some(s => s.name.toLowerCase() === n.toLowerCase()) ||
        rainyDayActivities.some(s => s.name.toLowerCase() === n.toLowerCase())) {
        alert("A special activity with that name already exists.");
        return;
    }

    const newActivity = createDefaultActivity(n);
    newActivity.rainyDayExclusive = true;
    newActivity.rainyDayOnly = true; // Legacy support
    newActivity.isIndoor = true; // Rainy day activities are always indoor
    rainyDayActivities.push(newActivity);

    addRainyDayInput.value = "";
    saveData();
    selectedItemId = `special-${n}`;
    renderMasterList();
    renderRainyDayList();
    renderDetailPane();
}

// =========================================================================
// ★ CLEANUP & RENAME HELPERS (like fields.js)
// =========================================================================

/**
 * Cleanup all references to a deleted special activity
 */
function cleanupDeletedSpecialActivity(activityName) {
    if (!activityName) return;
    
    console.log(`🗑️ [SPECIAL_ACTIVITIES] Cleaning up references to: "${activityName}"`);
    let cleanupCount = 0;
    
    try {
        // 1. Clean from daily schedules
        const settings = window.loadGlobalSettings?.() || {};
        const dailySchedules = settings.daily_schedules || {};
        
        Object.keys(dailySchedules).forEach(dateKey => {
            const dayData = dailySchedules[dateKey];
            if (!dayData?.scheduleAssignments) return;
            
            Object.keys(dayData.scheduleAssignments).forEach(bunkKey => {
                const slots = dayData.scheduleAssignments[bunkKey];
                if (!Array.isArray(slots)) return;
                
                slots.forEach((slot, idx) => {
                    if (slot?._activity === activityName || 
                        slot?.activity === activityName ||
                        slot?.event === activityName) {
                        dayData.scheduleAssignments[bunkKey][idx] = null;
                        cleanupCount++;
                    }
                });
            });
        });
        
        if (cleanupCount > 0) {
            window.saveGlobalSettings?.('daily_schedules', dailySchedules);
            console.log(`   ✅ Cleared ${cleanupCount} schedule references`);
        }
        
        // 2. Clean from current session
        if (window.scheduleAssignments) {
            Object.keys(window.scheduleAssignments).forEach(bunkKey => {
                const slots = window.scheduleAssignments[bunkKey];
                if (!Array.isArray(slots)) return;
                
                slots.forEach((slot, idx) => {
                    if (slot?._activity === activityName || 
                        slot?.activity === activityName ||
                        slot?.event === activityName) {
                        window.scheduleAssignments[bunkKey][idx] = null;
                    }
                });
            });
        }
        
        // 3. Clean from activityProperties
        if (window.activityProperties?.[activityName]) {
            delete window.activityProperties[activityName];
            console.log(`   ✅ Removed from activityProperties`);
        }
        
        console.log(`🗑️ [SPECIAL_ACTIVITIES] Cleanup complete for "${activityName}"`);
        
    } catch (e) {
        console.error('[SPECIAL_ACTIVITIES] Error during cleanup:', e);
    }
}

/**
 * Propagate special activity rename to all references
 */
function propagateSpecialActivityRename(oldName, newName) {
    if (!oldName || !newName || oldName === newName) return;
    
    console.log(`📝 [SPECIAL_ACTIVITIES] Propagating rename: "${oldName}" → "${newName}"`);
    
    try {
        // 1. Update daily schedules
        const settings = window.loadGlobalSettings?.() || {};
        const dailySchedules = settings.daily_schedules || {};
        let updateCount = 0;
        
        Object.keys(dailySchedules).forEach(dateKey => {
            const dayData = dailySchedules[dateKey];
            if (!dayData?.scheduleAssignments) return;
            
            Object.keys(dayData.scheduleAssignments).forEach(bunkKey => {
                const slots = dayData.scheduleAssignments[bunkKey];
                if (!Array.isArray(slots)) return;
                
                slots.forEach((slot, idx) => {
                    if (slot?._activity === oldName) {
                        dayData.scheduleAssignments[bunkKey][idx]._activity = newName;
                        updateCount++;
                    }
                    if (slot?.activity === oldName) {
                        dayData.scheduleAssignments[bunkKey][idx].activity = newName;
                        updateCount++;
                    }
                    if (slot?.event === oldName) {
                        dayData.scheduleAssignments[bunkKey][idx].event = newName;
                        updateCount++;
                    }
                });
            });
        });
        
        if (updateCount > 0) {
            window.saveGlobalSettings?.('daily_schedules', dailySchedules);
            console.log(`   ✅ Updated ${updateCount} schedule references`);
        }
        
        // 2. Update activityProperties
        if (window.activityProperties?.[oldName]) {
            window.activityProperties[newName] = {
                ...window.activityProperties[oldName]
            };
            delete window.activityProperties[oldName];
            console.log(`   ✅ Updated activityProperties`);
        }
        
        console.log(`📝 [SPECIAL_ACTIVITIES] Rename propagation complete`);
        
    } catch (e) {
        console.error('[SPECIAL_ACTIVITIES] Error during rename propagation:', e);
    }
}

// =========================================================================
// HELPERS
// =========================================================================
function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    const div = document.createElement("div");
    div.textContent = String(str);
    return div.innerHTML;
}

function makeEditable(el, save) {
    if (!el) return;
    
    el.ondblclick = () => {
        const inp = document.createElement("input");
        inp.value = el.textContent;
        inp.style.fontSize = "inherit";
        inp.style.fontWeight = "inherit";
        inp.style.border = "1px solid #10B981";
        inp.style.outline = "none";
        inp.style.borderRadius = "4px";
        inp.style.padding = "2px 6px";
        inp.style.width = Math.max(100, el.offsetWidth + 20) + "px";
        el.replaceWith(inp);
        inp.focus();
        inp.select();

        const finish = () => {
            const newVal = inp.value.trim();
            if (newVal && newVal !== el.textContent) {
                save(newVal);
            } else {
                if (inp.parentNode) inp.replaceWith(el);
            }
        };

        inp.onblur = finish;
        inp.onkeyup = e => {
            if (e.key === "Enter") finish();
            if (e.key === "Escape") { inp.replaceWith(el); }
        };
    };
}

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
        if (hh === 12) hh = mer === "am" ? 0 : 12;
        else if (mer === "pm") hh += 12;
    }
    return hh * 60 + mm;
}

// =========================================================================
// EXPORTS
// =========================================================================
window.initSpecialActivitiesTab = initSpecialActivitiesTab;

// ★ FIX: Export arrays via getters (not direct references which can become stale)
Object.defineProperty(window, 'specialActivities', {
    get: function() { return specialActivities; },
    set: function(val) { specialActivities = val; },
    configurable: true
});

Object.defineProperty(window, 'rainyDayActivities', {
    get: function() { return rainyDayActivities; },
    set: function(val) { rainyDayActivities = val; },
    configurable: true
});

// Export getters for external access
window.getSpecialActivities = function() {
    return [...specialActivities]; // Return copy to prevent external mutation
};

window.getRainyDayActivities = function() {
    return [...rainyDayActivities]; // Return copy
};

// ★ v2.4: Self-initializing getter - loads from storage if arrays are empty
window.getAllSpecialActivities = function() {
    // ★ v2.4 FIX: Auto-load from storage if arrays are empty
    if ((!specialActivities || specialActivities.length === 0) && 
        (!rainyDayActivities || rainyDayActivities.length === 0)) {
        console.log('[SPECIAL_ACTIVITIES] ⚠️ Arrays empty - auto-loading from storage...');
        const settings = window.loadGlobalSettings?.() || {};
        const allActivities = settings.specialActivities || settings.app1?.specialActivities || [];
        
        if (allActivities.length > 0) {
            specialActivities = [];
            rainyDayActivities = [];
            
            allActivities.forEach(s => {
                const validated = validateSpecialActivity(s, s?.name);
                if (validated.rainyDayExclusive || validated.rainyDayOnly) {
                    rainyDayActivities.push(validated);
                } else {
                    specialActivities.push(validated);
                }
            });
            console.log(`[SPECIAL_ACTIVITIES] ✅ Auto-loaded ${specialActivities.length} regular + ${rainyDayActivities.length} rainy-only`);
        }
    }
    
    const combined = [...specialActivities, ...rainyDayActivities];
    const rainyOnlyInCombined = combined.filter(s => s.rainyDayOnly || s.rainyDayExclusive);
    console.log(`[SPECIAL_ACTIVITIES] getAllSpecialActivities: Returning ${combined.length} total (${rainyOnlyInCombined.length} rainy-only)`);
    return combined;
};

window.getSpecialActivityByName = function(name) {
    if (!name) return null;
    const nameStr = String(name);
    let item = specialActivities.find(s => s.name === nameStr);
    if (!item) {
        item = rainyDayActivities.find(s => s.name === nameStr);
    }
    return item ? { ...item } : null; // Return copy
};

// =========================================================================
// ★★★ v2.1 RAINY DAY MODE EXPORTS ★★★
// =========================================================================

// Check if rainy day mode is active (for scheduler integration)
// ★★★ ENHANCED: Checks multiple flags for robustness ★★★
window.isRainyDayModeActive = function() {
    try {
        const dailyData = window.loadCurrentDailyData?.() || {};
        // Check multiple possible flags for rainy day mode
        return dailyData.rainyDayMode === true || 
               dailyData.isRainyDay === true ||
               window.isRainyDay === true;
    } catch (e) {
        return window.isRainyDay === true; // Fallback to global flag
    }
};

// Get available special activities based on weather
// ★★★ ENHANCED v2.3: Uses isIndoor property for filtering ★★★
window.getAvailableSpecialActivities = function() {
    const isRainy = window.isRainyDayModeActive?.() || false;

    if (isRainy) {
        // Rainy day: return indoor specials + rainy day exclusives
        const regularAvailable = specialActivities.filter(s => 
            s.available && s.isIndoor === true
        );
        const rainyAvailable = rainyDayActivities.filter(s => s.available);
        return [...regularAvailable, ...rainyAvailable];
    } else {
        // Normal day: return only regular specials (not rainy day exclusives)
        return specialActivities.filter(s => s.available);
    }
};

// ★★★ PRIMARY SCHEDULER FUNCTION - RAINY DAY FILTERED ★★★
// This is the main function the scheduler should use for getting specials
// ★★★ ENHANCED v2.3: Uses isIndoor property for filtering ★★★
window.getGlobalSpecialActivities = function(respectRainyDay = true) {
    // Get all activities from both lists
    const allActivities = [...specialActivities, ...rainyDayActivities];
    
    if (!respectRainyDay) {
        return allActivities;
    }
    
    const isRainyMode = window.isRainyDayModeActive?.() || window.isRainyDay === true;
    
    if (isRainyMode) {
        // Rainy day mode: 
        // - Include indoor regular specials
        // - Include rainy-day-only/exclusive specials
        console.log('[SpecialActivities] 🌧️ Rainy mode - filtering for indoor/rainy activities');
        return allActivities.filter(s => {
            // Include rainy-day-only activities
            if (s.rainyDayOnly === true || s.rainyDayExclusive === true) {
                return true;
            }
            // Include indoor activities
            if (s.isIndoor === true) {
                return true;
            }
            return false;
        });
    } else {
        // Normal day: exclude rainy-day-only activities
        console.log('[SpecialActivities] ☀️ Normal mode - excluding rainy-day-only activities');
        return allActivities.filter(s => 
            s.rainyDayOnly !== true && s.rainyDayExclusive !== true
        );
    }
};

// ★★★ GET RAINY-DAY-ONLY SPECIALS (for scheduler to add during rainy mode) ★★★
window.getRainyDayOnlySpecials = function() {
    return rainyDayActivities.filter(s => s.available !== false);
};

// ★★★ GET INDOOR-AVAILABLE SPECIALS (available regardless of weather) ★★★
// ★★★ ENHANCED v2.3: Uses isIndoor property ★★★
window.getIndoorAvailableSpecials = function() {
    return specialActivities.filter(s => 
        s.available !== false && s.isIndoor === true
    );
};

// ★★★ v2.3: GET OUTDOOR SPECIALS (disabled during rainy mode) ★★★
window.getOutdoorSpecials = function() {
    return specialActivities.filter(s => s.isIndoor !== true);
};

// ★ FIX: Export cleanup function for external use
window.cleanupSpecialActivitiesModule = function() {
    cleanupEventListeners();
    cleanupTabListeners();
    _isInitialized = false;
    console.log("[SPECIAL_ACTIVITIES] Module cleaned up");
};

// ★ NEW: Force refresh from cloud/storage
window.refreshSpecialActivitiesFromStorage = function() {
    if (_isInitialized) {
        refreshFromStorage();
    }
};

// ★ NEW: Validate special activities (can be called externally)
window.validateSpecialActivities = function() {
    const allActivities = window.getAllSpecialActivities?.() || [];
    const validated = validateAllActivities(allActivities);
    
    let issuesFixed = 0;
    allActivities.forEach((original, i) => {
        const fixed = validated[i];
        if (JSON.stringify(original) !== JSON.stringify(fixed)) {
            issuesFixed++;
        }
    });
    
    if (issuesFixed > 0) {
        console.log(`[SPECIAL_ACTIVITIES] Validation fixed ${issuesFixed} issues`);
        // Reload with validated data
        loadData();
        if (_isInitialized) {
            renderMasterList();
            renderRainyDayList();
            renderDetailPane();
        }
    }
    
    return { activitiesChecked: allActivities.length, issuesFixed };
};

// ★ COMPREHENSIVE DIAGNOSTICS (like fields.js)
window.diagnoseSpecialActivities = function() {
    console.log('\n' + '═'.repeat(60));
    console.log('🔍 SPECIAL ACTIVITIES DIAGNOSTICS');
    console.log('═'.repeat(60));
    
    const settings = window.loadGlobalSettings?.() || {};
    const storedActivities = settings.specialActivities || settings.app1?.specialActivities || [];
    const divisions = Object.keys(settings.divisions || {});
    
    // ★★★ v2.1: Add rainy day mode status ★★★
    const isRainyMode = window.isRainyDayModeActive?.() || false;
    
    // ★★★ v2.3: Add indoor/outdoor counts ★★★
    const indoorCount = specialActivities.filter(s => s.isIndoor === true).length;
    const outdoorCount = specialActivities.filter(s => s.isIndoor !== true).length;
    
    console.log(`\n📊 SUMMARY:`);
    console.log(`   Total activities: ${storedActivities.length}`);
    console.log(`   Regular specials: ${specialActivities.length}`);
    console.log(`      - Indoor: ${indoorCount}`);
    console.log(`      - Outdoor: ${outdoorCount}`);
    console.log(`   Rainy day specials: ${rainyDayActivities.length}`);
    console.log(`   Valid divisions: ${divisions.join(', ') || 'none'}`);
    console.log(`   🌧️ Rainy Day Mode: ${isRainyMode ? 'ACTIVE' : 'INACTIVE'}`);
    
    if (isRainyMode) {
        const availableNow = window.getGlobalSpecialActivities?.() || [];
        console.log(`   📋 Currently available specials: ${availableNow.length}`);
    }
    
    const issues = [];
    
    storedActivities.forEach((a, idx) => {
        const actIssues = [];
        
        // ★ v2.4: Check type property
        if (!a.type || a.type !== 'Special') {
            actIssues.push('Missing or incorrect type property (should be "Special")');
        }
        
        // Check sharableWith structure
        if (!a.sharableWith) {
            actIssues.push('Missing sharableWith');
        } else {
            if (!a.sharableWith.type) actIssues.push('sharableWith.type missing');
            if (!Array.isArray(a.sharableWith.divisions)) actIssues.push('sharableWith.divisions not array');
            if (a.sharableWith.capacity === undefined) actIssues.push('sharableWith.capacity missing');
            
            // Check for stale divisions
            if (Array.isArray(a.sharableWith.divisions)) {
                const stale = a.sharableWith.divisions.filter(d => !divisions.includes(d));
                if (stale.length > 0) actIssues.push(`Stale sharableWith.divisions: ${stale.join(', ')}`);
            }
        }
        
        // Check limitUsage structure
        if (!a.limitUsage) {
            actIssues.push('Missing limitUsage');
        } else {
            if (a.limitUsage.enabled === undefined) actIssues.push('limitUsage.enabled missing');
            if (typeof a.limitUsage.divisions !== 'object') actIssues.push('limitUsage.divisions not object');
            if (!Array.isArray(a.limitUsage.priorityList)) actIssues.push('limitUsage.priorityList missing');
            
            // Check for stale divisions
            if (typeof a.limitUsage.divisions === 'object') {
                const stale = Object.keys(a.limitUsage.divisions).filter(d => !divisions.includes(d));
                if (stale.length > 0) actIssues.push(`Stale limitUsage.divisions: ${stale.join(', ')}`);
            }
        }
        
        // Check timeRules
        if (!Array.isArray(a.timeRules)) {
            actIssues.push('timeRules not array');
        } else {
            a.timeRules.forEach((rule, rIdx) => {
                if (rule.startMin === undefined) actIssues.push(`timeRules[${rIdx}].startMin missing`);
                if (rule.endMin === undefined) actIssues.push(`timeRules[${rIdx}].endMin missing`);
            });
        }
        
        // ★★★ v2.3: Check isIndoor property ★★★
        if (a.isIndoor === undefined && !a.rainyDayExclusive && !a.rainyDayOnly) {
            actIssues.push('isIndoor property missing (will default to true)');
        }
        
        if (actIssues.length > 0) {
            issues.push({ activity: a.name || `[index ${idx}]`, issues: actIssues });
        }
    });
    
    if (issues.length === 0) {
        console.log('\n✅ All special activities have valid structure!');
    } else {
        console.log(`\n⚠️ ISSUES FOUND (${issues.length} activities):`);
        issues.forEach(item => {
            console.log(`\n   📁 ${item.activity}:`);
            item.issues.forEach(issue => console.log(`      - ${issue}`));
        });
    }
    
    console.log('\n' + '═'.repeat(60));
    console.log('💡 Run validateSpecialActivities() to auto-fix issues');
    console.log('═'.repeat(60) + '\n');
    
    return { activities: storedActivities.length, issues: issues.length };
};

console.log("[SPECIAL_ACTIVITIES] Module v3.0 loaded");

})();
