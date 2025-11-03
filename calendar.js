// =================================================================
// calendar.js
// This is the new "brain" of the application.
// It manages the currently selected date and all data saving/loading.
// All other files will call functions from this file.
// =================================================================

(function() {
    'use strict';

    // --- 1. DEFINE STORAGE KEYS ---
    // Stores "Setup" data: bunks, fields, divisions, league definitions, fixed activities
    const GLOBAL_SETTINGS_KEY = "campGlobalSettings_v1";
    
    // Stores "Daily" data: generated schedules, league round states, sport rotations, overrides
    const DAILY_DATA_KEY = "campDailyData_v1";

    /**
     * Helper function to get a date in YYYY-MM-DD format.
     * @param {Date} date - The date object to format.
     * @returns {string} - The date as "YYYY-MM-DD".
     */
    function getTodayString(date = new Date()) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    // --- 2. INITIALIZE CALENDAR AND CURRENT DATE ---
    
    // Set the global date for all other scripts to see.
    window.currentScheduleDate = getTodayString();
    
    let datePicker; // Will hold the <input type="date"> element
    
    document.addEventListener("DOMContentLoaded", () => {
        datePicker = document.getElementById("calendar-date-picker");
        if (datePicker) {
            // Set the calendar to today's date on load
            datePicker.value = window.currentScheduleDate;
            
            // Add the main event listener for the app
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
        
        // 1. Load the new day's data (or an empty object if it's a new day)
        window.loadCurrentDailyData();
        
        // 2. Tell app2.js to re-initialize and render the schedule for this new date
        //    (This will load the saved schedule or show a blank grid)
        window.initScheduleSystem?.();
    }

    // --- 3. NEW GLOBAL DATA API ---
    // These functions will be called by all other files.

    /**
     * [GLOBAL] Loads the entire "Global Settings" object (bunks, fields, etc.)
     */
    window.loadGlobalSettings = function() {
        try {
            const data = localStorage.getItem(GLOBAL_SETTINGS_KEY);
            return data ? JSON.parse(data) : {};
        } catch (e) {
            console.error("Failed to load global settings:", e);
            return {};
        }
    }

    /**
     * [GLOBAL] Saves one piece of the "Global Settings" (e.g., "fields" or "leagues")
     * @param {string} key - The key for the setting (e.g., "bunks", "leaguesByName")
     * @param {any} data - The data to save (e.g., the array of bunks)
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
     * Used internally by the other daily functions.
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
     * This is what app2.js will use to read the schedule.
     */
    window.loadCurrentDailyData = function() {
        const allData = window.loadAllDailyData();
        const date = window.currentScheduleDate;
        
        if (!allData[date]) {
            // This is a new day! Create an empty object for it.
            allData[date] = {
                scheduleAssignments: {},
                leagueAssignments: {},
                leagueRoundState: {},
                leagueSportRotation: {},
                overrides: { fields: [], bunks: [], leagues: [] } // For our next feature
            };
        }
        
        // Expose this day's data globally for app2.js, league_scheduling.js
        window.currentDailyData = allData[date];
        return window.currentDailyData;
    }

    /**
     * [DAILY] Saves a piece of data *to the currently selected date*.
     * This is what app2.js will use to save a schedule.
     * @param {string} key - The key for the data (e.g., "scheduleAssignments")
     * @param {any} data - The data to save (e.g., the schedule object)
     */
    window.saveCurrentDailyData = function(key, data) {
        try {
            const allData = window.loadAllDailyData();
            const date = window.currentScheduleDate;

            // Ensure the object for this date exists
            if (!allData[date]) {
                allData[date] = {};
            }

            // Save the specific piece of data (e.g., the schedule)
            allData[date][key] = data;

            // Save the entire daily data object back to localStorage
            localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(allData));
            
            // Refresh the global object
            window.currentDailyData = allData[date];
            
        } catch (e) {
            console.error(`Failed to save daily data for ${date} with key "${key}":`, e);
        }
    }
    
    // --- 4. ERASE ALL DATA (Hook into app1.js button) ---
    /**
     * Overwrites the old "eraseAllBtn" click handler to also delete new data.
     */
    function setupEraseAll() {
        const eraseBtn = document.getElementById("eraseAllBtn");
        if (eraseBtn) {
            // We're taking over this button's click event
            eraseBtn.onclick = () => {
                if (confirm("Erase ALL camp data?\nThis includes ALL settings and ALL saved daily schedules.")) {
                    localStorage.removeItem(GLOBAL_SETTINGS_KEY);
                    localStorage.removeItem(DAILY_DATA_KEY);
                    
                    // Also clear old keys just in case
                    localStorage.removeItem("campSchedulerData");
                    localStorage.removeItem("fixedActivities_v2");
                    localStorage.removeItem("leagues");
                    localStorage.removeItem("camp_league_round_state");
                    localStorage.removeItem("camp_league_sport_rotation");
                    localStorage.removeItem("scheduleAssignments");
                    localStorage.removeItem("leagueAssignments");

                    // Hard reload the page to reset everything
                    window.location.reload();
                }
            };
        }
    }
    document.addEventListener("DOMContentLoaded", setupEraseAll);


    // Initial load on script start
    window.loadCurrentDailyData();

})();
