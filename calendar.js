// =================================================================
// calendar.js (FIXED v2.2)
//
// FIXES:
// - Uses setCloudState() for imports (updates memory cache + cloud)
// - Re-initializes UI after import WITHOUT page reload
// - Uses resetCloudState() for full erase
// - Uses clearCloudKeys() for partial resets
// =================================================================
(function() {
    'use strict';
    console.log("🗓️ calendar.js v2.2 (FIXED) loaded");
    
    // ==========================================================
    // 1. STORAGE KEYS - UNIFIED
    // ==========================================================
    
    const UNIFIED_CACHE_KEY = "CAMPISTRY_UNIFIED_STATE";
    const DAILY_DATA_KEY = "campDailyData_v1";
    const ROTATION_HISTORY_KEY = "campRotationHistory_v1";
    const AUTO_SAVE_KEY = "campAutoSave_v2";
    const SMART_TILE_HISTORY_KEY = "smartTileHistory_v1";
    const SMART_TILE_SPECIAL_HISTORY_KEY = "smartTileSpecialHistory_v1";
    const LEAGUE_HISTORY_KEY = "campLeagueHistory_v2";
    const SPECIALTY_LEAGUE_HISTORY_KEY = "specialtyLeagueHistory_v1";
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
    // 3. DAILY DATA API
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
    // RESET ALL ACTIVITY / SPECIAL ROTATION (FIXED)
    // ==========================================================
    window.eraseRotationHistory = async function() {
        try {
            console.log("🔄 Erasing rotation history...");
            
            localStorage.removeItem(ROTATION_HISTORY_KEY);
            localStorage.removeItem(SMART_TILE_HISTORY_KEY);
            localStorage.removeItem(SMART_TILE_SPECIAL_HISTORY_KEY);
            
            if (typeof window.clearCloudKeys === 'function') {
                console.log("☁️ Clearing cloud keys for rotation history...");
                await window.clearCloudKeys([
                    'manualUsageOffsets',
                    'historicalCounts',
                    'smartTileHistory'
                ]);
            } else {
                window.saveGlobalSettings?.('manualUsageOffsets', undefined);
                window.saveGlobalSettings?.('historicalCounts', {});
                window.saveGlobalSettings?.('smartTileHistory', {});
                
                if (typeof window.forceSyncToCloud === 'function') {
                    await window.forceSyncToCloud();
                }
            }
            
            console.log("✅ All rotation histories cleared.");
            alert("Activity & Smart Tile History reset successfully!");
            window.location.reload();
        } catch (e) {
            console.error("Failed to reset history:", e);
            alert("Error resetting history. Check console.");
        }
    };
    
    // ==========================================================
    // START NEW HALF (FIXED)
    // ==========================================================
    window.startNewHalf = async function() {
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
            
            if (typeof window.clearCloudKeys === 'function') {
                console.log("☁️ Clearing cloud keys for new half...");
                await window.clearCloudKeys([
                    'leagueRoundState',
                    'manualUsageOffsets', 
                    'historicalCounts',
                    'smartTileHistory'
                ]);
                console.log("☁️ Cloud keys cleared");
            } else {
                window.saveGlobalSettings?.('leagueRoundState', {});
                window.saveGlobalSettings?.('manualUsageOffsets', undefined);
                window.saveGlobalSettings?.('historicalCounts', {});
                window.saveGlobalSettings?.('smartTileHistory', {});
                
                if (typeof window.forceSyncToCloud === 'function') {
                    await window.forceSyncToCloud();
                }
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
    // 5. ERASE ALL DATA (FIXED)
    // ==========================================================
    function setupEraseAll() {
        const btn = document.getElementById("eraseAllBtn");
        if (!btn) return;
        
        btn.onclick = async function() {
            if (!confirm("Erase ALL settings, schedules, and rotation histories?\nThis cannot be undone.")) return;
            
            btn.disabled = true;
            btn.textContent = "Erasing...";
            
            try {
                console.log("🗑️ Starting full data erase...");
                
                const localOnlyKeys = [
                    DAILY_DATA_KEY,
                    ROTATION_HISTORY_KEY,
                    AUTO_SAVE_KEY,
                    SMART_TILE_HISTORY_KEY,
                    SMART_TILE_SPECIAL_HISTORY_KEY,
                    LEAGUE_HISTORY_KEY,
                    SPECIALTY_LEAGUE_HISTORY_KEY,
                    "campSchedulerData",
                    "fixedActivities_v2",
                    "leagues",
                    "camp_league_round_state",
                    "camp_league_sport_rotation",
                    "scheduleAssignments",
                    "leagueAssignments"
                ];
                
                localOnlyKeys.forEach(key => {
                    localStorage.removeItem(key);
                    console.log("  Removed:", key);
                });
                
                if (typeof window.resetCloudState === 'function') {
                    console.log("☁️ Resetting cloud state...");
                    const success = await window.resetCloudState();
                    console.log("☁️ Cloud reset result:", success ? "SUCCESS" : "FAILED");
                    
                    if (!success) {
                        alert("⚠️ Warning: Cloud sync may have failed.\nLocal data has been cleared, but cloud data may persist.");
                    }
                } else {
                    console.log("⚠️ resetCloudState not available, using fallback...");
                    
                    const emptyState = {
                        divisions: {},
                        bunks: [],
                        app1: {
                            divisions: {},
                            bunks: [],
                            fields: [],
                            specialActivities: [],
                            allSports: [],
                            bunkMetaData: {},
                            sportMetaData: {},
                            savedSkeletons: {},
                            skeletonAssignments: {}
                        },
                        locationZones: {},
                        pinnedTileDefaults: {},
                        leaguesByName: {},
                        leagueRoundState: {},
                        updated_at: new Date().toISOString()
                    };
                    
                    const emptyJSON = JSON.stringify(emptyState);
                    localStorage.setItem(UNIFIED_CACHE_KEY, emptyJSON);
                    localStorage.setItem(LEGACY_GLOBAL_SETTINGS_KEY, emptyJSON);
                    localStorage.setItem("CAMPISTRY_LOCAL_CACHE", emptyJSON);
                    localStorage.setItem(LEGACY_GLOBAL_REGISTRY_KEY, JSON.stringify({
                        divisions: {},
                        bunks: []
                    }));
                    
                    if (typeof window.forceSyncToCloud === 'function') {
                        await window.forceSyncToCloud();
                    }
                }
                
                console.log("✅ Full data erase complete");
                window.location.reload();
                
            } catch (e) {
                console.error("Erase failed:", e);
                btn.disabled = false;
                btn.textContent = "Erase All Camp Data";
                alert("Error erasing data: " + e.message);
            }
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
    // ⭐ RE-INITIALIZE UI AFTER IMPORT (No Reload!)
    // ==========================================================
    function reinitializeUI() {
        console.log("🔄 Re-initializing UI after import...");
        
        try {
            // Re-initialize global authority (divisions/bunks)
            if (typeof window.initGlobalAuthority === 'function') {
                window.initGlobalAuthority();
                console.log("  ✓ Global authority");
            }
            
            // Re-initialize app1 (Setup tab)
            if (typeof window.initApp1 === 'function') {
                window.initApp1();
                console.log("  ✓ App1 (Setup)");
            }
            
            // Re-initialize fields tab
            if (typeof window.initFieldsTab === 'function') {
                window.initFieldsTab();
                console.log("  ✓ Fields");
            }
            
            // Re-initialize locations tab
            if (typeof window.initLocationsTab === 'function') {
                window.initLocationsTab();
                console.log("  ✓ Locations");
            }
            
            // Re-initialize special activities
            if (typeof window.initSpecialActivitiesTab === 'function') {
                window.initSpecialActivitiesTab();
                console.log("  ✓ Special Activities");
            }
            
            // Re-initialize leagues
            if (typeof window.initLeaguesTab === 'function') {
                window.initLeaguesTab();
                console.log("  ✓ Leagues");
            } else if (typeof window.initLeagues === 'function') {
                window.initLeagues();
                console.log("  ✓ Leagues");
            }
            
            // Re-initialize specialty leagues
            if (typeof window.initSpecialtyLeagues === 'function') {
                window.initSpecialtyLeagues();
                console.log("  ✓ Specialty Leagues");
            }
            
            // Re-initialize master scheduler
            if (typeof window.initMasterScheduler === 'function') {
                window.initMasterScheduler();
                console.log("  ✓ Master Scheduler");
            }
            
            // Re-initialize daily adjustments
            if (typeof window.initDailyAdjustments === 'function') {
                window.initDailyAdjustments();
                console.log("  ✓ Daily Adjustments");
            }
            
            // Update schedule table if visible
            if (typeof window.updateTable === 'function') {
                window.updateTable();
                console.log("  ✓ Schedule Table");
            }
            
            console.log("✅ UI re-initialization complete!");
            
        } catch (e) {
            console.error("UI re-initialization error:", e);
            // Fall back to page reload if UI init fails
            console.log("⚠️ Falling back to page reload...");
            window.location.reload();
        }
    }
    
    // ==========================================================
    // 8. BACKUP / RESTORE (FIXED - No Reload Import)
    // ==========================================================
    function exportAllData() {
        try {
            let globalSettings = window.loadGlobalSettings?.() || {};
            
            if (Object.keys(globalSettings).length === 0) {
                globalSettings = JSON.parse(localStorage.getItem(UNIFIED_CACHE_KEY) || "{}");
            }
            
            const colorIndex = globalSettings.divisionColorIndex || 0;
            
            const backup = {
                globalSettings: globalSettings,
                dailyData: JSON.parse(localStorage.getItem(DAILY_DATA_KEY) || "{}"),
                rotationHistory: JSON.parse(localStorage.getItem(ROTATION_HISTORY_KEY) || "{}"),
                smartTileHistory: JSON.parse(localStorage.getItem(SMART_TILE_HISTORY_KEY) || "{}"),
                smartTileSpecialHistory: JSON.parse(localStorage.getItem(SMART_TILE_SPECIAL_HISTORY_KEY) || "{}"),
                leagueHistory: JSON.parse(localStorage.getItem(LEAGUE_HISTORY_KEY) || "{}"),
                specialtyLeagueHistory: JSON.parse(localStorage.getItem(SPECIALTY_LEAGUE_HISTORY_KEY) || "{}"),
                divisions: globalSettings.divisions || {},
                bunks: globalSettings.bunks || [],
                divisionColorIndex: colorIndex,
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
    
    let _importInProgress = false;
    
    function handleFileSelect(e) {
        console.log("📁 handleFileSelect called, importInProgress:", _importInProgress);
        
        if (_importInProgress) {
            console.log("Import already in progress, ignoring duplicate trigger");
            return;
        }
        
        const file = e.target.files?.[0];
        console.log("📁 File from event:", file?.name);
        
        if (!file) {
            console.log("No file selected");
            return;
        }
        
        _importInProgress = true;
        console.log("📁 Starting import of:", file.name);
        
        const input = e.target;
        
        if (!confirm("Importing will overwrite ALL current data.\nProceed?")) {
            input.value = "";
            _importInProgress = false;
            console.log("📁 Import cancelled by user");
            return;
        }
        
        console.log("📥 User confirmed, reading file...");
        
        const reader = new FileReader();
        
        reader.onload = async function(evt) {
            console.log("📥 File read complete, parsing JSON...");
            try {
                const backup = JSON.parse(evt.target.result);
                
                console.log("📥 Importing backup version:", backup.exportVersion || 1);
                console.log("📥 Backup keys:", Object.keys(backup));
                
                // ⭐ Build unified state from backup
                let unifiedState = {};
                
                if (backup.globalSettings) {
                    unifiedState = { ...backup.globalSettings };
                    console.log("  ↳ Loaded globalSettings");
                }
                
                if (backup.divisions && Object.keys(backup.divisions).length > 0) {
                    unifiedState.divisions = backup.divisions;
                    console.log("  ↳ Loaded divisions:", Object.keys(backup.divisions).length);
                }
                if (backup.bunks && backup.bunks.length > 0) {
                    unifiedState.bunks = backup.bunks;
                    console.log("  ↳ Loaded bunks:", backup.bunks.length);
                }
                
                if (backup.divisionColorIndex !== undefined) {
                    unifiedState.divisionColorIndex = backup.divisionColorIndex;
                }
                
                // Handle legacy backups
                if (backup.globalRegistry) {
                    if (backup.globalRegistry.divisions) {
                        unifiedState.divisions = backup.globalRegistry.divisions;
                        console.log("  ↳ Loaded divisions from globalRegistry");
                    }
                    if (backup.globalRegistry.bunks) {
                        unifiedState.bunks = backup.globalRegistry.bunks;
                        console.log("  ↳ Loaded bunks from globalRegistry");
                    }
                }
                
                if (unifiedState.app1) {
                    if (unifiedState.app1.divisions && (!unifiedState.divisions || Object.keys(unifiedState.divisions).length === 0)) {
                        unifiedState.divisions = unifiedState.app1.divisions;
                        console.log("  ↳ Loaded divisions from app1");
                    }
                    if (unifiedState.app1.bunks && (!unifiedState.bunks || unifiedState.bunks.length === 0)) {
                        unifiedState.bunks = unifiedState.app1.bunks;
                        console.log("  ↳ Loaded bunks from app1");
                    }
                    if (unifiedState.app1.fields) {
                        unifiedState.fields = unifiedState.app1.fields;
                        console.log("  ↳ Loaded fields from app1");
                    }
                }
                
                // ⭐ Use setCloudState to properly update memory cache + cloud
                if (typeof window.setCloudState === 'function') {
                    console.log("☁️ Using setCloudState for import...");
                    const success = await window.setCloudState(unifiedState, true);
                    console.log("☁️ setCloudState result:", success ? "SUCCESS" : "FAILED");
                    
                    if (!success) {
                        console.warn("☁️ Cloud sync failed, but local data was saved");
                    }
                } else {
                    // Fallback: Direct localStorage writes
                    console.log("⚠️ setCloudState not available, using fallback...");
                    const unifiedJSON = JSON.stringify(unifiedState);
                    localStorage.setItem(UNIFIED_CACHE_KEY, unifiedJSON);
                    localStorage.setItem(LEGACY_GLOBAL_SETTINGS_KEY, unifiedJSON);
                    localStorage.setItem(LEGACY_GLOBAL_REGISTRY_KEY, JSON.stringify({
                        divisions: unifiedState.divisions || {},
                        bunks: unifiedState.bunks || []
                    }));
                    localStorage.setItem("CAMPISTRY_LOCAL_CACHE", unifiedJSON);
                }
                
                // Restore daily data (not cloud-synced)
                if (backup.dailyData) {
                    localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(backup.dailyData));
                    console.log("  ↳ Restored daily data");
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
                
                console.log("✅ Import to storage complete:", {
                    divisions: Object.keys(unifiedState.divisions || {}).length,
                    bunks: (unifiedState.bunks || []).length,
                    fields: (unifiedState.fields || unifiedState.app1?.fields || []).length
                });
                
                // Reset import flag
                _importInProgress = false;
                input.value = "";
                
                // ⭐ Re-initialize UI without page reload
                alert(
                    "✅ Import successful!\n\n" +
                    "Divisions: " + Object.keys(unifiedState.divisions || {}).length + "\n" +
                    "Bunks: " + (unifiedState.bunks || []).length + "\n\n" +
                    "Refreshing UI..."
                );
                
                // Short delay to let alert close, then refresh UI
                setTimeout(() => {
                    reinitializeUI();
                }, 100);
                
            } catch (err) {
                console.error("Import failed:", err);
                alert("Invalid backup file. Error: " + err.message);
                _importInProgress = false;
                input.value = "";
            }
        };
        
        reader.onerror = function() {
            console.error("File read error");
            alert("Failed to read file.");
            _importInProgress = false;
            input.value = "";
        };
        
        reader.readAsText(file);
    }
    window.__campistry_handleFileSelect = handleFileSelect;
    
    // ==========================================================
    // 9. AUTO-SAVE SYSTEM
    // ==========================================================
    function performAutoSave(silent = true) {
        try {
            const currentState = window.loadGlobalSettings?.() || {};
            
            const snapshot = {
                timestamp: Date.now(),
                [UNIFIED_CACHE_KEY]: JSON.stringify(currentState),
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
    
    window.restoreAutoSave = async function() {
        try {
            const raw = localStorage.getItem(AUTO_SAVE_KEY);
            if (!raw) return alert("No auto-save available.");
            const snap = JSON.parse(raw);
            const date = new Date(snap.timestamp).toLocaleString();
            if (!confirm("Restore auto-save from " + date + "?\nThis will overwrite current data.")) return;
            
            Object.keys(snap).forEach(key => {
                if (key === 'timestamp') return;
                if (snap[key]) {
                    localStorage.setItem(key, snap[key]);
                }
            });
            
            if (snap[UNIFIED_CACHE_KEY]) {
                localStorage.setItem(LEGACY_GLOBAL_SETTINGS_KEY, snap[UNIFIED_CACHE_KEY]);
                localStorage.setItem("CAMPISTRY_LOCAL_CACHE", snap[UNIFIED_CACHE_KEY]);
                
                // Update memory cache via setCloudState
                if (typeof window.setCloudState === 'function') {
                    const state = JSON.parse(snap[UNIFIED_CACHE_KEY]);
                    await window.setCloudState(state, true);
                }
            }
            
            alert("Auto-save restored. Refreshing UI...");
            reinitializeUI();
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
        startAutoSaveTimer();
        
        console.log("🗓️ Calendar initialized (FIXED v2.2)");
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
    let _bound = false;
    
    function wire() {
        if (_bound) return;
        
        const exp = document.getElementById("exportBackupBtn");
        const imp = document.getElementById("importBackupBtn");
        const inp = document.getElementById("importFileInput");
        
        console.log("🔌 Late-bind check:", { exp: !!exp, imp: !!imp, inp: !!inp });
        
        if (!exp || !imp || !inp) {
            console.log("🔌 Elements not ready yet...");
            return;
        }
        
        exp.onclick = function(e) {
            console.log("📤 Export clicked");
            e.preventDefault();
            if (window.__campistry_exportAllData) {
                window.__campistry_exportAllData();
            } else {
                console.error("Export function not found!");
            }
        };
        
        imp.onclick = function(e) {
            console.log("📥 Import button clicked, opening file dialog...");
            e.preventDefault();
            inp.value = "";
            inp.click();
        };
        
        inp.onchange = function(e) {
            console.log("📁 File selected:", e.target.files?.[0]?.name);
            if (window.__campistry_handleFileSelect) {
                window.__campistry_handleFileSelect(e);
            } else {
                console.error("Import handler not found!");
            }
        };
        
        _bound = true;
        console.log("✅ Backup / Import buttons wired successfully");
    }

    setTimeout(wire, 100);
    setTimeout(wire, 300);
    setTimeout(wire, 600);
    setTimeout(wire, 1000);
    setTimeout(wire, 2000);
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wire);
    }
})();
