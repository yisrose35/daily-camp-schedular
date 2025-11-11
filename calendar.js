// =================================================================
// calendar.js
//
// UPDATED:
// - `onDateChanged`: Changed reference from
//   `initDailyOverrides` to `initDailyAdjustments`.
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
        window.initDailyAdjustments?.(); // <-- UPDATED
        
        // If the master scheduler is the active tab, re-init it
        // to load the correct skeleton for the new day.
        if (document.getElementById('master-scheduler')?.classList.contains('active')) {
            window.initMasterScheduler?.();
        }
    }

    // --- 3. NEW GLOBAL DATA API ---

    window.loadGlobalSettings = function() {
        try {
            const newData = localStorage.getItem(GLOBAL_SETTINGS_KEY);
            if (newData) {
                return JSON.parse(newData);
            }
            console.warn("New settings key not found. Attempting to migrate old data...");
            let newSettings = {};
            let didMigrate = false;
            const oldApp1Data = localStorage.getItem("campSchedulerData");
            if (oldApp1Data) {
                newSettings.app1 = JSON.parse(oldApp1Data);
                localStorage.removeItem("campSchedulerData"); 
                didMigrate = true;
                console.log("Migrated old app1 data.");
            }
            const oldLeaguesData = localStorage.getItem("leagues");
            if (oldLeaguesData) {
                newSettings.leaguesByName = JSON.parse(oldLeaguesData);
                localStorage.removeItem("leagues"); 
                didMigrate = true;
                console.log("Migrated old leagues data.");
            }
            const oldFixedData = localStorage.getItem("fixedActivities_v2") || localStorage.getItem("fixedActivities");
            if (oldFixedData) {
                newSettings.fixedActivities = JSON.parse(oldFixedData);
                localStorage.removeItem("fixedActivities_v2"); 
                localStorage.removeItem("fixedActivities");
                didMigrate = true;
                console.log("Migrated old fixed activities data.");
            }
            if (didMigrate) {
                console.log("Migration successful. Saving to new global settings.", newSettings);
                localStorage.setItem(GLOBAL_SETTINGS_KEY, JSON.stringify(newSettings));
                return newSettings;
            }
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
            
            console.log("Loading previous day's data from:", yesterdayString);
            
            const allData = window.loadAllDailyData();
            return allData[yesterdayString] || {};
        } catch (e) {
            console.error("Could not load previous day's data", e);
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

    // Initial load on script start
    window.loadCurrentDailyData();

    // --- 5. NEW: ERASE CURRENT DAY FUNCTION ---
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
    
    // --- 6. NEW: ERASE ALL SCHEDULES FUNCTION ---
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

    // =============================================
    // ===== START OF NEW INIT FUNCTION =====
    // =============================================
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
    // =============================================
    // ===== END OF NEW INIT FUNCTION =====
    // =============================================

})();
