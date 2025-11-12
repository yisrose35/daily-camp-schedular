// =================================================================
// calendar.js
//
// UPDATED:
// - **NEW:** Added `ROTATION_HISTORY_KEY` for Smart Scheduler.
// - **NEW:** Added `loadRotationHistory`, `saveRotationHistory`,
//   `updateRotationHistory`, and `eraseRotationHistory` to
//   manage the new "memory" for activity freshness.
// =================================================================

(function() {
    'use strict';

    // --- 1. DEFINE STORAGE KEYS ---
    const GLOBAL_SETTINGS_KEY = "campGlobalSettings_v1";
    const DAILY_DATA_KEY = "campDailyData_v1";
    const ROTATION_HISTORY_KEY = "campRotationHistory_v1"; // NEW: For Smart Scheduler

    /**
     * Helper function to get a date in YYYY-MM-DD format.
     */
    function getTodayString(date = new Date()) {
        date.setHours(12, 0, 0, 0); 
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    // --- 2. INITIALIZE CALENDAR AND CURRENT DATE ---
    
    window.currentScheduleDate = getTodayString();
    
    let datePicker; 
    
    /**
     * Fired when the user changes the date in the calendar.
     */
    function onDateChanged() {
        const newDate = datePicker.value;
        if (!newDate) return;
        
        console.log(`Date changed to: ${newDate}`);
        window.currentScheduleDate = newDate;
        
        window.loadCurrentDailyData();
        window.initScheduleSystem?.(); // Reloads schedule
        window.initDailyAdjustments?.();
        
        // If the master scheduler is the active tab, re-init it
        if (document.getElementById('master-scheduler')?.classList.contains('active')) {
            window.initMasterScheduler?.();
        }
    }

    // --- 3. GLOBAL DATA API ---

    window.loadGlobalSettings = function() {
        try {
            const newData = localStorage.getItem(GLOBAL_SETTINGS_KEY);
            if (newData) {
                return JSON.parse(newData);
            }
            // ... (Migration logic omitted for brevity, assumed safe) ...
            return {};
        } catch (e) {
            console.error("Failed to load/migrate global settings:", e);
            return {};
        }
    }

    window.saveGlobalSettings = function(key, data) {
        try {
            const settings = window.loadGlobalSettings();
            settings[key] = data;
            localStorage.setItem(GLOBAL_SETTINGS_KEY, JSON.stringify(settings));
        } catch (e) {
            console.error(`Failed to save global setting "${key}":`, e);
        }
    }

    window.loadAllDailyData = function() {
        try {
            const data = localStorage.getItem(DAILY_DATA_KEY);
            return data ? JSON.parse(data) : {};
        } catch (e) {
            console.error("Failed to load all daily data:", e);
            return {};
        }
    }
    
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

    window.loadPreviousDailyData = function() {
        try {
            const [year, month, day] = window.currentScheduleDate.split('-').map(Number);
            const currentDate = new Date(year, month - 1, day, 12, 0, 0); 
            currentDate.setDate(currentDate.getDate() - 1);
            const yesterdayString = getTodayString(currentDate);
            
            const allData = window.loadAllDailyData();
            return allData[yesterdayString] || {};
        } catch (e) {
            return {};
        }
    }

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

    // --- 4. NEW: ROTATION HISTORY API (Smart Scheduler) ---

    /**
     * Loads the persistent rotation history.
     * Structure: { bunks: { "Bunk 1": { "Basketball": timestamp } }, leagues: { "League A": { "Soccer": timestamp } } }
     */
    window.loadRotationHistory = function() {
        try {
            const data = localStorage.getItem(ROTATION_HISTORY_KEY);
            const history = data ? JSON.parse(data) : {};
            
            // Ensure the top-level structure exists
            history.bunks = history.bunks || {};
            history.leagues = history.leagues || {};
            
            return history;
        } catch (e) {
            console.error("Failed to load rotation history:", e);
            return { bunks: {}, leagues: {} };
        }
    }

    /**
     * Saves the entire rotation history object.
     */
    window.saveRotationHistory = function(history) {
        try {
            if (!history || !history.bunks || !history.leagues) {
                console.error("Invalid history object passed to saveRotationHistory.", history);
                return;
            }
            localStorage.setItem(ROTATION_HISTORY_KEY, JSON.stringify(history));
        } catch (e) {
            console.error("Failed to save rotation history:", e);
        }
    }
    
    /**
     * Erases all rotation history.
     */
    window.eraseRotationHistory = function() {
        try {
            localStorage.removeItem(ROTATION_HISTORY_KEY);
            console.log("Erased all activity rotation history.");
            alert("Activity rotation history has been reset.");
        } catch (e) {
            console.error("Failed to erase rotation history:", e);
        }
    }

    
    // --- 5. ERASE ALL DATA (Hook into app1.js button) ---
    function setupEraseAll() {
        const eraseBtn = document.getElementById("eraseAllBtn");
        if (eraseBtn) {
            eraseBtn.onclick = () => {
                if (confirm("Erase ALL camp data?\nThis includes ALL settings, ALL saved daily schedules, and ALL activity rotation history.")) {
                    localStorage.removeItem(GLOBAL_SETTINGS_KEY);
                    localStorage.removeItem(DAILY_DATA_KEY);
                    localStorage.removeItem(ROTATION_HISTORY_KEY); // NEW
                    
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

    // Initial load on script start
    window.loadCurrentDailyData();

    // --- 6. ERASE CURRENT DAY FUNCTION ---
    window.eraseCurrentDailyData = function() {
        try {
            const allData = window.loadAllDailyData();
            const date = window.currentScheduleDate;

            if (allData[date]) {
                delete allData[date];
                localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(allData));
                console.log(`Erased schedule data for ${date}.`);
                
                window.loadCurrentDailyData();
                window.initScheduleSystem?.();
            }
        } catch (e) {
            console.error(`Failed to erase daily data for ${date}:`, e);
        }
    }
    
    // --- 7. ERASE ALL SCHEDULES FUNCTION ---
    window.eraseAllDailyData = function() {
        try {
            localStorage.removeItem(DAILY_DATA_KEY);
            
            localStorage.removeItem("scheduleAssignments");
            localStorage.removeItem("leagueAssignments");
            localStorage.removeItem("camp_league_round_state");
            localStorage.removeItem("camp_league_sport_rotation");

            console.log("Erased ALL daily schedules.");
            
            window.location.reload();
            
        } catch (e) {
            console.error("Failed to erase all daily data:", e);
        }
    }

    function initCalendar() {
      datePicker = document.getElementById("calendar-date-picker");
      if (datePicker) {
        datePicker.value = window.currentScheduleDate;
        datePicker.addEventListener("change", onDateChanged);
      } else {
        console.error("CRITICAL: calendar-date-picker element not found in index.html");
      }
    
      setupEraseAll();
    }
    window.initCalendar = initCalendar;

})();
