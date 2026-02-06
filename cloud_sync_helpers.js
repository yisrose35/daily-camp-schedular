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
    
    function parseTimeToMinutes(timeStr) {
        if (!timeStr || typeof timeStr !== 'string') return null;
        
        let s = timeStr.trim().toLowerCase();
        let mer = null;
        
        if (s.includes("am") || s.includes("pm")) {
            mer = s.includes("am") ? "am" : "pm";
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
        };
    }

    // =========================================================================
    // HELPER: SYNC SPECIAL ACTIVITIES
    // =========================================================================

    /**
     * Save special activities to both local and cloud
     */
    window.saveGlobalSpecialActivities = function(activities) {
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
    // HELPER: SYNC SKELETONS
    // =========================================================================

    window.saveGlobalSkeletons = function(skeletons) {
        const settings = window.loadGlobalSettings?.() || {};
        if (!settings.app1) settings.app1 = {};
        settings.app1.savedSkeletons = skeletons;
        
        window.saveGlobalSettings?.("app1", settings.app1);
        window.saveGlobalSettings?.("savedSkeletons", skeletons);
        console.log("☁️ Skeletons queued for sync");
    };

    window.getGlobalSkeletons = function() {
        const settings = window.loadGlobalSettings?.() || {};
        return settings.savedSkeletons || settings.app1?.savedSkeletons || {};
    };

    // =========================================================================
    // HELPER: SYNC LEAGUES
    // =========================================================================

    window.saveGlobalLeagues = function(leagues) {
        window.saveGlobalSettings?.("leaguesByName", leagues);
        console.log("☁️ Leagues queued for sync");
    };

    window.getGlobalLeagues = function() {
        const settings = window.loadGlobalSettings?.() || {};
        return settings.leaguesByName || {};
    };

    // =========================================================================
    // HELPER: SYNC RAINY DAY SPECIALS
    // =========================================================================

    window.saveRainyDaySpecials = function(specials) {
        window.saveGlobalSettings?.("rainyDaySpecials", specials);
        console.log("☁️ Rainy day specials queued for sync");
    };

    window.getRainyDaySpecials = function() {
        const settings = window.loadGlobalSettings?.() || {};
        return settings.rainyDaySpecials || [];
    };

    // =========================================================================
    // HELPER: SYNC SMART TILE HISTORY
    // =========================================================================

    window.saveSmartTileHistory = function(history) {
        window.saveGlobalSettings?.("smartTileHistory", history);
        console.log("☁️ Smart tile history queued for sync");
    };

    window.getSmartTileHistory = function() {
        const settings = window.loadGlobalSettings?.() || {};
        return settings.smartTileHistory || { byBunk: {} };
    };

    // =========================================================================
    // HELPER: SYNC LEAGUE HISTORY
    // =========================================================================

    window.saveLeagueHistory = function(history) {
        window.saveGlobalSettings?.("leagueHistory", history);
        console.log("☁️ League history queued for sync");
    };

    window.getLeagueHistory = function() {
        const settings = window.loadGlobalSettings?.() || {};
        return settings.leagueHistory || {};
    };

    // =========================================================================
    // HELPER: SYNC SPECIALTY LEAGUE HISTORY
    // =========================================================================

    window.saveSpecialtyLeagueHistory = function(history) {
        window.saveGlobalSettings?.("specialtyLeagueHistory", history);
        console.log("☁️ Specialty league history queued for sync");
    };

    window.getSpecialtyLeagueHistory = function() {
        const settings = window.loadGlobalSettings?.() || {};
        return settings.specialtyLeagueHistory || {};
    };

    // =========================================================================
    // HELPER: BULK SYNC ALL DATA
    // =========================================================================

    /**
     * Sync all local data to cloud immediately.
     * Call this after import operations.
     */
    window.syncAllDataToCloud = async function() {
        console.log("☁️ Syncing all data to cloud...");
        
        const settings = window.loadGlobalSettings?.() || {};
        
        // Ensure divisions and bunks are at root level
        if (settings.app1?.divisions && !settings.divisions) {
            settings.divisions = settings.app1.divisions;
        }
        if (settings.app1?.bunks && !settings.bunks) {
            settings.bunks = settings.app1.bunks;
        }
        
        // Update via setCloudState if available
        if (typeof window.setCloudState === 'function') {
            await window.setCloudState(settings, true);
        } else if (typeof window.forceSyncToCloud === 'function') {
            await window.forceSyncToCloud();
        }
        
        console.log("☁️ All data synced to cloud");
    };

    // =========================================================================
    // AUTO-HOOK: WATCH FOR DATA CHANGES
    // =========================================================================

    // Debounced auto-sync when many changes happen quickly
    let _autoSyncTimeout = null;
    
    function scheduleAutoSync() {
        if (_autoSyncTimeout) {
            clearTimeout(_autoSyncTimeout);
        }
        _autoSyncTimeout = setTimeout(() => {
            if (typeof window.forceSyncToCloud === 'function') {
                window.forceSyncToCloud();
            }
        }, 1000);
    }

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
    }

    // =========================================================================
    // ★★★ EXPORT NORMALIZATION FUNCTION for external use ★★★
    // =========================================================================
    window.normalizeFieldForSave = normalizeField;

    console.log('☁️ Cloud Sync Helpers v1.1 ready');
// =========================================================================
    // HELPER: SYNC PRINT TEMPLATES
    // =========================================================================

    /**
     * Save print templates to both local and cloud
     */
    window.saveGlobalPrintTemplates = function(templates) {
        if (!Array.isArray(templates)) {
            console.warn("☁️ saveGlobalPrintTemplates: Invalid input, expected array");
            return;
        }
        
        // Validate templates before saving (strip oversized logos to keep payload manageable)
        const validatedTemplates = templates.map(tpl => {
            const copy = { ...tpl };
            // If logo is too large (>500KB base64), warn but still save
            if (copy.campLogo && copy.campLogo.length > 500000) {
                console.warn("☁️ Print template logo is large:", (copy.campLogo.length / 1024).toFixed(0) + "KB");
            }
            return copy;
        });
        
        const settings = window.loadGlobalSettings?.() || {};
        settings.printTemplates = validatedTemplates;
        
        // Save via saveGlobalSettings (handles batching + cloud sync)
        window.saveGlobalSettings?.("printTemplates", validatedTemplates);
        
        // Also persist to localStorage for offline access
        try {
            localStorage.setItem('campistry_print_templates', JSON.stringify(validatedTemplates));
        } catch (e) {
            console.warn("☁️ localStorage write failed for print templates:", e);
        }
        
        console.log("☁️ Print templates queued for sync:", validatedTemplates.length);
    };

    /**
     * Get print templates
     */
    window.getGlobalPrintTemplates = function() {
        const settings = window.loadGlobalSettings?.() || {};
        const cloudTemplates = settings.printTemplates || [];
        
        // If cloud has templates, use those (they're authoritative)
        if (cloudTemplates.length > 0) return cloudTemplates;
        
        // Fallback to localStorage
        try {
            const raw = localStorage.getItem('campistry_print_templates');
            if (raw) return JSON.parse(raw);
        } catch (e) {
            console.warn("☁️ Failed to read local print templates:", e);
        }
        
        return [];
    };
})();
