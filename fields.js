// ============================================================================
// fields.js — MERGED: NEW UX + SPORT PLAYER REQS + RAINY DAY AVAILABILITY
// CLOUD SYNC PATCH APPLIED
// ============================================================================
// 1. Layout: Apple-inspired Two-Pane with Collapsible Detail Sections.
// 2. Logic: Retains Sharing, Priority, and Sport Logic.
// 3. Fix: Access & Restrictions toggle stays open and updates locally.
// 4. Feat: Sport Player Requirements section.
// 5. NEW: Weather & Availability (Rainy Day Mode configuration).
// 6. SYNC: Explicit Cloud Sync trigger added to saveData.
// 7. SEC: Added RBAC checks for Add, Delete, and Save operations.
// 8. Update: Transition/Zone rules removed - now managed in Locations tab.
// 9. ★★★ v2.0: COMPREHENSIVE FIELD NORMALIZATION on save ★★★
// 10. ★★★ v2.1: DELETION CLEANUP - removes field refs from schedules ★★★
// 11. ★★★ v2.1: RENAME PROPAGATION - updates all field references ★★★
// 12. ★★★ v2.1: DIVISION VALIDATION - removes stale division refs ★★★
// 13. ★★★ v3.0: GRADE RESTRICTIONS / SAME-DIVISION SHARING / PRIORITY ★★★
// ============================================================================
(function(){
'use strict';

let fields = [];
let selectedItemId = null;
let fieldsListEl = null;
let detailPaneEl = null;
let addFieldInput = null;

// Sport metadata (min/max players) - synced with app1.js sportMetaData
let sportMetaData = {};

//------------------------------------------------------------------
// INIT
//------------------------------------------------------------------
function initFieldsTab(){
    const container = document.getElementById("fields");
    if(!container) return;
    
    loadData();

    // Clear any existing content first
    container.innerHTML = "";

    // Inject Styles for the new UI and the inner controls
    const style = document.createElement('style');
    style.innerHTML = `
        /* New UX Styles */
        .master-list { border: 1px solid #E5E7EB; border-radius: 12px; background: #fff; overflow: hidden; }
        .list-item { padding: 12px 14px; border-bottom: 1px solid #F3F4F6; cursor: pointer; display: flex; justify-content: space-between; align-items: center; transition: background 0.15s; }
        .list-item:last-child { border-bottom: none; }
        .list-item:hover { background: #F9FAFB; }
        .list-item.selected { background: #F0FDF4; border-left: 3px solid #10B981; }
        .list-item-name { font-weight: 500; color: #1F2937; font-size: 0.9rem; }
        .list-item-meta { font-size: 0.75rem; color: #6B7280; margin-left: 6px; }

        /* Accordion / Collapsible Sections */
        .detail-section { margin-bottom: 12px; border: 1px solid #E5E7EB; border-radius: 12px; background: #fff; overflow: hidden; }
        .detail-section-header { padding: 12px 16px; background: #F9FAFB; cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none; }
        .detail-section-header:hover { background: #F3F4F6; }
        .detail-section-title { font-size: 0.9rem; font-weight: 600; color: #111; }
        .detail-section-summary { font-size: 0.8rem; color: #6B7280; margin-top: 2px; }
        .detail-section-body { display: none; padding: 16px; border-top: 1px solid #E5E7EB; }
        
        /* Inner Controls (Chips, Priority Lists) */
        .chip { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 0.75rem; cursor: pointer; border: 1px solid #E5E7EB; margin-right: 4px; margin-bottom: 4px; transition: all 0.2s; }
        .chip.active { background: #10B981; color: white; border-color: #10B981; box-shadow: 0 2px 5px rgba(16, 185, 129, 0.3); }
        .chip.inactive { background: #F3F4F6; color: #374151; }
        .chip:hover { transform: translateY(-1px); }
        
        .priority-list-item { display: flex; align-items: center; gap: 10px; padding: 8px; background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 8px; margin-bottom: 6px; }
        .priority-btn { width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; border: 1px solid #D1D5DB; border-radius: 4px; background: white; cursor: pointer; font-size: 0.8rem; transition: all 0.15s; }
        .priority-btn:hover:not(:disabled) { border-color: #10B981; color: #10B981; }
        .priority-btn:disabled { opacity: 0.4; cursor: default; }

        .activity-button { padding: 6px 12px; border: 1px solid #E5E7EB; border-radius: 8px; background: white; cursor: pointer; font-size: 0.85rem; transition: all 0.2s; }
        .activity-button:hover { background: #F9FAFB; }
        .activity-button.active { background: #ECFDF5; color: #047857; border-color: #10B981; font-weight: 500; }
        
        /* Switch/Toggle */
        .switch { position: relative; display: inline-block; width: 34px; height: 20px; flex-shrink: 0; }
        .switch input { opacity: 0; width: 0; height: 0; }
        .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #ccc; transition: .4s; border-radius: 34px; }
        .slider:before { position: absolute; content: ""; height: 14px; width: 14px; left: 3px; bottom: 3px; background-color: white; transition: .4s; border-radius: 50%; }
        input:checked + .slider { background-color: #10B981; }
        input:checked + .slider:before { transform: translateX(14px); }

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
        .sport-rules-badge {
            background: #10B981;
            color: white;
            padding: 2px 10px;
            border-radius: 999px;
            font-size: 0.7rem;
            font-weight: 600;
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

    // Create the main content wrapper
    const contentWrapper = document.createElement('div');
    contentWrapper.innerHTML = `
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
                  <input id="new-field-input" placeholder="New Field (e.g., Court 1)" style="flex:1; border:none; outline:none; font-size:0.9rem;">
                  <button id="add-field-btn" style="background:#111; color:white; border:none; border-radius:6px; padding:6px 12px; font-size:0.8rem; cursor:pointer;">Add</button>
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
        </div>`;

    container.appendChild(contentWrapper);

    fieldsListEl = document.getElementById("fields-master-list");
    detailPaneEl = document.getElementById("fields-detail-pane");
    addFieldInput = document.getElementById("new-field-input");

    document.getElementById("add-field-btn").onclick = addField;
    addFieldInput.onkeyup = e => { if(e.key === "Enter") addField(); };

    renderSportRulesSection();
    renderMasterLists();
    renderDetailPane();
}

//------------------------------------------------------------------
// DATA LOADING
//------------------------------------------------------------------
function loadData(){
    const app1 = (window.loadGlobalSettings?.().app1) || {};
    fields = app1.fields || [];
    sportMetaData = app1.sportMetaData || {};

    fields.forEach(f => {
        f.available = f.available !== false;
        f.activities = f.activities || [];
        f.timeRules = f.timeRules || [];

        f.sharableWith = f.sharableWith || { type:"not_sharable", divisions:[], capacity:2 };
        if(!f.sharableWith.capacity) f.sharableWith.capacity = 2;
        if(!f.sharableWith.divisions) f.sharableWith.divisions = [];
        
        f.limitUsage = f.limitUsage || { enabled:false, divisions:{}, priorityList:[], usePriority: false };
        if(!f.limitUsage.priorityList) f.limitUsage.priorityList = [];
        // ★★★ v3.0: Migrate usePriority ★★★
        if (f.limitUsage.usePriority === undefined) f.limitUsage.usePriority = false;

        // Rainy Day Default
        f.rainyDayAvailable = f.rainyDayAvailable ?? false;
    });
    
    // ★★★ RUN DIVISION VALIDATION on load ★★★
    const validation = validateFieldDivisions();
    if (validation.issuesFixed > 0) {
        console.log(`[Fields] Auto-fixed ${validation.issuesFixed} stale division references on load`);
        // Save fixes silently (don't trigger RBAC since this is system cleanup)
        try {
            const settings = window.loadGlobalSettings?.() || {};
            settings.app1 = settings.app1 || {};
            settings.app1.fields = fields;
            window.saveGlobalSettings?.("app1", settings.app1);
        } catch (e) {
            console.warn('[Fields] Could not save division validation fixes:', e);
        }
    }
}

//------------------------------------------------------------------
// ★★★ FIELD DELETION CLEANUP ★★★
// Removes all references to a deleted field from schedules and history
//------------------------------------------------------------------
function cleanupDeletedField(fieldName) {
    if (!fieldName) return;
    
    console.log(`🗑️ [Fields] Cleaning up references to deleted field: "${fieldName}"`);
    let cleanupCount = 0;
    
    try {
        // 1. Clean from daily schedules (scheduleAssignments)
        const settings = window.loadGlobalSettings?.() || {};
        const dailySchedules = settings.daily_schedules || {};
        
        Object.keys(dailySchedules).forEach(dateKey => {
            const dayData = dailySchedules[dateKey];
            if (!dayData?.scheduleAssignments) return;
            
            Object.keys(dayData.scheduleAssignments).forEach(bunkKey => {
                const slots = dayData.scheduleAssignments[bunkKey];
                if (!Array.isArray(slots)) return;
                
                slots.forEach((slot, idx) => {
                    if (slot?.location === fieldName || slot?.field === fieldName) {
                        // Clear location reference but keep activity
                        dayData.scheduleAssignments[bunkKey][idx] = {
                            ...slot,
                            location: null,
                            field: null,
                            _fieldDeletedOn: new Date().toISOString()
                        };
                        cleanupCount++;
                    }
                });
            });
        });
        
        if (cleanupCount > 0) {
            window.saveGlobalSettings?.('daily_schedules', dailySchedules);
            console.log(`   ✅ Cleared ${cleanupCount} field references from schedules`);
        }
        
        // 2. Clean from current session scheduleAssignments
        if (window.scheduleAssignments) {
            Object.keys(window.scheduleAssignments).forEach(bunkKey => {
                const slots = window.scheduleAssignments[bunkKey];
                if (!Array.isArray(slots)) return;
                
                slots.forEach((slot, idx) => {
                    if (slot?.location === fieldName || slot?.field === fieldName) {
                        window.scheduleAssignments[bunkKey][idx] = {
                            ...slot,
                            location: null,
                            field: null
                        };
                    }
                });
            });
        }
        
        // 3. Clean from activityProperties
        if (window.activityProperties?.[fieldName]) {
            delete window.activityProperties[fieldName];
            console.log(`   ✅ Removed from activityProperties`);
        }
        
        // 4. Clean from GlobalFieldLocks if present
        if (window.GlobalFieldLocks?._locks) {
            Object.keys(window.GlobalFieldLocks._locks).forEach(key => {
                if (key.includes(fieldName)) {
                    delete window.GlobalFieldLocks._locks[key];
                }
            });
        }
        
        console.log(`🗑️ [Fields] Cleanup complete for "${fieldName}"`);
        
    } catch (e) {
        console.error('[Fields] Error during field cleanup:', e);
    }
}

//------------------------------------------------------------------
// ★★★ FIELD RENAME PROPAGATION ★★★
// Updates all references when a field is renamed
//------------------------------------------------------------------
function propagateFieldRename(oldName, newName) {
    if (!oldName || !newName || oldName === newName) return;
    
    console.log(`📝 [Fields] Propagating rename: "${oldName}" → "${newName}"`);
    let updateCount = 0;
    
    try {
        // 1. Update daily schedules
        const settings = window.loadGlobalSettings?.() || {};
        const dailySchedules = settings.daily_schedules || {};
        
        Object.keys(dailySchedules).forEach(dateKey => {
            const dayData = dailySchedules[dateKey];
            if (!dayData?.scheduleAssignments) return;
            
            Object.keys(dayData.scheduleAssignments).forEach(bunkKey => {
                const slots = dayData.scheduleAssignments[bunkKey];
                if (!Array.isArray(slots)) return;
                
                slots.forEach((slot, idx) => {
                    if (slot?.location === oldName) {
                        dayData.scheduleAssignments[bunkKey][idx].location = newName;
                        updateCount++;
                    }
                    if (slot?.field === oldName) {
                        dayData.scheduleAssignments[bunkKey][idx].field = newName;
                        updateCount++;
                    }
                });
            });
        });
        
        if (updateCount > 0) {
            window.saveGlobalSettings?.('daily_schedules', dailySchedules);
            console.log(`   ✅ Updated ${updateCount} references in daily schedules`);
        }
        
        // 2. Update current session scheduleAssignments
        if (window.scheduleAssignments) {
            Object.keys(window.scheduleAssignments).forEach(bunkKey => {
                const slots = window.scheduleAssignments[bunkKey];
                if (!Array.isArray(slots)) return;
                
                slots.forEach((slot, idx) => {
                    if (slot?.location === oldName) {
                        window.scheduleAssignments[bunkKey][idx].location = newName;
                    }
                    if (slot?.field === oldName) {
                        window.scheduleAssignments[bunkKey][idx].field = newName;
                    }
                });
            });
        }
        
        // 3. Update activityProperties
        if (window.activityProperties?.[oldName]) {
            window.activityProperties[newName] = {
                ...window.activityProperties[oldName]
            };
            delete window.activityProperties[oldName];
            console.log(`   ✅ Updated activityProperties`);
        }
        
        // 4. Update GlobalFieldLocks if present
        if (window.GlobalFieldLocks?._locks) {
            const keysToUpdate = Object.keys(window.GlobalFieldLocks._locks)
                .filter(k => k.includes(oldName));
            
            keysToUpdate.forEach(oldKey => {
                const newKey = oldKey.replace(oldName, newName);
                window.GlobalFieldLocks._locks[newKey] = window.GlobalFieldLocks._locks[oldKey];
                delete window.GlobalFieldLocks._locks[oldKey];
            });
            
            if (keysToUpdate.length > 0) {
                console.log(`   ✅ Updated ${keysToUpdate.length} field lock entries`);
            }
        }
        
        // 5. Update location zones if present
        const locationZones = settings.locationZones || {};
        let zonesUpdated = false;
        
        Object.keys(locationZones).forEach(zoneName => {
            const zone = locationZones[zoneName];
            if (zone?.fields && Array.isArray(zone.fields)) {
                const idx = zone.fields.indexOf(oldName);
                if (idx !== -1) {
                    zone.fields[idx] = newName;
                    zonesUpdated = true;
                }
            }
            if (zone?.locations?.[oldName]) {
                zone.locations[newName] = zone.locations[oldName];
                delete zone.locations[oldName];
                zonesUpdated = true;
            }
        });
        
        if (zonesUpdated) {
            window.saveGlobalSettings?.('locationZones', locationZones);
            console.log(`   ✅ Updated location zones`);
        }
        
        console.log(`📝 [Fields] Rename propagation complete: "${oldName}" → "${newName}"`);
        
    } catch (e) {
        console.error('[Fields] Error during rename propagation:', e);
    }
}

//------------------------------------------------------------------
// ★★★ DIVISION VALIDATION ★★★  
// Validates and cleans stale division references in field configs
//------------------------------------------------------------------
function validateFieldDivisions() {
    const settings = window.loadGlobalSettings?.() || {};
    const validDivisions = getValidDivisionNames();
    
    if (validDivisions.length === 0) {
        console.log('[Fields] No divisions found - skipping validation');
        return { fieldsChecked: 0, issuesFixed: 0 };
    }
    
    let issuesFixed = 0;
    
    fields.forEach(field => {
        // Validate sharableWith.divisions
        if (field.sharableWith?.divisions && Array.isArray(field.sharableWith.divisions)) {
            const originalLength = field.sharableWith.divisions.length;
            field.sharableWith.divisions = field.sharableWith.divisions.filter(div => 
                validDivisions.includes(div)
            );
            
            if (field.sharableWith.divisions.length < originalLength) {
                const removed = originalLength - field.sharableWith.divisions.length;
                console.log(`[Fields] Removed ${removed} stale division(s) from ${field.name} sharableWith`);
                issuesFixed += removed;
            }
        }
        
        // Validate limitUsage.divisions
        if (field.limitUsage?.divisions && typeof field.limitUsage.divisions === 'object') {
            const divKeys = Object.keys(field.limitUsage.divisions);
            divKeys.forEach(divKey => {
                if (!validDivisions.includes(divKey)) {
                    delete field.limitUsage.divisions[divKey];
                    console.log(`[Fields] Removed stale division "${divKey}" from ${field.name} limitUsage`);
                    issuesFixed++;
                }
            });
        }
        
        // Validate limitUsage.priorityList
        if (field.limitUsage?.priorityList && Array.isArray(field.limitUsage.priorityList)) {
            const originalLength = field.limitUsage.priorityList.length;
            field.limitUsage.priorityList = field.limitUsage.priorityList.filter(div => 
                validDivisions.includes(div)
            );
            
            if (field.limitUsage.priorityList.length < originalLength) {
                const removed = originalLength - field.limitUsage.priorityList.length;
                console.log(`[Fields] Removed ${removed} stale division(s) from ${field.name} priorityList`);
                issuesFixed += removed;
            }
        }
    });
    
    if (issuesFixed > 0) {
        console.log(`[Fields] Division validation complete: ${issuesFixed} issues fixed`);
        // Don't call saveData here - caller should save if needed
    }
    
    return { fieldsChecked: fields.length, issuesFixed };
}

/**
 * Get valid division names from global settings
 */
function getValidDivisionNames() {
    try {
        const settings = window.loadGlobalSettings?.() || {};
        const divisions = settings.divisions || settings.app1?.divisions || {};
        
        if (Array.isArray(divisions)) {
            return divisions.map(d => d?.name || d).filter(Boolean);
        }
        
        return Object.keys(divisions);
    } catch (e) {
        console.error('[Fields] Error getting valid divisions:', e);
        return [];
    }
}

//------------------------------------------------------------------
// ★★★ COMPREHENSIVE SAVE WITH FULL NORMALIZATION ★★★
//------------------------------------------------------------------
function saveData(){
    // ✅ RBAC Check
    if (!window.AccessControl?.canEditSetup?.()) {
        console.warn('[Fields] Save blocked - insufficient permissions');
        return;
    }

    try {
        // ★★★ NORMALIZE FIELDS BEFORE SAVE to ensure complete structure ★★★
        const normalizedFields = fields.map(f => ({
            // Basic properties
            name: f.name || '',
            activities: Array.isArray(f.activities) ? f.activities : [],
            available: f.available !== false,
            
            // ★ Sharing rules - ensure complete structure
            sharableWith: {
                type: f.sharableWith?.type || 'not_sharable',
                divisions: Array.isArray(f.sharableWith?.divisions) ? f.sharableWith.divisions : [],
                capacity: parseInt(f.sharableWith?.capacity) || (f.sharableWith?.type === 'not_sharable' ? 1 : 2)
            },
            
            // ★ Access restrictions - ensure complete structure (v3.0: usePriority)
            limitUsage: {
                enabled: f.limitUsage?.enabled === true,
                divisions: typeof f.limitUsage?.divisions === 'object' ? f.limitUsage.divisions : {},
                priorityList: Array.isArray(f.limitUsage?.priorityList) ? f.limitUsage.priorityList : [],
                usePriority: f.limitUsage?.usePriority === true
            },
            
            // ★ Time rules - ensure array with parsed times
            timeRules: Array.isArray(f.timeRules) ? f.timeRules.map(r => ({
                type: r.type || 'Available',
                start: r.start || '',
                end: r.end || '',
                startMin: r.startMin ?? parseTimeToMinutes(r.start),
                endMin: r.endMin ?? parseTimeToMinutes(r.end)
            })) : [],
            
            // ★ Indoor/Outdoor for rainy day
            rainyDayAvailable: f.rainyDayAvailable === true,
            
            // Preserve any additional properties
            ...(f.transition ? { transition: f.transition } : {}),
            ...(f.preferences ? { preferences: f.preferences } : {}),
            ...(f.minDurationMin ? { minDurationMin: f.minDurationMin } : {})
        }));
        
        const settings = window.loadGlobalSettings?.() || {};
        settings.app1 = settings.app1 || {};
        settings.app1.fields = normalizedFields;
        settings.app1.sportMetaData = sportMetaData;
        window.saveGlobalSettings?.("app1", settings.app1);
        
        // ⭐ Also save at root level for redundancy
        window.saveGlobalSettings?.("fields", normalizedFields);
        
        // ⭐ CLOUD SYNC FIX: Explicitly request cloud sync after saving
        if (typeof window.requestCloudSync === 'function') {
            window.requestCloudSync();
        }
        
        // Update local reference with normalized data
        fields = normalizedFields;
        
        // Expose globally for other modules
        window.fields = fields;
        
        // ★★★ REFRESH ACTIVITY PROPERTIES to keep generator in sync ★★★
        if (typeof window.refreshActivityPropertiesFromFields === 'function') {
            setTimeout(() => window.refreshActivityPropertiesFromFields(), 50);
        }
        
        console.log('☁️ [Fields] Saved', normalizedFields.length, 'fields with complete structure');
    } catch (e) {
        console.error("Failed to save fields data:", e);
    }
}

//------------------------------------------------------------------
// SPORT RULES SECTION (Dropdown/Collapsible)
//------------------------------------------------------------------
function renderSportRulesSection() {
    const container = document.getElementById("sport-rules-section");
    if (!container) return;

    const allSports = window.getAllGlobalSports?.() || [];
    
    // Empty state handling
    if (allSports.length === 0) {
        container.innerHTML = `
            <div class="sport-rules-card">
                <div class="sport-rules-header">
                    <div class="sport-rules-title">
                        ⚡ Sports Rules
                    </div>
                </div>
                <div class="sport-rules-body" style="display:block; padding-top:10px; text-align:center;">
                    <p class="muted" style="padding:10px;">
                        No sports configured yet. Add sports to fields first.
                    </p>
                </div>
            </div>
        `;
        return;
    }

    let sportsHTML = '';
    const sortedSports = [...allSports].sort();

    sortedSports.forEach(sport => {
        const meta = sportMetaData[sport] || {};
        const minPlayers = meta.minPlayers || '';
        const maxPlayers = meta.maxPlayers || '';

        sportsHTML += `
            <div class="sport-rule-row">
                <span class="sport-rule-name">${escapeHtml(sport)}</span>
                <div class="sport-rule-inputs">
                    <div class="sport-rule-input-group">
                        <span class="sport-rule-label">Min:</span>
                        <input type="number" 
                               class="sport-rule-input" 
                               data-sport="${escapeHtml(sport)}" 
                               data-type="min"
                               value="${minPlayers}" 
                               placeholder="—"
                               min="1">
                    </div>
                    <div class="sport-rule-input-group">
                        <span class="sport-rule-label">Max:</span>
                        <input type="number" 
                               class="sport-rule-input" 
                               data-sport="${escapeHtml(sport)}" 
                               data-type="max"
                               value="${maxPlayers}" 
                               placeholder="∞"
                               min="1">
                    </div>
                </div>
            </div>
        `;
    });

    // Render the dropdown structure
    container.innerHTML = `
        <div class="sport-rules-card">
            <!-- Header (Toggle Trigger) -->
            <div class="sport-rules-header" id="sport-rules-toggle">
                <div class="sport-rules-title">
                    ⚡ Sports Rules
                </div>
                <span id="sport-rules-caret" style="transform: rotate(0deg); transition: transform 0.2s; color:#6B7280;">
                      <svg width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"></path></svg>
                </span>
            </div>
            
            <!-- Body (Collapsible Content) -->
            <div id="sport-rules-body" style="display:none; margin-top:16px; padding-top:16px; border-top:1px solid #E5E7EB;">
                <div class="sport-rules-hint">
                    <strong>How this works:</strong> Set minimum and maximum players for each sport. 
                    The scheduler will try to match bunks appropriately based on their sizes. 
                    If a bunk is too small, it may be paired with another bunk. 
                    If combined bunks are slightly over the max, the scheduler will still prefer a valid sport over "Free".
                </div>
                <div id="sport-rules-list">
                    ${sportsHTML}
                </div>
                <div style="margin-top:20px; text-align:right;">
                      <button id="save-sport-rules-btn" style="background:#10B981; color:white; border:none; padding:8px 24px; border-radius:999px; cursor:pointer; font-weight:600; font-size:0.9rem; box-shadow: 0 2px 5px rgba(16,185,129,0.3);">
                        Save Rules
                    </button>
                </div>
            </div>
        </div>
    `;

    // Toggle Logic
    const toggleBtn = document.getElementById('sport-rules-toggle');
    const bodyEl = document.getElementById('sport-rules-body');
    const caretEl = document.getElementById('sport-rules-caret');

    toggleBtn.onclick = () => {
        const isHidden = bodyEl.style.display === 'none';
        bodyEl.style.display = isHidden ? 'block' : 'none';
        caretEl.style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0deg)';
    };

    // Add event listeners for Inputs
    container.querySelectorAll('.sport-rule-input').forEach(input => {
        input.addEventListener('change', () => {
            const sport = input.dataset.sport;
            const type = input.dataset.type;
            const val = parseInt(input.value) || null;

            if (!sportMetaData[sport]) sportMetaData[sport] = {};
            
            if (type === 'min') {
                sportMetaData[sport].minPlayers = val;
            } else if (type === 'max') {
                sportMetaData[sport].maxPlayers = val;
            }
        });
    });

    // Save Button Logic
    const saveBtn = document.getElementById('save-sport-rules-btn');
    if(saveBtn) {
        saveBtn.onclick = (e) => {
            e.stopPropagation();

            // Collect all values
            container.querySelectorAll('.sport-rule-input').forEach(input => {
                const sport = input.dataset.sport;
                const type = input.dataset.type;
                const val = parseInt(input.value) || null;

                if (!sportMetaData[sport]) sportMetaData[sport] = {};
                
                if (type === 'min') {
                    sportMetaData[sport].minPlayers = val;
                } else if (type === 'max') {
                    sportMetaData[sport].maxPlayers = val;
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
        };
    }
}

//------------------------------------------------------------------
// LEFT LIST
//------------------------------------------------------------------
function renderMasterLists(){
    fieldsListEl.innerHTML = "";

    if(fields.length === 0){
        fieldsListEl.innerHTML = `<div style="padding:20px; text-align:center; color:#9CA3AF;">No fields created yet.</div>`;
        return;
    }

    fields.forEach(f => fieldsListEl.appendChild(masterListItem(f)));
}

function masterListItem(item){
    const id = `field-${item.name}`;
    const el = document.createElement("div");
    el.className = "list-item" + (id === selectedItemId ? " selected" : "");
    el.onclick = ()=>{ selectedItemId = id; renderMasterLists(); renderDetailPane(); };

    const infoDiv = document.createElement("div");
    
    const name = document.createElement("div");
    name.className = "list-item-name";
    name.textContent = item.name;
    
    infoDiv.appendChild(name);
    el.appendChild(infoDiv);

    // Toggle Switch
    const tog = document.createElement("label");
    tog.className = "switch list-item-toggle";
    tog.onclick = e => e.stopPropagation();
    
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = item.available;
    cb.onchange = () => { item.available = cb.checked; saveData(); renderDetailPane(); };
    
    const slider = document.createElement("span"); 
    slider.className = "slider";
    tog.appendChild(cb); 
    tog.appendChild(slider);
    el.appendChild(tog);

    return el;
}

//------------------------------------------------------------------
// RIGHT PANEL — APPLE STYLE COLLAPSIBLE SECTIONS
//------------------------------------------------------------------
function renderDetailPane(){
    if(!selectedItemId){ 
        detailPaneEl.innerHTML = `
            <div style="height:300px; display:flex; align-items:center; justify-content:center; color:#9CA3AF; border:1px dashed #E5E7EB; border-radius:12px;">
                Select a field to edit details
            </div>`; 
        return; 
    }

    const [, name] = selectedItemId.split(/-(.+)/);
    const item = fields.find(f => f.name === name);

    if(!item){ 
        detailPaneEl.innerHTML = `<p class='muted'>Not found.</p>`; 
        return; 
    }

    const allSports = window.getAllGlobalSports?.() || [];
    detailPaneEl.innerHTML = "";

    // -- 1. HEADER (Title & Delete) --
    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.alignItems = "center";
    header.style.marginBottom = "16px";

    const title = document.createElement("h2");
    title.textContent = item.name;
    title.style.margin = "0";
    title.style.fontSize = "1.25rem";
    title.title = "Double click to rename";

    makeEditable(title, newName=>{
        if(!newName.trim()) return;
        const oldName = item.name;
        if (oldName === newName) return;
        
        // Check for duplicate names
        if (fields.some(f => f !== item && f.name.toLowerCase() === newName.toLowerCase())) {
            alert(`A field named "${newName}" already exists.`);
            return;
        }
        
        item.name = newName;
        selectedItemId = `field-${newName}`;
        
        // ★★★ PROPAGATE RENAME to all references ★★★
        propagateFieldRename(oldName, newName);
        
        saveData();
        renderMasterLists();
        renderDetailPane();
    });

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

    delBtn.onclick = ()=>{
        // ✅ RBAC Check
        if (!window.AccessControl?.canEraseData?.()) {
            window.AccessControl?.showPermissionDenied?.('delete fields');
            return;
        }
        if(confirm(`Delete "${item.name}"?\n\nThis will also remove field references from all schedules.`)){
            const deletedFieldName = item.name;
            
            // ★★★ CLEANUP before removing ★★★
            cleanupDeletedField(deletedFieldName);
            
            fields = fields.filter(f => f !== item);
            saveData();
            selectedItemId = null;
            renderMasterLists();
            renderDetailPane();
        }
    };

    header.appendChild(title);
    header.appendChild(delBtn);
    detailPaneEl.appendChild(header);

    // -- 2. AVAILABILITY STRIP --
    const availability = document.createElement("div");
    availability.style.padding = "12px";
    availability.style.borderRadius = "8px";
    availability.style.marginBottom = "20px";
    availability.style.background = item.available ? "#ECFDF5" : "#FEF2F2";
    availability.style.border = item.available ? "1px solid #A7F3D0" : "1px solid #FECACA";
    availability.style.color = item.available ? "#065F46" : "#991B1B";
    availability.style.fontSize = "0.9rem";
    availability.style.display = "flex";
    availability.style.justifyContent = "space-between";
    availability.innerHTML = `<span>Field is <strong>${item.available ? 'AVAILABLE' : 'UNAVAILABLE'}</strong></span> <span style="font-size:0.8rem; opacity:0.8;">Toggle in master list</span>`;
    detailPaneEl.appendChild(availability);

    // -- 3. ACCORDION SECTIONS (Logic Wrappers) --
    // NOTE: Transition & Zone Rules removed - now managed in Locations tab
    
    // Activities
    detailPaneEl.appendChild(section("Activities", summaryActivities(item), 
        () => renderActivities(item, allSports)));

    // Access & Priority
    detailPaneEl.appendChild(section("Access & Restrictions", summaryAccess(item), 
        () => renderAccess(item)));

    // Sharing Rules
    detailPaneEl.appendChild(section("Sharing Rules", summarySharing(item), 
        () => renderSharing(item)));

    // Time Rules
    detailPaneEl.appendChild(section("Time Rules", summaryTime(item), 
        () => renderTimeRules(item)));

    // Weather & Availability (Rainy Day)
    detailPaneEl.appendChild(section("Weather & Availability", summaryWeather(item), 
        () => renderWeatherSettings(item)));
}

//------------------------------------------------------------------
// SECTION BUILDER (Accordion UX)
//------------------------------------------------------------------
function section(title, summary, builder){
    const wrap = document.createElement("div"); 
    wrap.className = "detail-section";

    const head = document.createElement("div");
    head.className = "detail-section-header";

    const t = document.createElement("div");
    t.innerHTML = `<div class="detail-section-title">${escapeHtml(title)}</div><div class="detail-section-summary">${escapeHtml(summary)}</div>`;

    const caret = document.createElement("span");
    caret.innerHTML = `<svg width="20" height="20" fill="none" stroke="#9CA3AF" stroke-width="2" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"></path></svg>`;
    caret.style.transition = "transform 0.2s";

    head.appendChild(t);
    head.appendChild(caret);

    const body = document.createElement("div");
    body.className = "detail-section-body";

    head.onclick = ()=>{
        const open = body.style.display === "block";
        body.style.display = open ? "none" : "block";
        caret.style.transform = open ? "rotate(0deg)" : "rotate(90deg)";

        if(!open && !body.dataset.built){ 
            body.innerHTML = "";
            body.appendChild(builder()); 
            body.dataset.built = "1"; 
        }
    };

    wrap.appendChild(head);
    wrap.appendChild(body);
    return wrap;
}

//------------------------------------------------------------------
// CONTENT GENERATORS
//------------------------------------------------------------------
function summaryActivities(f){ return f.activities.length ? `${f.activities.length} sports selected` : "No sports selected"; }
function summarySharing(f){
    const rules = f.sharableWith;
    if (!rules || rules.type === 'not_sharable') return "No sharing (1 bunk only)";
    const cap = parseInt(rules.capacity) || 2;
    return `Up to ${cap} bunks (same grade)`;
}
function summaryAccess(f){
    if (!f.limitUsage?.enabled) return "Open to all grades";
    const count = Object.keys(f.limitUsage.divisions || {}).length;
    if (count === 0) return "⚠ Restricted (none selected)";
    const pStr = f.limitUsage.usePriority ? " · prioritized" : "";
    return `${count} grade${count !== 1 ? 's' : ''} allowed${pStr}`;
}
function summaryTime(f){ return f.timeRules.length ? `${f.timeRules.length} rule(s) active` : "Available all day"; }
function summaryWeather(f) { return f.rainyDayAvailable ? "🏠 Indoor (Rain OK)" : "🌳 Outdoor"; }

// 1. ACTIVITIES
function renderActivities(item, allSports){
    const box = document.createElement("div");
    const wrap = document.createElement("div"); 
    wrap.style.display = "flex"; 
    wrap.style.flexWrap = "wrap"; 
    wrap.style.gap = "8px"; 
    wrap.style.marginBottom = "12px";

    // Get the list of "built-in" sports that exist across all fields (for determining custom sports)
    const globalSports = window.getAllGlobalSports?.() || [];

    allSports.forEach(s=>{
        const b = document.createElement("button");
        b.textContent = s;
        b.className = "activity-button" + (item.activities.includes(s) ? " active" : "");
        
        // Check if this is a custom sport (only exists on this field)
        const isCustom = !globalSports.includes(s) || 
            (item.activities.includes(s) && fields.filter(f => f.activities.includes(s)).length === 1);
        
        if(isCustom && item.activities.includes(s)) {
            b.title = "Double-click to remove this custom activity";
        }

        let clickTimer = null;
        b.onclick = ()=>{
            if(clickTimer) {
                clearTimeout(clickTimer);
                clickTimer = null;
                return; // Double-click detected, let ondblclick handle it
            }
            clickTimer = setTimeout(() => {
                clickTimer = null;
                if(item.activities.includes(s)) item.activities = item.activities.filter(x=>x!==s);
                else item.activities.push(s);
                saveData(); 
                b.className = "activity-button" + (item.activities.includes(s) ? " active" : "");

                // Update summary without rerendering everything
                const summaryEl = b.closest('.detail-section').querySelector('.detail-section-summary');
                if(summaryEl) summaryEl.textContent = summaryActivities(item);

                // Re-render sport rules section to show updated sports
                renderSportRulesSection();
            }, 300);
        };

        // Double-click to delete custom activities
        b.ondblclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            // Cancel any pending single-click action
            if(clickTimer) {
                clearTimeout(clickTimer);
                clickTimer = null;
            }
            
            // Check how many fields use this sport
            const fieldsUsingSport = fields.filter(f => f.activities.includes(s));
            
            if(fieldsUsingSport.length > 1) {
                // Sport is used by multiple fields - just remove from this field
                if(confirm(`Remove "${s}" from this field? (Other fields still use this activity)`)) {
                    item.activities = item.activities.filter(x => x !== s);
                    saveData();
                    b.className = "activity-button";
                    
                    const summaryEl = b.closest('.detail-section')?.querySelector('.detail-section-summary');
                    if(summaryEl) summaryEl.textContent = summaryActivities(item);
                    
                    renderSportRulesSection();
                }
            } else {
                // Sport is only on this field (or not on any field) - delete it globally
                const msg = fieldsUsingSport.length === 1 
                    ? `Remove "${s}"? This will delete this activity completely.`
                    : `Delete "${s}" from all activities?`;
                    
                if(confirm(msg)) {
                    item.activities = item.activities.filter(x => x !== s);
                    
                    // Remove from all fields to ensure it's gone globally
                    fields.forEach(f => {
                        f.activities = f.activities.filter(x => x !== s);
                    });
                    
                    // Remove from sport metadata
                    delete sportMetaData[s];
                    
                    // Also call global remove if it exists
                    window.removeGlobalSport?.(s);
                    
                    saveData();
                    
                    // Re-render the activities section with fresh global sports list
                    const parentBody = box.parentElement;
                    if(parentBody) {
                        parentBody.innerHTML = '';
                        parentBody.appendChild(renderActivities(item, window.getAllGlobalSports?.() || []));
                    }
                    
                    // Update summary
                    const summaryEl = box.closest('.detail-section')?.querySelector('.detail-section-summary');
                    if(summaryEl) summaryEl.textContent = summaryActivities(item);
                    
                    renderSportRulesSection();
                }
            }
        };

        wrap.appendChild(b);
    });

    const add = document.createElement("input");
    add.placeholder = "Add new sport (Type & Enter)...";
    add.style.width = "100%";
    add.style.padding = "8px";
    add.style.borderRadius = "6px";
    add.style.border = "1px solid #D1D5DB";

    add.onkeyup = e=>{
        if(e.key==="Enter" && add.value.trim()){
            const s = add.value.trim();
            window.addGlobalSport?.(s);
            if(!item.activities.includes(s)) item.activities.push(s);
            saveData(); 
            
            // Re-render the activities section in place
            const parentBody = box.parentElement;
            if(parentBody) {
                parentBody.innerHTML = '';
                parentBody.appendChild(renderActivities(item, window.getAllGlobalSports?.() || []));
            }
            
            // Update summary
            const summaryEl = box.closest('.detail-section')?.querySelector('.detail-section-summary');
            if(summaryEl) summaryEl.textContent = summaryActivities(item);
            
            renderSportRulesSection();
        }
    };

    // Help text
    const helpText = document.createElement("div");
    helpText.style.fontSize = "0.75rem";
    helpText.style.color = "#9CA3AF";
    helpText.style.marginTop = "8px";
    helpText.textContent = "💡 Tip: Double-click an activity to remove it";

    box.appendChild(wrap);
    box.appendChild(add);
    box.appendChild(helpText);
    return box;
}

// ★★★ v3.0: SHARING — Toggle + same-division capacity ★★★
function renderSharing(item){
    const container = document.createElement("div");

    const updateSummary = () => {
        const summaryEl = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if(summaryEl) summaryEl.textContent = summarySharing(item);
    };

    const renderContent = () => {
        container.innerHTML = "";
        
        const rules = item.sharableWith || { type: 'not_sharable', divisions: [], capacity: 1 };
        const isSharable = rules.type !== 'not_sharable';

        // Toggle row
        const toggleRow = document.createElement("div");
        toggleRow.style.cssText = "display:flex; align-items:center; gap:10px; margin-bottom:16px;";
        
        const tog = document.createElement("label"); 
        tog.className = "switch";
        const cb = document.createElement("input"); 
        cb.type = "checkbox";
        cb.checked = isSharable;
        cb.onchange = () => {
            if (cb.checked) {
                rules.type = 'same_division';
                rules.capacity = rules.capacity > 1 ? rules.capacity : 2;
            } else {
                rules.type = 'not_sharable';
                rules.capacity = 1;
            }
            rules.divisions = [];
            item.sharableWith = rules;
            saveData();
            renderContent();
            updateSummary();
        };
        const sl = document.createElement("span"); 
        sl.className = "slider";
        tog.appendChild(cb); 
        tog.appendChild(sl);
        
        const label = document.createElement("span");
        label.style.cssText = "font-weight:500; font-size:0.9rem;";
        label.textContent = "Allow Sharing";
        
        toggleRow.appendChild(tog);
        toggleRow.appendChild(label);
        container.appendChild(toggleRow);

        if (!isSharable) {
            const note = document.createElement("div");
            note.style.cssText = "color:#6B7280; font-size:0.85rem; padding:10px; background:#F9FAFB; border-radius:8px;";
            note.textContent = "Only 1 bunk can use this field at a time.";
            container.appendChild(note);
        } else {
            const det = document.createElement("div");
            det.style.cssText = "margin-top:4px; padding-left:12px; border-left:2px solid #10B981;";

            // Capacity input
            const capRow = document.createElement("div");
            capRow.style.cssText = "display:flex; align-items:center; gap:8px; margin-bottom:12px;";
            capRow.innerHTML = `<span style="font-size:0.85rem;">Max bunks at once:</span>`;
            const capIn = document.createElement("input"); 
            capIn.type = "number"; capIn.min = "2"; capIn.max = "20";
            capIn.value = rules.capacity || 2;
            capIn.style.cssText = "width:60px; padding:4px; border-radius:6px; border:1px solid #D1D5DB; text-align:center;";
            capIn.onchange = () => { 
                rules.capacity = Math.min(20, Math.max(2, parseInt(capIn.value) || 2)); 
                capIn.value = rules.capacity;
                item.sharableWith = rules;
                saveData(); 
                updateSummary(); 
            };
            capRow.appendChild(capIn);
            det.appendChild(capRow);

            // Explanation
            const note = document.createElement("div");
            note.style.cssText = "color:#6B7280; font-size:0.8rem; padding:10px; background:#F0FDF4; border-radius:8px; line-height:1.5;";
            note.innerHTML = `Up to <strong>${rules.capacity || 2}</strong> bunks <strong>within the same grade</strong> can use this simultaneously.<br>Bunks from different grades <strong>cannot</strong> share at the same time.`;
            det.appendChild(note);

            container.appendChild(det);
        }
    };

    renderContent();
    return container;
}

// ★★★ v3.0: ACCESS & PRIORITY — Grade toggle + chips + priority reorder ★★★
function renderAccess(item){
    const container = document.createElement("div");

    const updateSummary = () => {
        const summaryEl = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if(summaryEl) summaryEl.textContent = summaryAccess(item);
    };

    const renderContent = () => {
        container.innerHTML = "";
        
        const rules = item.limitUsage || { enabled: false, divisions: {}, priorityList: [], usePriority: false };
        if (!rules.priorityList) rules.priorityList = Object.keys(rules.divisions || {});
        if (rules.usePriority === undefined) rules.usePriority = false;

        // ── STEP 1: Grade Access Toggle ──
        const modeWrap = document.createElement("div");
        modeWrap.style.cssText = "display:flex; gap:12px; margin-bottom:16px;";

        const btnAll = document.createElement("button");
        btnAll.textContent = "Open to All Grades";
        btnAll.style.cssText = `flex:1; padding:8px; border-radius:6px; border:1px solid #E5E7EB; cursor:pointer; background:${!rules.enabled ? '#ECFDF5' : '#fff'}; color:${!rules.enabled ? '#047857' : '#333'}; border-color:${!rules.enabled ? '#10B981' : '#E5E7EB'}; font-weight:${!rules.enabled ? '600' : '400'}; transition:all 0.2s;`;

        const btnRes = document.createElement("button");
        btnRes.textContent = "Specific Grades Only";
        btnRes.style.cssText = `flex:1; padding:8px; border-radius:6px; border:1px solid #E5E7EB; cursor:pointer; background:${rules.enabled ? '#ECFDF5' : '#fff'}; color:${rules.enabled ? '#047857' : '#333'}; border-color:${rules.enabled ? '#10B981' : '#E5E7EB'}; font-weight:${rules.enabled ? '600' : '400'}; transition:all 0.2s;`;

        btnAll.onclick = () => { rules.enabled = false; item.limitUsage = rules; saveData(); renderContent(); updateSummary(); };
        btnRes.onclick = () => { rules.enabled = true; item.limitUsage = rules; saveData(); renderContent(); updateSummary(); };

        modeWrap.appendChild(btnAll);
        modeWrap.appendChild(btnRes);
        container.appendChild(modeWrap);

        // Get available grades/divisions
        const allDivs = Object.keys(window.loadGlobalSettings?.()?.divisions || {});

        // ── STEP 2: Grade Chips (when restricted) ──
        if (rules.enabled) {
            const body = document.createElement("div");
            body.style.cssText = "padding-left:12px; border-left:2px solid #10B981; margin-bottom:16px;";

            const chipLabel = document.createElement("div");
            chipLabel.style.cssText = "font-size:0.85rem; font-weight:500; margin-bottom:8px; color:#374151;";
            chipLabel.textContent = "Select allowed grades:";
            body.appendChild(chipLabel);

            const chipWrap = document.createElement("div");
            chipWrap.style.cssText = "display:flex; flex-wrap:wrap; gap:4px; margin-bottom:8px;";

            allDivs.forEach(divName => {
                const isAllowed = !!rules.divisions[divName];
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
                    item.limitUsage = rules;
                    saveData();
                    renderContent();
                    updateSummary();
                };
                chipWrap.appendChild(c);
            });

            body.appendChild(chipWrap);

            const allowedCount = Object.keys(rules.divisions).length;
            if (allowedCount === 0) {
                const warn = document.createElement("div");
                warn.style.cssText = "color:#DC2626; font-size:0.8rem; padding:8px; background:#FEF2F2; border-radius:6px; margin-top:4px;";
                warn.textContent = "⚠ No grades selected — no bunks will be able to use this field.";
                body.appendChild(warn);
            }

            container.appendChild(body);
        }

        // ── STEP 3: Priority Order ──
        const availableGrades = rules.enabled ? Object.keys(rules.divisions) : allDivs;

        if (availableGrades.length >= 2) {
            const prioritySection = document.createElement("div");
            prioritySection.style.cssText = "border:1px solid #E5E7EB; border-radius:10px; padding:14px; background:#FAFAFA;";

            const priToggleRow = document.createElement("div");
            priToggleRow.style.cssText = "display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;";
            
            const priLabel = document.createElement("span");
            priLabel.style.cssText = "font-weight:600; font-size:0.9rem;";
            priLabel.textContent = "Priority Order";
            
            const priTog = document.createElement("label"); priTog.className = "switch";
            const priCb = document.createElement("input"); priCb.type = "checkbox";
            priCb.checked = rules.usePriority === true;
            priCb.onchange = () => {
                rules.usePriority = priCb.checked;
                if (priCb.checked && rules.priorityList.length === 0) {
                    rules.priorityList = [...availableGrades];
                }
                item.limitUsage = rules;
                saveData(); renderContent(); updateSummary();
            };
            const priSl = document.createElement("span"); priSl.className = "slider";
            priTog.appendChild(priCb); priTog.appendChild(priSl);

            priToggleRow.appendChild(priLabel);
            priToggleRow.appendChild(priTog);
            prioritySection.appendChild(priToggleRow);

            const priDesc = document.createElement("div");
            priDesc.style.cssText = "font-size:0.8rem; color:#6B7280; margin-bottom:10px;";
            priDesc.textContent = rules.usePriority 
                ? "Grades higher in the list get first access when scheduling." 
                : "Generator assigns grades freely with no preference.";
            prioritySection.appendChild(priDesc);

            if (rules.usePriority) {
                const validPriority = rules.priorityList.filter(d => availableGrades.includes(d));
                const missing = availableGrades.filter(d => !validPriority.includes(d));
                rules.priorityList = [...validPriority, ...missing];

                const listEl = document.createElement("div");
                listEl.style.cssText = "display:flex; flex-direction:column; gap:4px;";

                rules.priorityList.forEach((divName, idx) => {
                    const row = document.createElement("div");
                    row.style.cssText = "display:flex; align-items:center; gap:8px; padding:6px 10px; background:#fff; border:1px solid #E5E7EB; border-radius:6px;";
                    
                    const num = document.createElement("span");
                    num.style.cssText = "width:20px; text-align:center; font-weight:600; color:#10B981; font-size:0.85rem;";
                    num.textContent = idx + 1;
                    
                    const nameEl = document.createElement("span");
                    nameEl.style.cssText = "flex:1; font-size:0.85rem;";
                    nameEl.textContent = divName;

                    const btnUp = document.createElement("button");
                    btnUp.textContent = "↑";
                    btnUp.style.cssText = "border:1px solid #D1D5DB; background:#fff; border-radius:4px; width:24px; height:24px; cursor:pointer; font-size:0.8rem;";
                    btnUp.disabled = idx === 0;
                    if (idx === 0) btnUp.style.opacity = "0.3";
                    btnUp.onclick = () => {
                        [rules.priorityList[idx - 1], rules.priorityList[idx]] = [rules.priorityList[idx], rules.priorityList[idx - 1]];
                        item.limitUsage = rules;
                        saveData(); renderContent(); updateSummary();
                    };

                    const btnDown = document.createElement("button");
                    btnDown.textContent = "↓";
                    btnDown.style.cssText = "border:1px solid #D1D5DB; background:#fff; border-radius:4px; width:24px; height:24px; cursor:pointer; font-size:0.8rem;";
                    btnDown.disabled = idx === rules.priorityList.length - 1;
                    if (idx === rules.priorityList.length - 1) btnDown.style.opacity = "0.3";
                    btnDown.onclick = () => {
                        [rules.priorityList[idx], rules.priorityList[idx + 1]] = [rules.priorityList[idx + 1], rules.priorityList[idx]];
                        item.limitUsage = rules;
                        saveData(); renderContent(); updateSummary();
                    };

                    row.appendChild(num);
                    row.appendChild(nameEl);
                    row.appendChild(btnUp);
                    row.appendChild(btnDown);
                    listEl.appendChild(row);
                });

                prioritySection.appendChild(listEl);
            }

            container.appendChild(prioritySection);
        }
    };

    renderContent(); 
    return container;
}

// 4. TIME RULES
function renderTimeRules(item){
    const container = document.createElement("div");
    
    // Existing Rules
    if(item.timeRules.length > 0){
        item.timeRules.forEach((r, i) => {
            const row = document.createElement("div");
            row.style.display="flex"; row.style.justifyContent="space-between"; row.style.alignItems="center";
            row.style.background="#F9FAFB"; row.style.padding="8px"; row.style.marginBottom="6px"; row.style.borderRadius="6px"; row.style.border="1px solid #E5E7EB";
            
            const txt = document.createElement("span");
            txt.innerHTML = `<strong style="color:${r.type==='Available'?'#059669':'#DC2626'}">${escapeHtml(r.type)}</strong>: ${escapeHtml(r.start)} to ${escapeHtml(r.end)}`;
            
            const del = document.createElement("button");
            del.textContent="✕"; del.style.border="none"; del.style.background="transparent"; del.style.color="#9CA3AF"; del.style.cursor="pointer";
            del.onclick = ()=>{ item.timeRules.splice(i,1); saveData(); renderDetailPane(); };
            
            row.appendChild(txt); 
            row.appendChild(del);
            container.appendChild(row);
        });
    } else {
        container.innerHTML = `<div class="muted" style="font-size:0.8rem; margin-bottom:10px;">No specific time rules (Available all day).</div>`;
    }

    // Add New
    const addRow = document.createElement("div");
    addRow.style.display="flex"; addRow.style.gap="8px"; addRow.style.marginTop="12px"; addRow.style.paddingTop="12px"; addRow.style.borderTop="1px dashed #E5E7EB"; addRow.style.flexWrap="wrap"; addRow.style.alignItems="center";
    
    const typeSel = document.createElement("select");
    typeSel.innerHTML = `<option>Available</option><option>Unavailable</option>`;
    typeSel.style.borderRadius="6px"; typeSel.style.border="1px solid #D1D5DB"; typeSel.style.padding="4px";
    
    const startIn = document.createElement("input"); 
    startIn.placeholder="9:00am"; 
    startIn.style.width="70px"; startIn.style.padding="4px"; startIn.style.borderRadius="6px"; startIn.style.border="1px solid #D1D5DB";

    const endIn = document.createElement("input"); 
    endIn.placeholder="10:00am"; 
    endIn.style.width="70px"; endIn.style.padding="4px"; endIn.style.borderRadius="6px"; endIn.style.border="1px solid #D1D5DB";
    
    const btn = document.createElement("button");
    btn.textContent="Add"; 
    btn.style.background="#111"; btn.style.color="white"; btn.style.border="none"; btn.style.borderRadius="6px"; btn.style.padding="4px 12px"; btn.style.cursor="pointer";
    
    btn.onclick = ()=>{
        if(!startIn.value || !endIn.value) { 
            alert("Please enter both start and end times."); 
            return; 
        }
        const startMinParsed = parseTimeToMinutes(startIn.value);
        const endMinParsed = parseTimeToMinutes(endIn.value);
        if(startMinParsed === null){ 
            alert("Invalid Start Time format. Use format like 9:00am"); 
            return; 
        }
        if(endMinParsed === null){ 
            alert("Invalid End Time format. Use format like 10:00am"); 
            return; 
        }
        // ★★★ Save with pre-parsed minutes ★★★
        item.timeRules.push({ 
            type: typeSel.value, 
            start: startIn.value, 
            end: endIn.value,
            startMin: startMinParsed,
            endMin: endMinParsed
        });
        saveData();
        renderDetailPane();
    };

    addRow.appendChild(typeSel);
    addRow.appendChild(startIn);
    addRow.appendChild(document.createTextNode(" to "));
    addRow.appendChild(endIn);
    addRow.appendChild(btn);
    
    container.appendChild(addRow);
    return container;
}

// 5. WEATHER / RAINY DAY AVAILABILITY
function renderWeatherSettings(item) {
    const container = document.createElement("div");
    
    const isIndoor = item.rainyDayAvailable === true;
    
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
    
    // Bind toggle
    container.querySelector('#rainy-day-toggle').onchange = function() {
        item.rainyDayAvailable = this.checked;
        saveData();

        // Update the parent container to reflect the change
        const parentContainer = container.parentElement;
        parentContainer.innerHTML = '';
        parentContainer.appendChild(renderWeatherSettings(item));

        // Update summary
        const summaryEl = container.closest('.detail-section')?.querySelector('.detail-section-summary');
        if (summaryEl) summaryEl.textContent = summaryWeather(item);
    };
    
    return container;
}

//------------------------------------------------------------------
// HELPERS
//------------------------------------------------------------------
function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    const div = document.createElement("div");
    div.textContent = String(str);
    return div.innerHTML;
}

function makeEditable(el, save){
    el.ondblclick = ()=>{
        const inp = document.createElement("input"); 
        inp.value = el.textContent;
        inp.style.fontSize = "inherit"; 
        inp.style.fontWeight = "inherit"; 
        inp.style.border="1px solid #10B981"; 
        inp.style.outline="none"; 
        inp.style.borderRadius="4px";
        inp.style.padding = "2px 6px";
        inp.style.width = Math.max(100, el.offsetWidth + 20) + "px";

        el.replaceWith(inp); 
        inp.focus();
        inp.select();

        const finish = ()=>{ 
            const newVal = inp.value.trim();
            if(newVal && newVal !== el.textContent) {
                save(newVal); 
            } else {
                if(inp.parentNode) inp.replaceWith(el); 
            }
        };

        inp.onblur = finish;
        inp.onkeyup = e=>{ 
            if(e.key==="Enter") finish(); 
            if(e.key==="Escape") { inp.replaceWith(el); }
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

function addField(){
    // ✅ RBAC Check
    if (!window.AccessControl?.checkSetupAccess('add fields')) return;

    const n = addFieldInput.value.trim();
    if(!n) return;

    if(fields.some(f=>f.name.toLowerCase() === n.toLowerCase())){ 
        alert("A field with that name already exists."); 
        return; 
    }

    fields.push({
        name: n,
        activities: [],
        available: true,
        sharableWith: { type:'not_sharable', divisions:[], capacity:1 },
        limitUsage: { enabled:false, divisions:{}, priorityList:[], usePriority: false },
        timeRules: [],
        rainyDayAvailable: false
    });

    addFieldInput.value = "";
    saveData();
    selectedItemId = `field-${n}`;
    renderMasterLists(); 
    renderDetailPane();
}

//------------------------------------------------------------------
// EXPORTS
//------------------------------------------------------------------
window.initFieldsTab = initFieldsTab;
window.fields = fields;

// Export sport metadata getter for scheduler
// Reads directly from global settings so it works before Fields tab is opened
window.getSportMetaData = function() {
    const settings = window.loadGlobalSettings?.() || {};
    const app1 = settings.app1 || {};
    return app1.sportMetaData || {};
};

// Export for external access
// Reads directly from global settings so it works before Fields tab is opened
window.getFields = function() {
    const settings = window.loadGlobalSettings?.() || {};
    const app1 = settings.app1 || {};
    return app1.fields || [];
};

window.getFieldByName = function(name) {
    const allFields = window.getFields();
    return allFields.find(f => f.name === name);
};

// ★★★ NEW: Refresh activity properties from stored fields ★★★
window.refreshActivityPropertiesFromFields = function() {
    const settings = window.loadGlobalSettings?.() || {};
    const fields = settings.app1?.fields || settings.fields || [];
    const specials = settings.app1?.specialActivities || [];
    
    if (!window.activityProperties) window.activityProperties = {};
    
    // Update fields in activityProperties
    fields.forEach(f => {
        if (!f?.name) return;
        
        const normalizedShareable = {
            type: f.sharableWith?.type || 'not_sharable',
            divisions: Array.isArray(f.sharableWith?.divisions) ? f.sharableWith.divisions : [],
            capacity: parseInt(f.sharableWith?.capacity) || (f.sharableWith?.type === 'not_sharable' ? 1 : 2)
        };
        
        window.activityProperties[f.name] = {
            ...window.activityProperties[f.name],
            type: 'field',
            available: f.available !== false,
            sharable: normalizedShareable.type !== 'not_sharable',
            sharableWith: normalizedShareable,
            limitUsage: f.limitUsage ? {
                enabled: f.limitUsage.enabled === true,
                divisions: f.limitUsage.divisions || {},
                priorityList: f.limitUsage.priorityList || [],
                usePriority: f.limitUsage.usePriority === true
            } : null,
            timeRules: Array.isArray(f.timeRules) ? f.timeRules : [],
            rainyDayAvailable: f.rainyDayAvailable === true,
            activities: Array.isArray(f.activities) ? f.activities : []
        };
    });
    
    console.log('🔄 [Fields] activityProperties refreshed from stored fields');
    return window.activityProperties;
};

// ★★★ EXPORT: Field cleanup utility ★★★
window.cleanupDeletedField = cleanupDeletedField;

// ★★★ EXPORT: Field rename propagation utility ★★★  
window.propagateFieldRename = propagateFieldRename;

// ★★★ EXPORT: Division validation utility ★★★
window.validateFieldDivisions = validateFieldDivisions;

// ★★★ COMPREHENSIVE FIELD DIAGNOSTICS ★★★
window.diagnoseFields = function() {
    console.log('\n' + '═'.repeat(60));
    console.log('🔍 FIELD DIAGNOSTICS');
    console.log('═'.repeat(60));
    
    const settings = window.loadGlobalSettings?.() || {};
    const storedFields = settings.app1?.fields || [];
    const rootFields = settings.fields || [];
    const divisions = getValidDivisionNames();
    
    console.log(`\n📊 SUMMARY:`);
    console.log(`   Fields in app1.fields: ${storedFields.length}`);
    console.log(`   Fields in root.fields: ${rootFields.length}`);
    console.log(`   Fields in local array: ${fields.length}`);
    console.log(`   Valid divisions: ${divisions.join(', ') || 'none'}`);
    
    const issues = [];
    
    storedFields.forEach((f, idx) => {
        const fieldIssues = [];
        
        // Check sharableWith structure
        if (!f.sharableWith) {
            fieldIssues.push('Missing sharableWith');
        } else {
            if (!f.sharableWith.type) fieldIssues.push('sharableWith.type missing');
            if (!Array.isArray(f.sharableWith.divisions)) fieldIssues.push('sharableWith.divisions not array');
            if (f.sharableWith.capacity === undefined) fieldIssues.push('sharableWith.capacity missing');
            
            // Check for stale divisions
            if (Array.isArray(f.sharableWith.divisions)) {
                const stale = f.sharableWith.divisions.filter(d => !divisions.includes(d));
                if (stale.length > 0) fieldIssues.push(`Stale sharableWith.divisions: ${stale.join(', ')}`);
            }
        }
        
        // Check limitUsage structure
        if (!f.limitUsage) {
            fieldIssues.push('Missing limitUsage');
        } else {
            if (f.limitUsage.enabled === undefined) fieldIssues.push('limitUsage.enabled missing');
            if (typeof f.limitUsage.divisions !== 'object') fieldIssues.push('limitUsage.divisions not object');
            if (!Array.isArray(f.limitUsage.priorityList)) fieldIssues.push('limitUsage.priorityList not array');
            
            // Check for stale divisions
            if (typeof f.limitUsage.divisions === 'object') {
                const stale = Object.keys(f.limitUsage.divisions).filter(d => !divisions.includes(d));
                if (stale.length > 0) fieldIssues.push(`Stale limitUsage.divisions: ${stale.join(', ')}`);
            }
        }
        
        // Check timeRules
        if (!Array.isArray(f.timeRules)) {
            fieldIssues.push('timeRules not array');
        } else {
            f.timeRules.forEach((rule, rIdx) => {
                if (rule.startMin === undefined) fieldIssues.push(`timeRules[${rIdx}].startMin missing`);
                if (rule.endMin === undefined) fieldIssues.push(`timeRules[${rIdx}].endMin missing`);
            });
        }
        
        // Check rainyDayAvailable
        if (f.rainyDayAvailable === undefined) {
            fieldIssues.push('rainyDayAvailable missing');
        }
        
        if (fieldIssues.length > 0) {
            issues.push({ field: f.name || `[index ${idx}]`, issues: fieldIssues });
        }
    });
    
    if (issues.length === 0) {
        console.log('\n✅ All fields have valid structure!');
    } else {
        console.log(`\n⚠️ ISSUES FOUND (${issues.length} fields):`);
        issues.forEach(item => {
            console.log(`\n   📁 ${item.field}:`);
            item.issues.forEach(issue => console.log(`      - ${issue}`));
        });
    }
    
    // Check activityProperties sync
    console.log('\n📋 ACTIVITY PROPERTIES SYNC:');
    const actProps = window.activityProperties || {};
    storedFields.forEach(f => {
        const prop = actProps[f.name];
        if (!prop) {
            console.log(`   ❌ ${f.name}: NOT in activityProperties`);
        } else if (prop.type !== 'field') {
            console.log(`   ⚠️ ${f.name}: type is "${prop.type}" (should be "field")`);
        } else {
            console.log(`   ✅ ${f.name}: synced`);
        }
    });
    
    console.log('\n' + '═'.repeat(60));
    console.log('💡 Run validateFieldDivisions() to fix stale division refs');
    console.log('💡 Run refreshActivityPropertiesFromFields() to resync');
    console.log('═'.repeat(60) + '\n');
    
    return { fields: storedFields.length, issues: issues.length };
};

})();
