// =================================================================
// calendar.js
// This is the new "brain" of the application.
// It manages the currently selected date and all data saving/loading.
// All other files will call functions from this file.
//
// NEW: Now includes a one-time migration for old data.
// =================================================================

(function() {
    'use strict';

    // --- 1. DEFINE STORAGE KEYS ---
    const GLOBAL_SETTINGS_KEY = "campGlobalSettings_v1";
    const DAILY_DATA_KEY = "campDailyData_v1";

    /**
     * Helper function to get a date in YYYY-MM-DD format.
     */
    function getTodayString(date = new Date()) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    // --- 2. INITIALIZE CALENDAR AND CURRENT DATE ---
    
    window.currentScheduleDate = getTodayString();
    
    let datePicker; 
    
    document.addEventListener("DOMContentLoaded", () => {
        datePicker = document.getElementById("calendar-date-picker");
        if (datePicker) {
            datePicker.value = window.currentScheduleDate;
            datePicker.addEventListener("change", onDateChanged);
        } else {
            console.error("CRITICAL: calendar-date-picker element not found in index.html");
        }
    });

    /**
     * Fired when the user changes the date in the calendar.
     */
    function onDateChanged() {
        const newDate = datePicker.value;
        if (!newDate) return;
        
        console.log(`Date changed to: ${newDate}`);
        window.currentScheduleDate = newDate;
        
        // 1. Load the new day's data
        window.loadCurrentDailyData();
        
        // 2. Tell app2.js to re-initialize and render the schedule
        window.initScheduleSystem?.();
        
        // 3. Tell daily_overrides.js to refresh its view
        window.initDailyOverrides?.();
    }

    // --- 3. NEW GLOBAL DATA API ---

    /**
     * [GLOBAL] Loads the entire "Global Settings" object (bunks, fields, etc.)
     * --- NEW: Includes one-time migration logic ---
     */
    window.loadGlobalSettings = function() {
        try {
            // 1. Try to load the new settings format
            const newData = localStorage.getItem(GLOBAL_SETTINGS_KEY);
            if (newData) {
                return JSON.parse(newData);
            }

            // 2. If it doesn't exist, try to migrate old data
            console.warn("New settings key not found. Attempting to migrate old data...");
            
            let newSettings = {};
            let didMigrate = false;

            // 2a. Migrate app1.js data ("campSchedulerData")
            const oldApp1Data = localStorage.getItem("campSchedulerData");
            if (oldApp1Data) {
                newSettings.app1 = JSON.parse(oldApp1Data);
                localStorage.removeItem("campSchedulerData"); // Clean up
                didMigrate = true;
                console.log("Migrated old app1 data.");
            }

            // 2b. Migrate leagues.js data ("leagues")
            const oldLeaguesData = localStorage.getItem("leagues");
            if (oldLeaguesData) {
                newSettings.leaguesByName = JSON.parse(oldLeaguesData);
                localStorage.removeItem("leagues"); // Clean up
                didMigrate = true;
                console.log("Migrated old leagues data.");
            }

            // 2c. Migrate dailyActivities.js data ("fixedActivities_v2")
            const oldFixedData = localStorage.getItem("fixedActivities_v2") || localStorage.getItem("fixedActivities");
            if (oldFixedData) {
                newSettings.fixedActivities = JSON.parse(oldFixedData);
                localStorage.removeItem("fixedActivities_v2"); // Clean up
                localStorage.removeItem("fixedActivities");
                didMigrate = true;
                console.log("Migrated old fixed activities data.");
            }

            // 3. If we migrated anything, save it in the new format
            if (didMigrate) {
                console.log("Migration successful. Saving to new global settings.", newSettings);
                localStorage.setItem(GLOBAL_SETTINGS_KEY, JSON.stringify(newSettings));
                return newSettings;
            }

            // 4. If nothing to migrate, just return an empty object
            return {};

        } catch (e) {
            console.error("Failed to load/migrate global settings:", e);
            return {};
        }
    }


    /**
     * [GLOBAL] Saves one piece of the "Global Settings" (e.g., "fields" or "leagues")
     */
    window.saveGlobalSettings = function(key, data) {
        try {
            const settings = window.loadGlobalSettings();
            settings[key] = data;
            localStorage.setItem(GLOBAL_SETTINGS_KEY, JSON.stringify(settings));
        } catch (e) {
            console.error(`Failed to save global setting "${key}":`, e);
        }
    }

    /**
     * [DAILY] Loads the *entire* daily data object (all dates).
     */
    window.loadAllDailyData = function() {
        try {
            const data = localStorage.getItem(DAILY_DATA_KEY);
            return data ? JSON.parse(data) : {};
        } catch (e) {
            console.error("Failed to load all daily data:", e);
            return {};
        }
    }
    
    /**
     * [DAILY] Gets the data object *for the currently selected date*.
     */
    window.loadCurrentDailyData = function() {
        const allData = window.loadAllDailyData();
        const date = window.currentScheduleDate;
        
        if (!allData[date]) {
            allData[date] = {
                scheduleAssignments: {},
                leagueAssignments: {},
                leagueRoundState: {},
                leagueSportRotation: {},
                overrides: { fields: [], bunks: [], leagues: [] } 
            };
        }
        
        window.currentDailyData = allData[date];
        return window.currentDailyData;
    }

    /**
     * [DAILY] Saves a piece of data *to the currently selected date*.
     */
    window.saveCurrentDailyData = function(key, data) {
        try {
            const allData = window.loadAllDailyData();
            const date = window.currentScheduleDate;

            if (!allData[date]) {
                allData[date] = {};
            }

            allData[date][key] = data;
            localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(allData));
            
            window.currentDailyData = allData[date];
            
        } catch (e) {
            console.error(`Failed to save daily data for ${date} with key "${key}":`, e);
        }
    }
    
    // --- 4. ERASE ALL DATA (Hook into app1.js button) ---
    function setupEraseAll() {
        const eraseBtn = document.getElementById("eraseAllBtn");
        if (eraseBtn) {
            eraseBtn.onclick = () => {
                if (confirm("Erase ALL camp data?\nThis includes ALL settings and ALL saved daily schedules.")) {
                    localStorage.removeItem(GLOBAL_SETTINGS_KEY);
                    localStorage.removeItem(DAILY_DATA_KEY);
                    
                    // Clear old keys
                    localStorage.removeItem("campSchedulerData");
                    localStorage.removeItem("fixedActivities_v2");
                    localStorage.removeItem("leagues");
                    localStorage.removeItem("camp_league_round_state");
                    localStorage.removeItem("camp_league_sport_rotation");
                    localStorage.removeItem("scheduleAssignments");
                    localStorage.removeItem("leagueAssignments");

                    window.location.reload();
                }
            };
        }
    }
    document.addEventListener("DOMContentLoaded", setupEraseAll);

    // Initial load on script start
    window.loadCurrentDailyData();

})();
