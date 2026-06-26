// =============================================================================
// cloud_sync_helpers.js — Ensures ALL Data Syncs to Cloud
// =============================================================================
//
// This file provides helper functions that ensure all camp data types
// (divisions, bunks, fields, activities, etc.) properly sync to the cloud.
//
// INCLUDE: After integration_hooks.js
//
// v1.1: ★★★ ADDED FIELD NORMALIZATION to saveGlobalFields() ★★★
//
// =============================================================================

(function() {
    'use strict';

    console.log('☁️ Cloud Sync Helpers v1.1 loading...');

    // =========================================================================
    // ★★★ FIELD NORMALIZATION HELPER ★★★
    // Ensures complete field structure before save
    // =========================================================================
    
    function parseTimeToMinutes(timeStr) { return window.CampUtils.parseTimeToMinutes(timeStr); }  // → campistry_utils.js (canonical superset; equivalence harness-proven)
    
    /**
     * Normalize a single field to ensure complete structure
     * @param {Object} f - Field object
     * @returns {Object} - Normalized field object
     */
    function normalizeField(f) {
        if (!f) return null;
        
        return {
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
            
            // ★ Access restrictions - ensure complete structure  
             accessRestrictions: {
                enabled: f.accessRestrictions?.enabled === true,
                divisions: typeof f.accessRestrictions?.divisions === 'object' ? f.accessRestrictions.divisions : {},
                priorityList: Array.isArray(f.accessRestrictions?.priorityList) ? f.accessRestrictions.priorityList : [],
                usePriority: f.accessRestrictions?.usePriority === true
            },
            
            // ★ Time rules - ensure array with parsed times.
            // Preserve `divisions` so per-grade scoping survives cloud round-trips
            // (e.g. "Available 11-12 for grade 1, 12-1 for grade 2").
            timeRules: Array.isArray(f.timeRules) ? f.timeRules.map(r => ({
                type: r.type || 'Available',
                start: r.start || '',
                end: r.end || '',
                startMin: r.startMin ?? parseTimeToMinutes(r.start),
                endMin: r.endMin ?? parseTimeToMinutes(r.end),
                divisions: Array.isArray(r.divisions) ? [...r.divisions] : []
            })) : [],
            
            // ★ Indoor/Outdoor for rainy day
            rainyDayAvailable: f.rainyDayAvailable === true,
            
            // Preserve per-grade sharing overrides
            ...(f.gradeShareRules ? { gradeShareRules: f.gradeShareRules } : {}),
            // Preserve field quality group membership
            ...(f.fieldGroup != null ? { fieldGroup: f.fieldGroup } : {}),
            ...(f.qualityRank != null ? { qualityRank: f.qualityRank } : {}),
            // Preserve any additional properties
            ...(f.transition ? { transition: f.transition } : {}),
            ...(f.preferences ? { preferences: f.preferences } : {}),
            ...(f.minDurationMin ? { minDurationMin: f.minDurationMin } : {})
        };
    }

    // =========================================================================
    // HELPER: SYNC SPECIAL ACTIVITIES
    // =========================================================================

    // Case-insensitive de-dupe of special-activity rows. This camp's data can
    // hold duplicate rows that differ only by case ("Sushi" vs "sushi") — a
    // cloud-sync casing drift between the top-level and app1 stores, which
    // facilities.js then reconstructs into a phantom default (no access
    // restriction). Plain exact-name de-dupe lets both survive, and the
    // unrestricted phantom defeats the user's restriction. Collapse by
    // lowercased name, PREFERRING the row that carries an enabled access
    // restriction (the real configured one) and, on a tie, the row that has a
    // location (the phantom default is blank). Single source of truth, reused
    // by app1.js's saveGlobalSpecialActivities and special_activities.js's
    // getAllSpecialActivities.
    window.dedupeSpecialsByName = function(list) {
        const byKey = new Map();
        (Array.isArray(list) ? list : []).forEach(function(a) {
            if (!a || !a.name) return;
            const k = String(a.name).trim().toLowerCase();
            const ex = byKey.get(k);
            if (!ex) { byKey.set(k, a); return; }
            const exR = !!(ex.accessRestrictions && ex.accessRestrictions.enabled);
            const aR  = !!(a.accessRestrictions  && a.accessRestrictions.enabled);
            if (aR && !exR) { byKey.set(k, a); return; }          // restricted copy wins
            if (aR === exR && !ex.location && a.location) byKey.set(k, a); // tie → prefer one with a location
        });
        return Array.from(byKey.values());
    };

    /**
     * Save special activities to both local and cloud
     */
    window.saveGlobalSpecialActivities = function(activities) {
        // ★ Heal case-variant duplicates before persisting (see dedupeSpecialsByName).
        activities = window.dedupeSpecialsByName(activities);
        // Save to app1 structure (for compatibility)
        const settings = window.loadGlobalSettings?.() || {};
        if (!settings.app1) settings.app1 = {};
        settings.app1.specialActivities = activities;

        // Also save at root level for easier access
        window.saveGlobalSettings?.("app1", settings.app1);
        window.saveGlobalSettings?.("specialActivities", activities);

        console.log("☁️ Special activities queued for sync:", activities.length);
    };

    /**
     * Get special activities
     */
    window.getGlobalSpecialActivities = function() {
        const settings = window.loadGlobalSettings?.() || {};
        return settings.specialActivities || settings.app1?.specialActivities || [];
    };

    // =========================================================================
    // HELPER: SYNC FIELDS - ★★★ NOW WITH NORMALIZATION ★★★
    // =========================================================================

    /**
     * Save fields to both local and cloud
     * ★★★ v1.1: Now normalizes fields before save ★★★
     */
    window.saveGlobalFields = function(fields) {
        if (!Array.isArray(fields)) {
            console.warn("☁️ saveGlobalFields: Invalid input, expected array");
            return;
        }
        
        // ★★★ NORMALIZE ALL FIELDS before saving ★★★
        const normalizedFields = fields.map(f => normalizeField(f)).filter(Boolean);
        
        const settings = window.loadGlobalSettings?.() || {};
        if (!settings.app1) settings.app1 = {};
        settings.app1.fields = normalizedFields;
        
        window.saveGlobalSettings?.("app1", settings.app1);
        window.saveGlobalSettings?.("fields", normalizedFields);
        
        console.log("☁️ Fields queued for sync (normalized):", normalizedFields.length);
        
        // ★★★ REFRESH ACTIVITY PROPERTIES if available ★★★
        if (typeof window.refreshActivityPropertiesFromFields === 'function') {
            setTimeout(() => window.refreshActivityPropertiesFromFields(), 50);
        }
    };

    /**
     * Get fields
     */
    window.getGlobalFields = function() {
        const settings = window.loadGlobalSettings?.() || {};
        return settings.fields || settings.app1?.fields || [];
    };

    // =========================================================================
    // HELPER: SYNC SPORTS
    // =========================================================================

    /**
     * Get all global sports
     */
    window.getAllGlobalSports = function() {
        const settings = window.loadGlobalSettings?.() || {};
        return settings.allSports || settings.app1?.allSports || [
            "Baseball", "Basketball", "Football", "Hockey", "Kickball",
            "Lacrosse", "Newcomb", "Punchball", "Soccer", "Volleyball"
        ];
    };

    /**
     * Add a global sport
     */
    window.addGlobalSport = function(sportName) {
        const settings = window.loadGlobalSettings?.() || {};
        if (!settings.app1) settings.app1 = {};
        
        const sports = settings.allSports || settings.app1?.allSports || [];
        if (!sports.includes(sportName)) {
            sports.push(sportName);
            settings.app1.allSports = sports;
            window.saveGlobalSettings?.("app1", settings.app1);
            window.saveGlobalSettings?.("allSports", sports);
            console.log("☁️ Added sport:", sportName);
        }
    };

    /**
     * Remove a global sport
     */
    window.removeGlobalSport = function(sportName) {
        const settings = window.loadGlobalSettings?.() || {};
        if (!settings.app1) settings.app1 = {};

        let sports = settings.allSports || settings.app1?.allSports || [];
        sports = sports.filter(s => s !== sportName);

        settings.app1.allSports = sports;
        window.saveGlobalSettings?.("app1", settings.app1);
        window.saveGlobalSettings?.("allSports", sports);
        console.log("☁️ Removed sport:", sportName);
        if (typeof window.cleanupDeletedSport === 'function') {
            window.cleanupDeletedSport(sportName);
        }
    };

    // =========================================================================
    // HELPER: SYNC LOCATION ZONES
    // =========================================================================

    window.saveLocationZones = function(zones) {
        window.saveGlobalSettings?.("locationZones", zones);
        console.log("☁️ Location zones queued for sync");
    };

    window.getLocationZones = function() {
        const settings = window.loadGlobalSettings?.() || {};
        return settings.locationZones || {};
    };

    // =========================================================================
    // HELPER: SYNC PINNED TILE DEFAULTS
    // =========================================================================

    window.savePinnedTileDefaults = function(defaults) {
        window.saveGlobalSettings?.("pinnedTileDefaults", defaults);
        console.log("☁️ Pinned tile defaults queued for sync");
    };

    window.getPinnedTileDefaults = function() {
        const settings = window.loadGlobalSettings?.() || {};
        return settings.pinnedTileDefaults || {};
    };


    // =========================================================================
    // AUTO-HOOK: WATCH FOR DATA CHANGES
    // =========================================================================

    // Hook into common save patterns
    const originalSaveGlobalSettings = window.saveGlobalSettings;
    if (originalSaveGlobalSettings && !originalSaveGlobalSettings._cloudHelpersHooked) {
        window.saveGlobalSettings = function(key, data) {
            const result = originalSaveGlobalSettings(key, data);

            // Log what's being saved
            console.log(`☁️ [${key}] queued for cloud sync`);

            return result;
        };
        window.saveGlobalSettings._cloudHelpersHooked = true;
        // Propagate the authoritative-handler flag from the inner handler.
        // Callers (e.g. campistry_me.save()) branch on this flag to choose the
        // fine-grained saveGlobalSettings path over a forceSyncToCloud fallback.
        // Without it, Me falls through to forceSyncToCloud, which reads stale
        // _localCache and pushes stale state to cloud with a fresh timestamp —
        // causing local data (e.g. new campers) to get clobbered on next hydrate.
        if (originalSaveGlobalSettings._isAuthoritativeHandler) {
            window.saveGlobalSettings._isAuthoritativeHandler = true;
        }
    }

    // =========================================================================
    // ★★★ EXPORT NORMALIZATION FUNCTION for external use ★★★
    // =========================================================================
    window.normalizeFieldForSave = normalizeField;

    console.log('☁️ Cloud Sync Helpers v1.1 ready');
})();
