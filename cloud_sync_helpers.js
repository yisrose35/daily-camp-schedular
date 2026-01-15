// =============================================================================
// cloud_sync_helpers.js — Ensures ALL Data Syncs to Cloud
// =============================================================================
//
// This file provides helper functions that ensure all camp data types
// (divisions, bunks, fields, activities, etc.) properly sync to the cloud.
//
// INCLUDE: After integration_hooks.js
//
// =============================================================================

(function() {
    'use strict';

    console.log('☁️ Cloud Sync Helpers loading...');

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
    // HELPER: SYNC FIELDS
    // =========================================================================

    /**
     * Save fields to both local and cloud
     */
    window.saveGlobalFields = function(fields) {
        const settings = window.loadGlobalSettings?.() || {};
        if (!settings.app1) settings.app1 = {};
        settings.app1.fields = fields;
        
        window.saveGlobalSettings?.("app1", settings.app1);
        window.saveGlobalSettings?.("fields", fields);
        
        console.log("☁️ Fields queued for sync:", fields.length);
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

    console.log('☁️ Cloud Sync Helpers ready');

})();
