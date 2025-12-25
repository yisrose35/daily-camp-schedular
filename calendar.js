// =================================================================
// calendar.js
//
// MERGED: Beta startNewHalf + Published global_authority.js sync
// - startNewHalf() resets counters for second half of season
// - Backup/Restore syncs with global_authority.js registry
// - League history persistence
// =================================================================
(function() {
    'use strict';
    console.log("🗓️ calendar.js loaded");
    
    // ==========================================================
    // 1. STORAGE KEYS
    // ==========================================================
    const GLOBAL_SETTINGS_KEY = "campGlobalSettings_v1";
    const DAILY_DATA_KEY = "campDailyData_v1";
    const ROTATION_HISTORY_KEY = "campRotationHistory_v1";
    const AUTO_SAVE_KEY = "campAutoSave_v1";
    
    // ⭐ Global Authority key (divisions/bunks spine)
    const GLOBAL_REGISTRY_KEY = "campistry_global_registry";
    
    // Legacy smart tile history (old versions)
    const SMART_TILE_HISTORY_KEY = "smartTileHistory_v1";
    // NEW Smart Tile rotation (SmartLogicAdapter V31)
    const SMART_TILE_SPECIAL_HISTORY_KEY = "smartTileSpecialHistory_v1";
    
    // League history keys
    const LEAGUE_HISTORY_KEY = "campLeagueHistory_v2";
    const SPECIALTY_LEAGUE_HISTORY_KEY = "specialtyLeagueHistory_v1";
    
    // ==========================================================
    // Helper — formatted date YYYY-MM-DD
    // ==========================================================
    function getTodayString(date = new Date()) {
        date.setHours(12, 0, 0, 0);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
    
    // ==========================================================
    // 2. INITIALIZE CALENDAR
    // ==========================================================
    window.currentScheduleDate = getTodayString();
    let datePicker = null;
    
    function onDateChanged() {
        const newDate = datePicker.value;
        if (!newDate) return;
        window.currentScheduleDate = newDate;
        window.loadCurrentDailyData();
        window.initScheduleSystem?.();
        window.initDailyAdjustments?.();
        if (document.getElementById('master-scheduler')?.classList.contains('active')) {
            window.initMasterScheduler?.();
        }
    }
    
    // ==========================================================
    // 3. GLOBAL DATA API
    // ==========================================================
    
    window.loadAllDailyData = function() {
        try {
            const raw = localStorage.getItem(DAILY_DATA_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch {
            return {};
        }
    };
    
    window.loadCurrentDailyData = function() {
        const all = window.loadAllDailyData();
        const date = window.currentScheduleDate;
        if (!all[date]) {
            all[date] = {
                scheduleAssignments: {},
                leagueAssignments: {},
                leagueRoundState: {},
                leagueDayCounters: {},
                overrides: {
                    fields: [],
                    bunks: [],
                    leagues: []
                }
            };
        }
        all[date].leagueDayCounters =
            all[date].leagueDayCounters || {};
        window.currentDailyData = all[date];
        return window.currentDailyData;
    };
    
    window.loadPreviousDailyData = function() {
        try {
            const [Y, M, D] = window.currentScheduleDate.split('-').map(Number);
            const dt = new Date(Y, M - 1, D, 12, 0, 0);
            dt.setDate(dt.getDate() - 1);
            const yesterday = getTodayString(dt);
            const all = window.loadAllDailyData();
            return all[yesterday] || {
                leagueDayCounters: {},
                leagueRoundState: {}
            };
        } catch {
            return {};
        }
    };
    
    window.saveCurrentDailyData = function(key, value) {
        try {
            const all = window.loadAllDailyData();
            const date = window.currentScheduleDate;
            if (!all[date]) all[date] = {};
            all[date][key] = value;
            localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(all));
            window.currentDailyData = all[date];
        } catch (e) {
            console.error("Failed to save daily data:", e);
        }
    };
    
    // ==========================================================
    // 4. ROTATION HISTORY SYSTEMS
    // ==========================================================
    window.loadRotationHistory = function() {
        try {
            const d = localStorage.getItem(ROTATION_HISTORY_KEY);
            const hist = d ? JSON.parse(d) : {};
            hist.bunks = hist.bunks || {};
            hist.leagues = hist.leagues || {};
            return hist;
        } catch {
            return {
                bunks: {},
                leagues: {}
            };
        }
    };
    
    window.saveRotationHistory = function(hist) {
        try {
            if (!hist || !hist.bunks || !hist.leagues) return;
            localStorage.setItem(ROTATION_HISTORY_KEY, JSON.stringify(hist));
        } catch (e) {
            console.error("Failed to save rotation history:", e);
        }
    };
    
    // ==========================================================
    // ⭐ RESET ALL ACTIVITY / SPECIAL ROTATION (Full Reset)
    // ==========================================================
    window.eraseRotationHistory = function() {
        try {
            // 1. Regular rotation history
            localStorage.removeItem(ROTATION_HISTORY_KEY);
            // 2. Legacy Smart Tile history
            localStorage.removeItem(SMART_TILE_HISTORY_KEY);
            // ⭐ 3. NEW Smart Tile Special Rotation history (V31)
            localStorage.removeItem(SMART_TILE_SPECIAL_HISTORY_KEY);
            // 4. Manual offsets from analytics UI
            const settings = window.loadGlobalSettings();
            if (settings.manualUsageOffsets) {
                delete settings.manualUsageOffsets;
                localStorage.setItem(GLOBAL_SETTINGS_KEY, JSON.stringify(settings));
            }
            console.log("All rotation histories cleared (regular + smart tile + special tile).");
            alert("Activity & Smart Tile History reset successfully!");
            window.location.reload();
        } catch (e) {
            console.error("Failed to reset history:", e);
            alert("Error resetting history. Check console.");
        }
    };
    
    // ==========================================================
    // ⭐⭐⭐ NEW HALF - Reset for Second Half of Season ⭐⭐⭐
    // ==========================================================
    // Resets:
    // - Bunk activity usage counters (rotation history)
    // - Smart tile histories
    // - Regular league game counters (back to Game 1)
    // - Specialty league game counters (back to Game 1)
    // - All daily schedules
    //
    // Does NOT touch:
    // - Fields configuration
    // - Special activities configuration
    // - Master schedule templates
    // - Divisions and bunks setup
    // ==========================================================
    window.startNewHalf = function() {
        // Confirmation dialog
        const confirmed = confirm(
            "🏕️ START NEW HALF\n\n" +
            "This will reset:\n" +
            "  ✓ Bunk activity usage counters\n" +
            "  ✓ Smart Tile rotation history\n" +
            "  ✓ Regular League game counters (back to Game 1)\n" +
            "  ✓ Specialty League game counters (back to Game 1)\n" +
            "  ✓ All generated daily schedules\n\n" +
            "This will NOT change:\n" +
            "  • Fields configuration\n" +
            "  • Special Activities setup\n" +
            "  • Master Schedule templates\n" +
            "  • Divisions and Bunks\n\n" +
            "Are you sure you want to start a new half?"
        );
        if (!confirmed) return;
        
        try {
            console.log("=".repeat(50));
            console.log("⭐ STARTING NEW HALF - Resetting Counters ⭐");
            console.log("=".repeat(50));
            
            // 1. Clear bunk rotation history (activity usage per bunk)
            localStorage.removeItem(ROTATION_HISTORY_KEY);
            console.log("✓ Cleared bunk rotation history");
            
            // 2. Clear Smart Tile histories
            localStorage.removeItem(SMART_TILE_HISTORY_KEY);
            localStorage.removeItem(SMART_TILE_SPECIAL_HISTORY_KEY);
            console.log("✓ Cleared Smart Tile histories");
            
            // 3. Reset Regular League counters to 0
            localStorage.removeItem(LEAGUE_HISTORY_KEY);
            console.log("✓ Reset regular league history (Game counters back to 1)");
            
            // 4. Reset Specialty League counters
            localStorage.removeItem(SPECIALTY_LEAGUE_HISTORY_KEY);
            // Also check for any other specialty league keys
            const keysToCheck = [
                'specialtyLeagueHistory',
                'specialty_league_history',
                'campSpecialtyLeagueHistory_v1',
                'specialtyLeagueRoundState'
            ];
            keysToCheck.forEach(key => {
                if (localStorage.getItem(key)) {
                    localStorage.removeItem(key);
                    console.log("✓ Removed " + key);
                }
            });
            console.log("✓ Reset specialty league history (Game counters back to 1)");
            
            // 5. Clear in-memory league state
            if (window.leagueRoundState) {
                window.leagueRoundState = {};
            }
            window.saveGlobalSettings?.('leagueRoundState', {});
            console.log("✓ Cleared in-memory league round state");
            
            // 6. Clear all daily schedules
            localStorage.removeItem(DAILY_DATA_KEY);
            console.log("✓ Cleared all daily schedules");
            
            // 7. Clear manual usage offsets from analytics
            const settings = window.loadGlobalSettings();
            if (settings.manualUsageOffsets) {
                delete settings.manualUsageOffsets;
                localStorage.setItem(GLOBAL_SETTINGS_KEY, JSON.stringify(settings));
                console.log("✓ Cleared manual usage offsets");
            }
            
            // 8. Clear any cached league assignments in daily data
            // (Already handled by removing DAILY_DATA_KEY)
            
            console.log("=".repeat(50));
            console.log("⭐ NEW HALF RESET COMPLETE ⭐");
            console.log("=".repeat(50));
            
            alert(
                "✅ New Half Started!\n\n" +
                "All activity and league counters have been reset.\n" +
                "The first game generated will now be Game 1.\n\n" +
                "Reloading page..."
            );
            window.location.reload();
        } catch (e) {
            console.error("Failed to start new half:", e);
            alert("Error starting new half. Check console for details.");
        }
    };
    
    // ==========================================================
    // 5. ERASE ALL DATA BUTTON
    // ==========================================================
    function setupEraseAll() {
        const btn = document.getElementById("eraseAllBtn");
        if (!btn) return;
        btn.onclick = function() {
            if (!confirm("Erase ALL settings, schedules, and rotation histories?\nThis cannot be undone.")) return;
            localStorage.removeItem(GLOBAL_SETTINGS_KEY);
            localStorage.removeItem(DAILY_DATA_KEY);
            localStorage.removeItem(ROTATION_HISTORY_KEY);
            localStorage.removeItem(AUTO_SAVE_KEY);
            localStorage.removeItem(SMART_TILE_HISTORY_KEY);
            localStorage.removeItem(SMART_TILE_SPECIAL_HISTORY_KEY);
            localStorage.removeItem(LEAGUE_HISTORY_KEY);
            localStorage.removeItem(SPECIALTY_LEAGUE_HISTORY_KEY);
            // ⭐ Also clear global authority registry
            localStorage.removeItem(GLOBAL_REGISTRY_KEY);
            localStorage.removeItem("campSchedulerData");
            localStorage.removeItem("fixedActivities_v2");
            localStorage.removeItem("leagues");
            localStorage.removeItem("camp_league_round_state");
            localStorage.removeItem("camp_league_sport_rotation");
            localStorage.removeItem("scheduleAssignments");
            localStorage.removeItem("leagueAssignments");
            window.location.reload();
        };
    }
    
    // ==========================================================
    // 6. ERASE CURRENT DAY
    // ==========================================================
    window.eraseCurrentDailyData = function() {
        const all = window.loadAllDailyData();
        const date = window.currentScheduleDate;
        if (all[date]) {
            delete all[date];
            localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(all));
        }
        window.loadCurrentDailyData();
        window.initScheduleSystem?.();
    };
    
    // ==========================================================
    // 7. ERASE ALL SCHEDULE DAYS
    // ==========================================================
    window.eraseAllDailyData = function() {
        localStorage.removeItem(DAILY_DATA_KEY);
        window.location.reload();
    };
    
    // ==========================================================
    // 8. BACKUP / RESTORE (⭐ FIXED for global_authority.js + league histories)
    // ==========================================================
    function exportAllData() {
        try {
            // ⭐ Include the global registry (divisions/bunks spine)
            let globalRegistry = {};
            try {
                const regRaw = localStorage.getItem(GLOBAL_REGISTRY_KEY);
                globalRegistry = regRaw ? JSON.parse(regRaw) : {};
            } catch (e) {
                console.warn("Could not load global registry:", e);
            }
            
            const backup = {
                // Standard keys
                globalSettings: JSON.parse(localStorage.getItem(GLOBAL_SETTINGS_KEY) || "{}"),
                dailyData: JSON.parse(localStorage.getItem(DAILY_DATA_KEY) || "{}"),
                rotationHistory: JSON.parse(localStorage.getItem(ROTATION_HISTORY_KEY) || "{}"),
                
                // ⭐ Global Authority registry (divisions/bunks)
                globalRegistry: globalRegistry,
                
                // ⭐ League histories
                leagueHistory: JSON.parse(localStorage.getItem(LEAGUE_HISTORY_KEY) || "{}"),
                specialtyLeagueHistory: JSON.parse(localStorage.getItem(SPECIALTY_LEAGUE_HISTORY_KEY) || "{}"),
                
                // Metadata
                exportVersion: 2,
                exportDate: new Date().toISOString()
            };
            
            const json = JSON.stringify(backup, null, 2);
            const blob = new Blob([json], {
                type: "application/json"
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `camp_scheduler_backup_${getTodayString()}.json`;
            a.click();
            URL.revokeObjectURL(url);
            console.log("✓ Export complete. Includes global registry:", Object.keys(globalRegistry));
        } catch (e) {
            console.error("Export error:", e);
            alert("Export failed.");
        }
    }
    
    function handleFileSelect(e) {
        const file = e.target.files[0];
        if (!file) return;
        if (!confirm("Importing will overwrite ALL current data.\nProceed?")) {
            e.target.value = "";
            return;
        }
        const reader = new FileReader();
        reader.onload = function(evt) {
            try {
                const backup = JSON.parse(evt.target.result);
                
                // Restore standard keys
                localStorage.setItem(GLOBAL_SETTINGS_KEY, JSON.stringify(backup.globalSettings || {}));
                localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(backup.dailyData || {}));
                localStorage.setItem(ROTATION_HISTORY_KEY, JSON.stringify(backup.rotationHistory || {}));
                
                // ⭐ Restore global registry if present (v2 exports)
                if (backup.globalRegistry) {
                    localStorage.setItem(GLOBAL_REGISTRY_KEY, JSON.stringify(backup.globalRegistry));
                    console.log("✓ Restored global registry (divisions/bunks)");
                } else {
                    // ⭐ FALLBACK: For old backups, extract divisions/bunks from globalSettings.app1
                    const app1 = backup.globalSettings?.app1;
                    if (app1 && (app1.divisions || app1.bunks)) {
                        const registry = {
                            divisions: app1.divisions || {},
                            bunks: app1.bunks || []
                        };
                        localStorage.setItem(GLOBAL_REGISTRY_KEY, JSON.stringify(registry));
                        console.log("✓ Migrated divisions/bunks from old backup format");
                    }
                }
                
                // ⭐ Restore league histories if present
                if (backup.leagueHistory) {
                    localStorage.setItem(LEAGUE_HISTORY_KEY, JSON.stringify(backup.leagueHistory));
                    console.log("✓ Restored league history");
                }
                if (backup.specialtyLeagueHistory) {
                    localStorage.setItem(SPECIALTY_LEAGUE_HISTORY_KEY, JSON.stringify(backup.specialtyLeagueHistory));
                    console.log("✓ Restored specialty league history");
                }
                
                alert("Import successful. Reloading...");
                window.location.reload();
            } catch (err) {
                console.error("Import failed:", err);
                alert("Invalid backup file. Error: " + err.message);
            }
        };
        reader.readAsText(file);
        // Reset file input so same file can be selected again
        e.target.value = "";
    }
    
    // ==========================================================
    // 9. AUTO-SAVE SYSTEM
    // ==========================================================
    function performAutoSave(silent = true) {
        try {
            const snapshot = {
                timestamp: Date.now(),
                [GLOBAL_SETTINGS_KEY]: localStorage.getItem(GLOBAL_SETTINGS_KEY),
                [DAILY_DATA_KEY]: localStorage.getItem(DAILY_DATA_KEY),
                [ROTATION_HISTORY_KEY]: localStorage.getItem(ROTATION_HISTORY_KEY),
                // ⭐ Also save global registry
                [GLOBAL_REGISTRY_KEY]: localStorage.getItem(GLOBAL_REGISTRY_KEY),
                // ⭐ Also save league histories
                [LEAGUE_HISTORY_KEY]: localStorage.getItem(LEAGUE_HISTORY_KEY),
                [SPECIALTY_LEAGUE_HISTORY_KEY]: localStorage.getItem(SPECIALTY_LEAGUE_HISTORY_KEY)
            };
            localStorage.setItem(AUTO_SAVE_KEY, JSON.stringify(snapshot));
            if (!silent) alert("Work saved!");
        } catch (e) {
            console.error("Auto-save failed:", e);
            if (!silent) alert("Save failed.");
        }
    }
    
    window.forceAutoSave = function() {
        performAutoSave(false);
    };
    
    window.restoreAutoSave = function() {
        try {
            const raw = localStorage.getItem(AUTO_SAVE_KEY);
            if (!raw) return alert("No auto-save available.");
            const snap = JSON.parse(raw);
            const date = new Date(snap.timestamp).toLocaleString();
            if (!confirm("Restore auto-save from " + date + "?\nThis will overwrite current data.")) return;
            
            localStorage.setItem(GLOBAL_SETTINGS_KEY, snap[GLOBAL_SETTINGS_KEY]);
            localStorage.setItem(DAILY_DATA_KEY, snap[DAILY_DATA_KEY]);
            localStorage.setItem(ROTATION_HISTORY_KEY, snap[ROTATION_HISTORY_KEY]);
            
            // ⭐ Also restore global registry if present
            if (snap[GLOBAL_REGISTRY_KEY]) {
                localStorage.setItem(GLOBAL_REGISTRY_KEY, snap[GLOBAL_REGISTRY_KEY]);
            }
            
            // ⭐ Also restore league histories if present
            if (snap[LEAGUE_HISTORY_KEY]) {
                localStorage.setItem(LEAGUE_HISTORY_KEY, snap[LEAGUE_HISTORY_KEY]);
            }
            if (snap[SPECIALTY_LEAGUE_HISTORY_KEY]) {
                localStorage.setItem(SPECIALTY_LEAGUE_HISTORY_KEY, snap[SPECIALTY_LEAGUE_HISTORY_KEY]);
            }
            
            alert("Auto-save restored. Reloading...");
            window.location.reload();
        } catch (e) {
            console.error("Restore error:", e);
            alert("Failed to restore backup.");
        }
    };
    
    function startAutoSaveTimer() {
        setInterval(() => performAutoSave(true), 300000);
        setTimeout(() => performAutoSave(true), 5000);
    }
    
    // ==========================================================
    // 10. INIT CALENDAR
    // ==========================================================
    function initCalendar() {
        datePicker = document.getElementById("calendar-date-picker");
        if (datePicker) {
            datePicker.value = window.currentScheduleDate;
            datePicker.addEventListener("change", onDateChanged);
        }
        setupEraseAll();
        
        const exportBtn = document.getElementById("exportBackupBtn");
        const importBtn = document.getElementById("importBackupBtn");
        const importInput = document.getElementById("importFileInput");
        
        if (exportBtn) {
            exportBtn.addEventListener("click", exportAllData);
            console.log("✓ Export button wired up");
        }
        
        if (importBtn && importInput) {
            importBtn.addEventListener("click", () => {
                console.log("Import button clicked, opening file dialog...");
                importInput.click();
            });
            importInput.addEventListener("change", handleFileSelect);
            console.log("✓ Import button wired up");
        } else {
            console.warn("Import button or input not found:", { importBtn, importInput });
        }
        
        startAutoSaveTimer();
        
        console.log("🗓️ Calendar initialized");
    }
    
    window.initCalendar = initCalendar;
    
    // Load day immediately
    window.loadCurrentDailyData();
    
    // ⭐ Auto-init on DOMContentLoaded if not already initialized
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initCalendar);
    } else {
        // DOM already ready, init now
        initCalendar();
    }
})();
// ==========================================================
// LATE-BIND BACKUP / IMPORT WIRING (SaaS Safe)
// ==========================================================
(function bindBackupWhenReady(){
    function wire() {
        const exp = document.getElementById("exportBackupBtn");
        const imp = document.getElementById("importBackupBtn");
        const inp = document.getElementById("importFileInput");
        if (!exp || !imp || !inp) return;

        exp.onclick = exportAllData;
        imp.onclick = () => inp.click();
        inp.onchange = handleFileSelect;

        console.log("🧬 Backup / Import wired (late bind)");
    }

    setTimeout(wire, 200);
    setTimeout(wire, 600);
    setTimeout(wire, 1200);
})();
