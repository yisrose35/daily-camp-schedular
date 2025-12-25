// =================================================================
// calendar.js (FIXED)
//
// FIXES:
// - Uses unified storage key for export/import
// - Proper backup/restore with all data
// - Division color index persistence
// =================================================================
(function() {
    'use strict';
    console.log("🗓️ calendar.js v2.0 (FIXED) loaded");
    
    // ==========================================================
    // 1. STORAGE KEYS - UNIFIED
    // ==========================================================
    
    // ⭐ Primary unified key (must match cloud_storage_bridge)
    const UNIFIED_CACHE_KEY = "CAMPISTRY_UNIFIED_STATE";
    
    // Daily data (separate - changes frequently)
    const DAILY_DATA_KEY = "campDailyData_v1";
    const ROTATION_HISTORY_KEY = "campRotationHistory_v1";
    const AUTO_SAVE_KEY = "campAutoSave_v2"; // Bumped version
    
    // Smart tile histories
    const SMART_TILE_HISTORY_KEY = "smartTileHistory_v1";
    const SMART_TILE_SPECIAL_HISTORY_KEY = "smartTileSpecialHistory_v1";
    
    // League history keys
    const LEAGUE_HISTORY_KEY = "campLeagueHistory_v2";
    const SPECIALTY_LEAGUE_HISTORY_KEY = "specialtyLeagueHistory_v1";
    
    // Legacy keys (for backward compatibility in export)
    const LEGACY_GLOBAL_SETTINGS_KEY = "campGlobalSettings_v1";
    const LEGACY_GLOBAL_REGISTRY_KEY = "campistry_global_registry";
    
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
    // 3. DAILY DATA API (unchanged - works correctly)
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
        all[date].leagueDayCounters = all[date].leagueDayCounters || {};
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
    // 4. ROTATION HISTORY SYSTEMS (unchanged)
    // ==========================================================
    window.loadRotationHistory = function() {
        try {
            const d = localStorage.getItem(ROTATION_HISTORY_KEY);
            const hist = d ? JSON.parse(d) : {};
            hist.bunks = hist.bunks || {};
            hist.leagues = hist.leagues || {};
            return hist;
        } catch {
            return { bunks: {}, leagues: {} };
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
    // RESET ALL ACTIVITY / SPECIAL ROTATION
    // ==========================================================
    window.eraseRotationHistory = function() {
        try {
            localStorage.removeItem(ROTATION_HISTORY_KEY);
            localStorage.removeItem(SMART_TILE_HISTORY_KEY);
            localStorage.removeItem(SMART_TILE_SPECIAL_HISTORY_KEY);
            
            const settings = window.loadGlobalSettings?.() || {};
            if (settings.manualUsageOffsets) {
                delete settings.manualUsageOffsets;
                window.saveGlobalSettings?.('manualUsageOffsets', undefined);
            }
            
            console.log("All rotation histories cleared.");
            alert("Activity & Smart Tile History reset successfully!");
            window.location.reload();
        } catch (e) {
            console.error("Failed to reset history:", e);
            alert("Error resetting history. Check console.");
        }
    };
    
    // ==========================================================
    // START NEW HALF
    // ==========================================================
    window.startNewHalf = function() {
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
            
            localStorage.removeItem(ROTATION_HISTORY_KEY);
            localStorage.removeItem(SMART_TILE_HISTORY_KEY);
            localStorage.removeItem(SMART_TILE_SPECIAL_HISTORY_KEY);
            localStorage.removeItem(LEAGUE_HISTORY_KEY);
            localStorage.removeItem(SPECIALTY_LEAGUE_HISTORY_KEY);
            localStorage.removeItem(DAILY_DATA_KEY);
            
            // Clear league round state from global settings
            window.saveGlobalSettings?.('leagueRoundState', {});
            
            // Clear manual offsets
            const settings = window.loadGlobalSettings?.() || {};
            if (settings.manualUsageOffsets) {
                window.saveGlobalSettings?.('manualUsageOffsets', undefined);
            }
            
            console.log("⭐ NEW HALF RESET COMPLETE ⭐");
            
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
    // 5. ERASE ALL DATA
    // ==========================================================
    function setupEraseAll() {
        const btn = document.getElementById("eraseAllBtn");
        if (!btn) return;
        btn.onclick = function() {
            if (!confirm("Erase ALL settings, schedules, and rotation histories?\nThis cannot be undone.")) return;
            
            // Clear everything
            const keysToRemove = [
                UNIFIED_CACHE_KEY,
                DAILY_DATA_KEY,
                ROTATION_HISTORY_KEY,
                AUTO_SAVE_KEY,
                SMART_TILE_HISTORY_KEY,
                SMART_TILE_SPECIAL_HISTORY_KEY,
                LEAGUE_HISTORY_KEY,
                SPECIALTY_LEAGUE_HISTORY_KEY,
                LEGACY_GLOBAL_SETTINGS_KEY,
                LEGACY_GLOBAL_REGISTRY_KEY,
                "CAMPISTRY_LOCAL_CACHE",
                "campSchedulerData",
                "fixedActivities_v2",
                "leagues",
                "camp_league_round_state",
                "camp_league_sport_rotation",
                "scheduleAssignments",
                "leagueAssignments"
            ];
            
            keysToRemove.forEach(key => localStorage.removeItem(key));
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
    // 8. BACKUP / RESTORE (FIXED - Uses unified storage)
    // ==========================================================
    function exportAllData() {
        try {
            // ⭐ Read from unified key
            let globalSettings = {};
            try {
                globalSettings = JSON.parse(localStorage.getItem(UNIFIED_CACHE_KEY) || "{}");
            } catch (e) {
                console.warn("Could not load unified settings:", e);
            }
            
            // ⭐ Also include division color index
            const colorIndex = globalSettings.divisionColorIndex || 0;
            
            const backup = {
                // ⭐ Main unified state
                globalSettings: globalSettings,
                
                // Daily/rotation data
                dailyData: JSON.parse(localStorage.getItem(DAILY_DATA_KEY) || "{}"),
                rotationHistory: JSON.parse(localStorage.getItem(ROTATION_HISTORY_KEY) || "{}"),
                
                // Smart tile histories
                smartTileHistory: JSON.parse(localStorage.getItem(SMART_TILE_HISTORY_KEY) || "{}"),
                smartTileSpecialHistory: JSON.parse(localStorage.getItem(SMART_TILE_SPECIAL_HISTORY_KEY) || "{}"),
                
                // League histories
                leagueHistory: JSON.parse(localStorage.getItem(LEAGUE_HISTORY_KEY) || "{}"),
                specialtyLeagueHistory: JSON.parse(localStorage.getItem(SPECIALTY_LEAGUE_HISTORY_KEY) || "{}"),
                
                // ⭐ Explicit divisions/bunks extraction (for clarity)
                divisions: globalSettings.divisions || {},
                bunks: globalSettings.bunks || [],
                divisionColorIndex: colorIndex,
                
                // Metadata
                exportVersion: 3,
                exportDate: new Date().toISOString()
            };
            
            const json = JSON.stringify(backup, null, 2);
            const blob = new Blob([json], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `campistry_backup_${getTodayString()}.json`;
            a.click();
            URL.revokeObjectURL(url);
            
            console.log("✅ Export complete:", {
                divisions: Object.keys(backup.divisions).length,
                bunks: backup.bunks.length,
                colorIndex: colorIndex
            });
            
        } catch (e) {
            console.error("Export error:", e);
            alert("Export failed: " + e.message);
        }
    }
    window.__campistry_exportAllData = exportAllData;
    
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
                
                console.log("📥 Importing backup version:", backup.exportVersion || 1);
                
                // ⭐ Build unified state from backup
                let unifiedState = {};
                
                if (backup.globalSettings) {
                    unifiedState = { ...backup.globalSettings };
                }
                
                // Merge explicit divisions/bunks if present (v3 backups)
                if (backup.divisions && Object.keys(backup.divisions).length > 0) {
                    unifiedState.divisions = backup.divisions;
                }
                if (backup.bunks && backup.bunks.length > 0) {
                    unifiedState.bunks = backup.bunks;
                }
                
                // ⭐ Restore color index
                if (backup.divisionColorIndex !== undefined) {
                    unifiedState.divisionColorIndex = backup.divisionColorIndex;
                }
                
                // Handle v1/v2 backups with globalRegistry
                if (backup.globalRegistry) {
                    if (backup.globalRegistry.divisions) {
                        unifiedState.divisions = backup.globalRegistry.divisions;
                    }
                    if (backup.globalRegistry.bunks) {
                        unifiedState.bunks = backup.globalRegistry.bunks;
                    }
                }
                
                // Legacy app1 data extraction
                if (unifiedState.app1) {
                    if (unifiedState.app1.divisions && !unifiedState.divisions) {
                        unifiedState.divisions = unifiedState.app1.divisions;
                    }
                    if (unifiedState.app1.bunks && (!unifiedState.bunks || unifiedState.bunks.length === 0)) {
                        unifiedState.bunks = unifiedState.app1.bunks;
                    }
                }
                
                // ⭐ Save to all storage keys for maximum compatibility
                localStorage.setItem(UNIFIED_CACHE_KEY, JSON.stringify(unifiedState));
                localStorage.setItem(LEGACY_GLOBAL_SETTINGS_KEY, JSON.stringify(unifiedState));
                localStorage.setItem(LEGACY_GLOBAL_REGISTRY_KEY, JSON.stringify({
                    divisions: unifiedState.divisions || {},
                    bunks: unifiedState.bunks || []
                }));
                localStorage.setItem("CAMPISTRY_LOCAL_CACHE", JSON.stringify(unifiedState));
                
                // Restore other data
                if (backup.dailyData) {
                    localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(backup.dailyData));
                }
                if (backup.rotationHistory) {
                    localStorage.setItem(ROTATION_HISTORY_KEY, JSON.stringify(backup.rotationHistory));
                }
                if (backup.smartTileHistory) {
                    localStorage.setItem(SMART_TILE_HISTORY_KEY, JSON.stringify(backup.smartTileHistory));
                }
                if (backup.smartTileSpecialHistory) {
                    localStorage.setItem(SMART_TILE_SPECIAL_HISTORY_KEY, JSON.stringify(backup.smartTileSpecialHistory));
                }
                if (backup.leagueHistory) {
                    localStorage.setItem(LEAGUE_HISTORY_KEY, JSON.stringify(backup.leagueHistory));
                }
                if (backup.specialtyLeagueHistory) {
                    localStorage.setItem(SPECIALTY_LEAGUE_HISTORY_KEY, JSON.stringify(backup.specialtyLeagueHistory));
                }
                
                console.log("✅ Import complete:", {
                    divisions: Object.keys(unifiedState.divisions || {}).length,
                    bunks: (unifiedState.bunks || []).length,
                    colorIndex: unifiedState.divisionColorIndex
                });
                
                // Live apply if possible
                try {
                    window.setGlobalDivisions?.(unifiedState.divisions || {});
                    window.setGlobalBunks?.(unifiedState.bunks || []);
                    window.divisions = unifiedState.divisions || {};
                    window.globalBunks = unifiedState.bunks || [];
                    
                    window.loadCurrentDailyData?.();
                    window.initApp1?.();
                    window.initLeagues?.();
                    window.initScheduleSystem?.();
                    window.updateTable?.();
                    
                    alert("Import successful! Data loaded.");
                } catch (liveErr) {
                    console.warn("Live apply failed, reload required:", liveErr);
                    alert("Import successful! Reloading page...");
                    window.location.reload();
                }
                
            } catch (err) {
                console.error("Import failed:", err);
                alert("Invalid backup file. Error: " + err.message);
            }
        };
        reader.readAsText(file);
        e.target.value = "";
    }
    window.__campistry_handleFileSelect = handleFileSelect;
    
    // ==========================================================
    // 9. AUTO-SAVE SYSTEM
    // ==========================================================
    function performAutoSave(silent = true) {
        try {
            const snapshot = {
                timestamp: Date.now(),
                [UNIFIED_CACHE_KEY]: localStorage.getItem(UNIFIED_CACHE_KEY),
                [DAILY_DATA_KEY]: localStorage.getItem(DAILY_DATA_KEY),
                [ROTATION_HISTORY_KEY]: localStorage.getItem(ROTATION_HISTORY_KEY),
                [LEAGUE_HISTORY_KEY]: localStorage.getItem(LEAGUE_HISTORY_KEY),
                [SPECIALTY_LEAGUE_HISTORY_KEY]: localStorage.getItem(SPECIALTY_LEAGUE_HISTORY_KEY),
                [SMART_TILE_HISTORY_KEY]: localStorage.getItem(SMART_TILE_HISTORY_KEY),
                [SMART_TILE_SPECIAL_HISTORY_KEY]: localStorage.getItem(SMART_TILE_SPECIAL_HISTORY_KEY)
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
            
            // Restore all keys from snapshot
            Object.keys(snap).forEach(key => {
                if (key === 'timestamp') return;
                if (snap[key]) {
                    localStorage.setItem(key, snap[key]);
                }
            });
            
            // Also sync to legacy keys
            if (snap[UNIFIED_CACHE_KEY]) {
                localStorage.setItem(LEGACY_GLOBAL_SETTINGS_KEY, snap[UNIFIED_CACHE_KEY]);
                localStorage.setItem("CAMPISTRY_LOCAL_CACHE", snap[UNIFIED_CACHE_KEY]);
            }
            
            alert("Auto-save restored. Reloading...");
            window.location.reload();
        } catch (e) {
            console.error("Restore error:", e);
            alert("Failed to restore backup.");
        }
    };
    
    function startAutoSaveTimer() {
        setInterval(() => performAutoSave(true), 300000); // 5 minutes
        setTimeout(() => performAutoSave(true), 5000); // Initial save after 5s
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
        }
        
        if (importBtn && importInput) {
            importBtn.addEventListener("click", () => importInput.click());
            importInput.addEventListener("change", handleFileSelect);
        }
        
        startAutoSaveTimer();
        
        console.log("🗓️ Calendar initialized (FIXED v2.0)");
    }
    
    window.initCalendar = initCalendar;
    
    // Load day immediately
    window.loadCurrentDailyData();
    
    // Auto-init
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initCalendar);
    } else {
        initCalendar();
    }
})();

// ==========================================================
// LATE-BIND BACKUP / IMPORT WIRING
// ==========================================================
(function bindBackupWhenReady(){
    function wire() {
        const exp = document.getElementById("exportBackupBtn");
        const imp = document.getElementById("importBackupBtn");
        const inp = document.getElementById("importFileInput");
        if (!exp || !imp || !inp) return;

        exp.onclick = window.__campistry_exportAllData;
        imp.onclick = () => inp.click();
        inp.onchange = window.__campistry_handleFileSelect;

        console.log("🧬 Backup / Import wired (late bind)");
    }

    setTimeout(wire, 200);
    setTimeout(wire, 600);
    setTimeout(wire, 1200);
})();
