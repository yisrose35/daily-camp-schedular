// =================================================================
// calendar.js
//
// --- UPDATED (Save Now) ---
// - Added 'window.forceAutoSave' for manual saving.
// - Updated 'performAutoSave' to show an alert when triggered manually.
// =================================================================

(function() {
    'use strict';

    // --- 1. DEFINE STORAGE KEYS ---
    const GLOBAL_SETTINGS_KEY = "campGlobalSettings_v1";
    const DAILY_DATA_KEY = "campDailyData_v1";
    const ROTATION_HISTORY_KEY = "campRotationHistory_v1";
    const AUTO_SAVE_KEY = "campAutoSave_v1"; 

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
    
    function onDateChanged() {
        const newDate = datePicker.value;
        if (!newDate) return;
        
        console.log(`Date changed to: ${newDate}`);
        window.currentScheduleDate = newDate;
        
        window.loadCurrentDailyData();
        window.initScheduleSystem?.(); // Reloads schedule
        window.initDailyAdjustments?.();
        
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
                leagueDayCounters: {},
                overrides: { fields: [], bunks: [], leagues: [] } 
            };
        }
        
        allData[date].leagueDayCounters = allData[date].leagueDayCounters || {};
        
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
            return allData[yesterdayString] || { 
                leagueDayCounters: {}, 
                leagueRoundState: {} 
            };
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

    // --- 4. ROTATION HISTORY API ---

    window.loadRotationHistory = function() {
        try {
            const data = localStorage.getItem(ROTATION_HISTORY_KEY);
            const history = data ? JSON.parse(data) : {};
            
            history.bunks = history.bunks || {};
            history.leagues = history.leagues || {};
            
            return history;
        } catch (e) {
            console.error("Failed to load rotation history:", e);
            return { bunks: {}, leagues: {} };
        }
    }

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
    
    window.eraseRotationHistory = function() {
        try {
            localStorage.removeItem(ROTATION_HISTORY_KEY);
            console.log("Erased all activity rotation history.");
            alert("Activity rotation history has been reset.");
        } catch (e) {
            console.error("Failed to erase rotation history:", e);
        }
    }

    // --- 5. ERASE ALL DATA ---
    function setupEraseAll() {
        const eraseBtn = document.getElementById("eraseAllBtn");
        if (eraseBtn) {
            eraseBtn.onclick = () => {
                if (confirm("Erase ALL camp data?\nThis includes ALL settings, ALL saved daily schedules, and ALL activity rotation history.")) {
                    localStorage.removeItem(GLOBAL_SETTINGS_KEY);
                    localStorage.removeItem(DAILY_DATA_KEY);
                    localStorage.removeItem(ROTATION_HISTORY_KEY);
                    localStorage.removeItem(AUTO_SAVE_KEY);
                    
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
            console.log("Erased ALL daily schedules.");
            window.location.reload();
        } catch (e) {
            console.error("Failed to erase all daily data:", e);
        }
    }

    // --- 8. BACKUP & RESTORE FUNCTIONS ---

    function exportAllData() {
        console.log("Exporting all data...");
        const backupData = {};

        try {
            const globalData = localStorage.getItem(GLOBAL_SETTINGS_KEY);
            const dailyData = localStorage.getItem(DAILY_DATA_KEY);
            const rotationData = localStorage.getItem(ROTATION_HISTORY_KEY);

            backupData.globalSettings = JSON.parse(globalData) || {};
            backupData.dailyData = JSON.parse(dailyData) || {};
            backupData.rotationHistory = JSON.parse(rotationData) || {};
            
            const jsonString = JSON.stringify(backupData, null, 2);
            const blob = new Blob([jsonString], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            
            const a = document.createElement('a');
            a.href = url;
            a.download = `camp_scheduler_backup_${getTodayString()}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            console.log("Export successful.");

        } catch (e) {
            console.error("Failed to export data:", e);
            alert("Error exporting data. Check the console for details.");
        }
    }

    function handleFileSelect(event) {
        const file = event.target.files[0];
        if (!file) return;

        if (!confirm("Are you sure you want to import this file?\nThis will OVERWRITE all existing data (setup, schedules, etc.) with the contents of the backup file.\nThis action cannot be undone.")) {
            event.target.value = null;
            return;
        }

        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const text = e.target.result;
                const backupData = JSON.parse(text);

                if (!backupData || !backupData.globalSettings) {
                    throw new Error("Invalid backup file. Missing 'globalSettings'.");
                }

                localStorage.setItem(GLOBAL_SETTINGS_KEY, JSON.stringify(backupData.globalSettings || {}));
                localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(backupData.dailyData || {}));
                localStorage.setItem(ROTATION_HISTORY_KEY, JSON.stringify(backupData.rotationHistory || {}));

                alert("Import successful! The application will now reload.");
                window.location.reload();

            } catch (err) {
                console.error("Failed to import file:", err);
                alert(`Error importing file: ${err.message}`);
            } finally {
                event.target.value = null;
            }
        };
        reader.readAsText(file);
    }

    // --- 9. NEW: AUTO-SAVE LOGIC ---

    // Added 'silent' param. Defaults to true for timer, false for manual button.
    function performAutoSave(silent = true) {
        try {
            const snapshot = {
                timestamp: Date.now(),
                [GLOBAL_SETTINGS_KEY]: localStorage.getItem(GLOBAL_SETTINGS_KEY),
                [DAILY_DATA_KEY]: localStorage.getItem(DAILY_DATA_KEY),
                [ROTATION_HISTORY_KEY]: localStorage.getItem(ROTATION_HISTORY_KEY)
            };
            localStorage.setItem(AUTO_SAVE_KEY, JSON.stringify(snapshot));
            console.log("Auto-save completed at " + new Date().toLocaleTimeString());
            
            if (!silent) {
                alert("Work saved successfully!");
            }
        } catch (e) {
            console.error("Auto-save failed:", e);
            if (!silent) {
                alert("Save failed. Check console.");
            }
        }
    }
    
    // New global function for manual save
    window.forceAutoSave = function() {
        performAutoSave(false);
    };

    window.restoreAutoSave = function() {
        try {
            const raw = localStorage.getItem(AUTO_SAVE_KEY);
            if (!raw) {
                alert("No auto-saved data found.");
                return;
            }
            
            const snapshot = JSON.parse(raw);
            const dateStr = new Date(snapshot.timestamp).toLocaleString();
            
            if (confirm(`Restore auto-save from: ${dateStr}?\n\nThis will overwrite all current data with the state from that time. Continue?`)) {
                if (snapshot[GLOBAL_SETTINGS_KEY]) localStorage.setItem(GLOBAL_SETTINGS_KEY, snapshot[GLOBAL_SETTINGS_KEY]);
                if (snapshot[DAILY_DATA_KEY]) localStorage.setItem(DAILY_DATA_KEY, snapshot[DAILY_DATA_KEY]);
                if (snapshot[ROTATION_HISTORY_KEY]) localStorage.setItem(ROTATION_HISTORY_KEY, snapshot[ROTATION_HISTORY_KEY]);
                
                alert("Auto-save restored. Reloading...");
                window.location.reload();
            }
        } catch(e) {
            console.error("Error restoring auto-save", e);
            alert("Error restoring auto-save.");
        }
    }

    function startAutoSaveTimer() {
        // Trigger every 10 minutes (600,000 ms), silent mode
        setInterval(() => performAutoSave(true), 600000); 
        console.log("Auto-save timer started (10 min interval).");
        // Perform initial save 5s after load
        setTimeout(() => performAutoSave(true), 5000); 
    }
    
    // ----------------------------------

    function initCalendar() {
      datePicker = document.getElementById("calendar-date-picker");
      if (datePicker) {
        datePicker.value = window.currentScheduleDate;
        datePicker.addEventListener("change", onDateChanged);
      }
    
      setupEraseAll();

      const exportBtn = document.getElementById('exportBackupBtn');
      const importBtn = document.getElementById('importBackupBtn');
      const importInput = document.getElementById('importFileInput');

      if (exportBtn) {
          exportBtn.addEventListener('click', exportAllData);
      }
      if (importBtn && importInput) {
          importBtn.addEventListener('click', () => importInput.click());
          importInput.addEventListener('change', handleFileSelect);
      }

      startAutoSaveTimer();
    }
    
    window.initCalendar = initCalendar;

})();
