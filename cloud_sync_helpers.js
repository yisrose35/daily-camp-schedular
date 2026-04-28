// cloud_sync_helpers.js — Helper functions for syncing camp data types to cloud
// Include: After integration_hooks.js

(function() {
    'use strict';

    // =========================================================================
    // FIELD NORMALIZATION
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
    
    function normalizeField(f) {
        if (!f) return null;
        return {
            name: f.name || '',
            activities: Array.isArray(f.activities) ? f.activities : [],
            available: f.available !== false,
            sharableWith: {
                type: f.sharableWith?.type || 'not_sharable',
                divisions: Array.isArray(f.sharableWith?.divisions) ? f.sharableWith.divisions : [],
                capacity: parseInt(f.sharableWith?.capacity) || (f.sharableWith?.type === 'not_sharable' ? 1 : 2)
            },
            limitUsage: {
                enabled: f.limitUsage?.enabled === true,
                divisions: typeof f.limitUsage?.divisions === 'object' ? f.limitUsage.divisions : {},
                priorityList: Array.isArray(f.limitUsage?.priorityList) ? f.limitUsage.priorityList : [],
                usePriority: f.limitUsage?.usePriority === true
            },
            timeRules: Array.isArray(f.timeRules) ? f.timeRules.map(r => ({
                type: r.type || 'Available',
                start: r.start || '',
                end: r.end || '',
                startMin: r.startMin ?? parseTimeToMinutes(r.start),
                endMin: r.endMin ?? parseTimeToMinutes(r.end)
            })) : [],
            rainyDayAvailable: f.rainyDayAvailable === true,
            ...(f.transition ? { transition: f.transition } : {}),
            ...(f.preferences ? { preferences: f.preferences } : {}),
            ...(f.minDurationMin ? { minDurationMin: f.minDurationMin } : {})
        };
    }

    // =========================================================================
    // HELPER: SYNC SPECIAL ACTIVITIES
    // =========================================================================

    window.saveGlobalSpecialActivities = function(activities) {
        const settings = window.loadGlobalSettings?.() || {};
        if (!settings.app1) settings.app1 = {};
        settings.app1.specialActivities = activities;
        window.saveGlobalSettings?.("app1", settings.app1);
        window.saveGlobalSettings?.("specialActivities", activities);
        console.log("☁️ Special activities queued for sync:", activities.length);
    };

    window.getGlobalSpecialActivities = function() {
        const settings = window.loadGlobalSettings?.() || {};
        return settings.specialActivities || settings.app1?.specialActivities || [];
    };

    // =========================================================================
    // HELPER: SYNC FIELDS
    // =========================================================================

    window.saveGlobalFields = function(fields) {
        if (!Array.isArray(fields)) { console.warn("☁️ saveGlobalFields: Invalid input, expected array"); return; }
        const normalizedFields = fields.map(f => normalizeField(f)).filter(Boolean);
        const settings = window.loadGlobalSettings?.() || {};
        if (!settings.app1) settings.app1 = {};
        settings.app1.fields = normalizedFields;
        window.saveGlobalSettings?.("app1", settings.app1);
        window.saveGlobalSettings?.("fields", normalizedFields);
        console.log("☁️ Fields queued for sync:", normalizedFields.length);
        if (typeof window.refreshActivityPropertiesFromFields === 'function') {
            setTimeout(() => window.refreshActivityPropertiesFromFields(), 50);
        }
    };

    window.getGlobalFields = function() {
        const settings = window.loadGlobalSettings?.() || {};
        return settings.fields || settings.app1?.fields || [];
    };

    // =========================================================================
    // HELPER: SYNC SPORTS
    // =========================================================================

    window.getAllGlobalSports = function() {
        const settings = window.loadGlobalSettings?.() || {};
        return settings.allSports || settings.app1?.allSports || [
            "Baseball", "Basketball", "Football", "Hockey", "Kickball",
            "Lacrosse", "Newcomb", "Punchball", "Soccer", "Volleyball"
        ];
    };

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

    window.syncAllDataToCloud = async function() {
        console.log("☁️ Syncing all data to cloud...");
        const settings = window.loadGlobalSettings?.() || {};
        if (settings.app1?.divisions && !settings.divisions) settings.divisions = settings.app1.divisions;
        if (settings.app1?.bunks && !settings.bunks) settings.bunks = settings.app1.bunks;
        if (typeof window.setCloudState === 'function') {
            await window.setCloudState(settings, true);
        } else if (typeof window.forceSyncToCloud === 'function') {
            await window.forceSyncToCloud();
        }
        console.log("☁️ All data synced to cloud");
    };

    const originalSaveGlobalSettings = window.saveGlobalSettings;
    if (originalSaveGlobalSettings && !originalSaveGlobalSettings._cloudHelpersHooked) {
        window.saveGlobalSettings = function(key, data) {
            const result = originalSaveGlobalSettings(key, data);
            return result;
        };
        window.saveGlobalSettings._cloudHelpersHooked = true;
        // Propagate the authoritative-handler flag so callers (e.g. campistry_me.save())
        // use the fine-grained save path rather than falling through to forceSyncToCloud,
        // which reads stale _localCache and would clobber fresh local data on next hydrate.
        if (originalSaveGlobalSettings._isAuthoritativeHandler) {
            window.saveGlobalSettings._isAuthoritativeHandler = true;
        }
    }

    window.normalizeFieldForSave = normalizeField;

    console.log('☁️ [cloud_sync_helpers] loaded');
    // =========================================================================
    // HELPER: SYNC PRINT TEMPLATES
    // =========================================================================

    window.saveGlobalPrintTemplates = function(templates) {
        if (!Array.isArray(templates)) { console.warn("☁️ saveGlobalPrintTemplates: Invalid input, expected array"); return; }
        const validatedTemplates = templates.map(tpl => {
            const copy = { ...tpl };
            if (copy.campLogo && copy.campLogo.length > 500000) {
                console.warn("☁️ Print template logo is large:", (copy.campLogo.length / 1024).toFixed(0) + "KB");
            }
            return copy;
        });
        window.saveGlobalSettings?.("printTemplates", validatedTemplates);
        try {
            localStorage.setItem('campistry_print_templates', JSON.stringify(validatedTemplates));
        } catch (e) {
            console.warn("☁️ localStorage write failed for print templates:", e);
        }
        console.log("☁️ Print templates queued for sync:", validatedTemplates.length);
    };

    window.getGlobalPrintTemplates = function() {
        const settings = window.loadGlobalSettings?.() || {};
        const cloudTemplates = settings.printTemplates || [];
        if (cloudTemplates.length > 0) return cloudTemplates;
        try {
            const raw = localStorage.getItem('campistry_print_templates');
            if (raw) return JSON.parse(raw);
        } catch (e) {
            console.warn("☁️ Failed to read local print templates:", e);
        }
        return [];
    };
})();
