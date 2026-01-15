// =================================================================
// calendar.js (FIXED v4.0 - CRITICAL DELETION FIX INTEGRATED)
// =================================================================
// 
// v4.0 CHANGES:
// - CRITICAL FIX: Scheduler deletion now removes bunks from ALL records
// - Integrated deleteMyBunksFromAllRecords() directly into this file
// - No external patches required
// - Full cloud + localStorage + window globals cleanup
//
// =================================================================
(function() {
    'use strict';
    console.log("🗓️ calendar.js v4.0 (DELETION FIX INTEGRATED) loaded");
    
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
    // Helper — Check localStorage quota
    // ==========================================================
    function getLocalStorageUsage() {
        let total = 0;
        try {
            for (let key in localStorage) {
                if (localStorage.hasOwnProperty(key)) {
                    total += (localStorage[key].length * 2); // UTF-16 = 2 bytes per char
                }
            }
        } catch (e) {
            console.warn("Could not calculate localStorage usage:", e);
        }
        return total;
    }
    
    function isLocalStorageNearQuota() {
        const usage = getLocalStorageUsage();
        const estimatedQuota = 5 * 1024 * 1024; // 5MB typical limit
        return usage > (estimatedQuota * 0.9); // 90% full
    }
    
    function safeLocalStorageSet(key, value) {
        try {
            localStorage.setItem(key, value);
            return true;
        } catch (e) {
            if (e.name === 'QuotaExceededError') {
                console.warn(`⚠️ localStorage quota exceeded for key: ${key}`);
                // Try to free up space by removing auto-save cache
                if (key !== AUTO_SAVE_KEY) {
                    try {
                        localStorage.removeItem(AUTO_SAVE_KEY);
                        console.log("🗑️ Cleared auto-save cache to free space");
                        localStorage.setItem(key, value);
                        return true;
                    } catch (e2) {
                        console.error("Still cannot save after clearing auto-save:", e2);
                    }
                }
                return false;
            }
            throw e;
        }
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
            
            // Add updated_at to the daily data blob itself for consistency
            all.updated_at = new Date().toISOString();
            
            // Update UI reference immediately
            window.currentDailyData = all[date];
            // 🟢 UNIFIED SAVING: Delegate to Bridge (Same way as Divisions)
            // 'daily_schedules' is the special key the bridge uses to bundle/unbundle this data
            if (typeof window.saveGlobalSettings === 'function') {
                console.log("☁️ Saving daily data via Bridge (Unified Flow)...");
                window.saveGlobalSettings('daily_schedules', all);
            } else {
                // Fallback if bridge is missing
                console.warn("⚠️ Bridge not found, falling back to local save");
                safeLocalStorageSet(DAILY_DATA_KEY, JSON.stringify(all));
            }
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
            safeLocalStorageSet(ROTATION_HISTORY_KEY, JSON.stringify(hist));
            // 🟢 TRIGGER CLOUD SYNC
            if (typeof window.scheduleCloudSync === 'function') {
                window.scheduleCloudSync();
            }
        } catch (e) {
            console.error("Failed to save rotation history:", e);
        }
    };
    
    // ==========================================================
    // RESET ALL ACTIVITY / SPECIAL ROTATION
    // ==========================================================
    window.eraseRotationHistory = async function() {
        if (!window.AccessControl?.canEraseData?.()) {
            window.AccessControl?.showPermissionDenied?.('erase rotation history');
            return;
        }
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
                    'smartTileHistory',
                    'rotationHistory'
                ]);
            } else {
                window.saveGlobalSettings?.('manualUsageOffsets', {});
                window.saveGlobalSettings?.('historicalCounts', {});
                window.saveGlobalSettings?.('smartTileHistory', {});
                window.saveGlobalSettings?.('rotationHistory', { bunks: {}, leagues: {} });
                
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
    // START NEW HALF
    // ==========================================================
    window.startNewHalf = async function() {
        if (!window.AccessControl?.canEraseData?.()) {
            window.AccessControl?.showPermissionDenied?.('start new half');
            return;
        }
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
            
            // Clear localStorage
            localStorage.removeItem(ROTATION_HISTORY_KEY);
            localStorage.removeItem(SMART_TILE_HISTORY_KEY);
            localStorage.removeItem(SMART_TILE_SPECIAL_HISTORY_KEY);
            localStorage.removeItem(LEAGUE_HISTORY_KEY);
            localStorage.removeItem(SPECIALTY_LEAGUE_HISTORY_KEY);
            localStorage.removeItem(DAILY_DATA_KEY);
            
            // ★★★ CRITICAL: Clear ALL cloud keys including new league history keys ★★★
            if (typeof window.clearCloudKeys === 'function') {
                console.log("☁️ Clearing cloud keys for new half...");
                await window.clearCloudKeys([
                    'leagueRoundState',
                    'leagueHistory',              // ★ Regular league history (gamesPerDate)
                    'specialtyLeagueHistory',     // ★ Specialty league history
                    'daily_schedules',            // ★ Clear saved schedules from cloud
                    'manualUsageOffsets', 
                    'historicalCounts',
                    'smartTileHistory',
                    'rotationHistory'
                ]);
                console.log("☁️ Cloud keys cleared");
            } else {
                // Fallback: Set empty objects
                window.saveGlobalSettings?.('leagueRoundState', {});
                window.saveGlobalSettings?.('leagueHistory', {});
                window.saveGlobalSettings?.('specialtyLeagueHistory', {});
                window.saveGlobalSettings?.('daily_schedules', {});
                window.saveGlobalSettings?.('manualUsageOffsets', {});
                window.saveGlobalSettings?.('historicalCounts', {});
                window.saveGlobalSettings?.('smartTileHistory', {});
                window.saveGlobalSettings?.('rotationHistory', { bunks: {}, leagues: {} });
                
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
    // 5. ERASE ALL DATA
    // ==========================================================
    function setupEraseAll() {
        const btn = document.getElementById("eraseAllBtn");
        if (!btn) return;
        
        btn.onclick = async function() {
            if (!window.AccessControl?.canEraseData?.()) {
                window.AccessControl?.showPermissionDenied?.('erase all data');
                return;
            }
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
                
                // ★★★ CRITICAL: Use resetCloudState to properly clear cloud ★★★
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
                            divisions: {}, bunks: [], fields: [], specialActivities: [],
                            allSports: [], bunkMetaData: {}, sportMetaData: {},
                            savedSkeletons: {}, skeletonAssignments: {}
                        },
                        locationZones: {},
                        pinnedTileDefaults: {},
                        leaguesByName: {},
                        leagueRoundState: {},
                        leagueHistory: {},
                        specialtyLeagueHistory: {},
                        daily_schedules: {}, // ★ CRITICAL: Set empty to clear cloud
                        updated_at: new Date().toISOString()
                    };
                    
                    const emptyJSON = JSON.stringify(emptyState);
                    safeLocalStorageSet(UNIFIED_CACHE_KEY, emptyJSON);
                    safeLocalStorageSet(LEGACY_GLOBAL_SETTINGS_KEY, emptyJSON);
                    safeLocalStorageSet("CAMPISTRY_LOCAL_CACHE", emptyJSON);
                    safeLocalStorageSet(LEGACY_GLOBAL_REGISTRY_KEY, JSON.stringify({
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
    // 6. ★★★ CRITICAL FIX: HELPER FUNCTIONS FOR SCHEDULER DELETE ★★★
    // ==========================================================
    
    /**
     * Get the list of bunk IDs that the current user can edit
     * based on their assigned divisions.
     */
    function getMyEditableBunks() {
        const editableDivisions = window.AccessControl?.getEditableDivisions?.() || 
                                 window.PermissionsDB?.getEditableDivisions?.() || [];
        
        const divisions = window.divisions || {};
        const bunks = [];
        
        for (const divName of editableDivisions) {
            const divInfo = divisions[divName];
            if (divInfo?.bunks) {
                bunks.push(...divInfo.bunks);
            }
        }
        
        return bunks;
    }
    
    /**
     * ★★★ THE CRITICAL FIX ★★★
     * 
     * Delete the current user's bunks from ALL schedule records for a date.
     * 
     * WHY THIS IS NECESSARY:
     * - The owner might save a record containing ALL bunks (including scheduler's)
     * - Simply deleting the scheduler's own record doesn't remove their bunks
     *   from the owner's record
     * - On reload, the owner's record loads → scheduler's bunks reappear!
     * 
     * THE FIX:
     * - Load ALL records for the date
     * - Remove the scheduler's bunks from EVERY record
     * - Update or delete each modified record
     */
    async function deleteMyBunksFromAllRecords(dateKey) {
        console.log('🗑️ [CRITICAL FIX] deleteMyBunksFromAllRecords called for:', dateKey);
        
        const client = window.CampistryDB?.getClient?.() || window.supabase;
        const campId = window.CampistryDB?.getCampId?.() || window.getCampId?.();
        
        if (!client || !campId) {
            console.error('🗑️ Cannot delete: missing client or campId');
            return { success: false, error: 'Database not available' };
        }
        
        // Step 1: Get my editable bunks
        const myBunks = getMyEditableBunks();
        console.log('🗑️ My bunks to delete:', myBunks);
        
        if (myBunks.length === 0) {
            console.log('🗑️ No bunks assigned to delete');
            return { success: true, message: 'No bunks assigned' };
        }
        
        try {
            // Step 2: Load ALL records for this date
            const { data: allRecords, error: loadError } = await client
                .from('daily_schedules')
                .select('*')
                .eq('camp_id', campId)
                .eq('date_key', dateKey);
            
            if (loadError) {
                console.error('🗑️ Failed to load records:', loadError);
                return { success: false, error: loadError.message };
            }
            
            if (!allRecords || allRecords.length === 0) {
                console.log('🗑️ No records found in cloud');
                return { success: true, message: 'No cloud records' };
            }
            
            console.log('🗑️ Found', allRecords.length, 'records to process');
            
            // Step 3: For EACH record, remove my bunks
            const myBunkSet = new Set(myBunks);
            let recordsModified = 0;
            let recordsDeleted = 0;
            let bunksRemoved = 0;
            
            for (const record of allRecords) {
                const scheduleData = record.schedule_data || {};
                const assignments = { ...(scheduleData.scheduleAssignments || {}) };
                const leagues = { ...(scheduleData.leagueAssignments || {}) };
                
                const bunksBefore = Object.keys(assignments).length;
                
                // Remove my bunks from this record
                let modified = false;
                for (const bunk of myBunks) {
                    if (assignments[bunk] !== undefined) {
                        delete assignments[bunk];
                        modified = true;
                        bunksRemoved++;
                    }
                    if (leagues[bunk] !== undefined) {
                        delete leagues[bunk];
                    }
                }
                
                const bunksAfter = Object.keys(assignments).length;
                console.log(`🗑️ Record ${record.scheduler_name || record.scheduler_id?.substring(0, 8)}: ${bunksBefore} → ${bunksAfter} bunks`);
                
                if (!modified) {
                    console.log('🗑️   Skipping - no changes needed');
                    continue;
                }
                
                // If record is now empty, delete it entirely
                if (bunksAfter === 0) {
                    console.log('🗑️   Record now empty, deleting...');
                    const { error: deleteError } = await client
                        .from('daily_schedules')
                        .delete()
                        .eq('id', record.id);
                    
                    if (deleteError) {
                        console.error('🗑️   Delete failed:', deleteError);
                    } else {
                        recordsDeleted++;
                        console.log('🗑️   ✅ Deleted empty record');
                    }
                } else {
                    // Update the record with bunks removed
                    console.log('🗑️   Updating record with', bunksAfter, 'remaining bunks...');
                    
                    const updatedData = {
                        ...scheduleData,
                        scheduleAssignments: assignments,
                        leagueAssignments: leagues
                    };
                    
                    const { error: updateError } = await client
                        .from('daily_schedules')
                        .update({
                            schedule_data: updatedData,
                            updated_at: new Date().toISOString()
                        })
                        .eq('id', record.id);
                    
                    if (updateError) {
                        console.error('🗑️   Update failed:', updateError);
                    } else {
                        recordsModified++;
                        console.log('🗑️   ✅ Updated record');
                    }
                }
            }
            
            console.log(`🗑️ Delete complete: ${recordsModified} modified, ${recordsDeleted} deleted, ${bunksRemoved} bunks removed`);
            
            return {
                success: true,
                recordsModified,
                recordsDeleted,
                bunksRemoved
            };
            
        } catch (e) {
            console.error('🗑️ deleteMyBunksFromAllRecords exception:', e);
            return { success: false, error: e.message };
        }
    }
    
    /**
     * Clear the current user's bunks from window globals
     */
    function clearMyBunksFromGlobals() {
        const myBunks = new Set(getMyEditableBunks());
        
        if (window.scheduleAssignments) {
            myBunks.forEach(bunk => {
                delete window.scheduleAssignments[bunk];
            });
        }
        
        if (window.leagueAssignments) {
            myBunks.forEach(bunk => {
                delete window.leagueAssignments[bunk];
            });
        }
        
        console.log('🗑️ Cleared', myBunks.size, 'bunks from window globals');
    }
    
    /**
     * Clear the current user's bunks from localStorage
     */
    function clearMyBunksFromLocalStorage(dateKey) {
        try {
            const all = window.loadAllDailyData();
            const dateData = all[dateKey];
            
            if (!dateData) return;
            
            const myBunks = new Set(getMyEditableBunks());
            
            if (dateData.scheduleAssignments) {
                myBunks.forEach(bunk => {
                    delete dateData.scheduleAssignments[bunk];
                });
            }
            
            if (dateData.leagueAssignments) {
                myBunks.forEach(bunk => {
                    delete dateData.leagueAssignments[bunk];
                });
            }
            
            safeLocalStorageSet(DAILY_DATA_KEY, JSON.stringify(all));
            console.log('🗑️ Cleared my bunks from localStorage');
        } catch (e) {
            console.error('🗑️ Failed to clear localStorage:', e);
        }
    }
    
    /**
     * Reload remaining schedule data from cloud after deletion
     */
    async function reloadRemainingData(dateKey) {
        if (!window.ScheduleDB?.loadSchedule) {
            console.log('🗑️ ScheduleDB not available for reload');
            return;
        }
        
        try {
            const result = await window.ScheduleDB.loadSchedule(dateKey);
            
            if (result?.success && result.data) {
                // Merge remaining data into window globals
                window.scheduleAssignments = result.data.scheduleAssignments || {};
                window.leagueAssignments = result.data.leagueAssignments || {};
                
                // Update localStorage
                const all = window.loadAllDailyData();
                all[dateKey] = {
                    ...all[dateKey],
                    scheduleAssignments: result.data.scheduleAssignments || {},
                    leagueAssignments: result.data.leagueAssignments || {}
                };
                safeLocalStorageSet(DAILY_DATA_KEY, JSON.stringify(all));
                
                console.log('🗑️ Reloaded', Object.keys(result.data.scheduleAssignments || {}).length, 'bunks from remaining data');
            } else {
                console.log('🗑️ No remaining data after delete');
            }
        } catch (e) {
            console.error('🗑️ Failed to reload remaining data:', e);
        }
    }
    
    // ==========================================================
    // 7. ERASE CURRENT DAY - ★★★ CRITICAL FIX INTEGRATED ★★★
    // ==========================================================
    window.eraseCurrentDailyData = async function() {
        const dateKey = window.currentScheduleDate;
        const role = window.AccessControl?.getCurrentRole?.() || 
                    window.CampistryDB?.getRole?.() || 'viewer';
        
        console.log('🗑️ eraseCurrentDailyData called for:', dateKey, 'role:', role);
        
        // ═══════════════════════════════════════════════════════════════
        // SCHEDULER: Delete only their divisions from ALL records
        // ═══════════════════════════════════════════════════════════════
        if (role === 'scheduler') {
            const myDivisions = window.AccessControl?.getEditableDivisions?.() || [];
            
            if (myDivisions.length === 0) {
                alert("You don't have any divisions assigned.");
                return;
            }
            
            const confirmMsg = `Delete YOUR schedule for divisions: ${myDivisions.join(', ')}?\n\n` +
                             `Other schedulers' data will be preserved.`;
            
            if (!confirm(confirmMsg)) return;
            
            console.log('🗑️ Scheduler deleting divisions:', myDivisions);
            
            // ★★★ THE CRITICAL FIX: Remove bunks from ALL records ★★★
            const cloudResult = await deleteMyBunksFromAllRecords(dateKey);
            
            if (!cloudResult?.success) {
                console.error('🗑️ Cloud delete failed:', cloudResult?.error);
                alert('Error deleting schedule: ' + (cloudResult?.error || 'Unknown error'));
                return;
            }
            
            console.log('🗑️ Cloud delete result:', cloudResult);
            
            // Clear from localStorage
            clearMyBunksFromLocalStorage(dateKey);
            
            // Clear from window globals
            clearMyBunksFromGlobals();
            
            // Reload remaining data from other schedulers
            await reloadRemainingData(dateKey);
        }
        // ═══════════════════════════════════════════════════════════════
        // OWNER/ADMIN: Delete everything
        // ═══════════════════════════════════════════════════════════════
        else if (role === 'owner' || role === 'admin') {
            const confirmMsg = `Delete ALL schedule data for ${dateKey}?\n\n` +
                             `This will delete data from ALL schedulers and cannot be undone.`;
            
            if (!confirm(confirmMsg)) return;
            
            console.log('🗑️ Owner/Admin: Full delete');
            
            // Delete from cloud using ScheduleDB
            if (window.ScheduleDB?.deleteSchedule) {
                console.log('🗑️ Calling ScheduleDB.deleteSchedule...');
                const result = await window.ScheduleDB.deleteSchedule(dateKey);
                console.log('🗑️ Full delete result:', result);
            } else {
                // Fallback: Direct delete
                const client = window.CampistryDB?.getClient?.() || window.supabase;
                const campId = window.CampistryDB?.getCampId?.() || window.getCampId?.();
                
                if (client && campId) {
                    const { error } = await client
                        .from('daily_schedules')
                        .delete()
                        .eq('camp_id', campId)
                        .eq('date_key', dateKey);
                    
                    if (error) {
                        console.error('🗑️ Direct delete error:', error);
                    }
                }
            }
            
            // Clear localStorage
            const all = window.loadAllDailyData();
            if (all[dateKey]) {
                delete all[dateKey];
                safeLocalStorageSet(DAILY_DATA_KEY, JSON.stringify(all));
            }
            
            // Clear ALL window globals
            window.scheduleAssignments = {};
            window.leagueAssignments = {};
        }
        // ═══════════════════════════════════════════════════════════════
        // VIEWER: No permission
        // ═══════════════════════════════════════════════════════════════
        else {
            alert('You do not have permission to delete schedules.');
            return;
        }
        
        // ═══════════════════════════════════════════════════════════════
        // REFRESH UI
        // ═══════════════════════════════════════════════════════════════
        
        console.log('🗑️ Refreshing UI...');
        
        if (window.updateTable) {
            window.updateTable();
        }
        
        if (window.initScheduleSystem) {
            window.initScheduleSystem();
        }
        
        // Dispatch event for other modules
        window.dispatchEvent(new CustomEvent('campistry-schedule-deleted', {
            detail: { dateKey, role }
        }));
        
        console.log('🗑️ ✅ Erase complete');
    };
    
    // ==========================================================
    // 8. ERASE ALL SCHEDULE DAYS - ★ FIXED to sync deletion to cloud ★
    // ==========================================================
    window.eraseAllDailyData = async function() {
        if (!window.AccessControl?.canEraseData?.()) {
            window.AccessControl?.showPermissionDenied?.('erase all daily data');
            return;
        }
        
        const confirmMsg = 'Delete ALL schedule data for ALL dates?\n\n' +
                          '⚠️ This will permanently delete schedules from all schedulers for all dates.\n\n' +
                          'This action cannot be undone!';
        
        if (!confirm(confirmMsg)) return;
        
        console.log("🗑️ Erasing all daily data...");
        
        try {
            // Delete all records from cloud
            const client = window.CampistryDB?.getClient?.() || window.supabase;
            const campId = window.CampistryDB?.getCampId?.() || window.getCampId?.();
            
            if (client && campId) {
                console.log('🗑️ Deleting all records from daily_schedules...');
                const { error } = await client
                    .from('daily_schedules')
                    .delete()
                    .eq('camp_id', campId);
                
                if (error) {
                    console.error('🗑️ Cloud delete error:', error);
                } else {
                    console.log('🗑️ Cloud delete successful');
                }
            }
            
            // Clear localStorage
            localStorage.removeItem(DAILY_DATA_KEY);
            
            // Also clear via bridge if available
            if (typeof window.clearCloudKeys === 'function') {
                console.log("☁️ Clearing daily_schedules from cloud bridge...");
                await window.clearCloudKeys(['daily_schedules']);
            } else if (typeof window.saveGlobalSettings === 'function') {
                window.saveGlobalSettings('daily_schedules', {});
                if (typeof window.forceSyncToCloud === 'function') {
                    await window.forceSyncToCloud();
                }
            }
            
            // Clear window globals
            window.scheduleAssignments = {};
            window.leagueAssignments = {};
            
            console.log("✅ All daily data erased");
            
            alert('All schedule data has been deleted.');
            window.location.reload();
            
        } catch (e) {
            console.error('🗑️ Erase all failed:', e);
            alert('Error erasing data: ' + e.message);
        }
    };
    
    // ==========================================================
    // RE-INITIALIZE UI AFTER IMPORT
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
    // 9. BACKUP / RESTORE
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
                
                // Restore daily data first (so setCloudState can pick it up if we decide to merge, 
                // but actually setCloudState mostly deals with unifiedState. 
                // We'll manually attach dailyData to unifiedState before calling setCloudState if we want it synced instantly)
                
                if (backup.dailyData) {
                    // Inject into unifiedState so setCloudState sees it and syncs it
                    unifiedState.daily_schedules = backup.dailyData;
                    // Also save locally just in case
                    safeLocalStorageSet(DAILY_DATA_KEY, JSON.stringify(backup.dailyData));
                    console.log("  ↳ Restored daily data (injected for sync)");
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
                    safeLocalStorageSet(UNIFIED_CACHE_KEY, unifiedJSON);
                    safeLocalStorageSet(LEGACY_GLOBAL_SETTINGS_KEY, unifiedJSON);
                    safeLocalStorageSet(LEGACY_GLOBAL_REGISTRY_KEY, JSON.stringify({
                        divisions: unifiedState.divisions || {},
                        bunks: unifiedState.bunks || []
                    }));
                    safeLocalStorageSet("CAMPISTRY_LOCAL_CACHE", unifiedJSON);
                }
                
                if (backup.rotationHistory) {
                    safeLocalStorageSet(ROTATION_HISTORY_KEY, JSON.stringify(backup.rotationHistory));
                }
                if (backup.smartTileHistory) {
                    safeLocalStorageSet(SMART_TILE_HISTORY_KEY, JSON.stringify(backup.smartTileHistory));
                }
                if (backup.smartTileSpecialHistory) {
                    safeLocalStorageSet(SMART_TILE_SPECIAL_HISTORY_KEY, JSON.stringify(backup.smartTileSpecialHistory));
                }
                if (backup.leagueHistory) {
                    safeLocalStorageSet(LEAGUE_HISTORY_KEY, JSON.stringify(backup.leagueHistory));
                }
                if (backup.specialtyLeagueHistory) {
                    safeLocalStorageSet(SPECIALTY_LEAGUE_HISTORY_KEY, JSON.stringify(backup.specialtyLeagueHistory));
                }
                
                console.log("✅ Import to storage complete:", {
                    divisions: Object.keys(unifiedState.divisions || {}).length,
                    bunks: (unifiedState.bunks || []).length,
                    fields: (unifiedState.fields || unifiedState.app1?.fields || []).length
                });
                
                // Reset import flag
                _importInProgress = false;
                input.value = "";
                
                // ⭐ Show success and reload page (session persists in Supabase)
                alert(
                    "✅ Import successful!\n\n" +
                    "Divisions: " + Object.keys(unifiedState.divisions || {}).length + "\n" +
                    "Bunks: " + (unifiedState.bunks || []).length + "\n\n" +
                    "Reloading..."
                );
                
                // Reload page - Supabase session persists in localStorage
                window.location.reload();
                
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
    // 10. AUTO-SAVE SYSTEM - ★★★ FIXED with quota handling ★★★
    // ==========================================================
    function performAutoSave(silent = true) {
        try {
            // ★★★ FIX: Check if localStorage is near quota ★★★
            if (isLocalStorageNearQuota()) {
                console.warn("⚠️ localStorage near quota, skipping auto-save (data is in cloud)");
                // Try to clear old auto-save to free space
                localStorage.removeItem(AUTO_SAVE_KEY);
                return;
            }
            
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
            
            // ★★★ FIX: Use safe setter with quota handling ★★★
            const saved = safeLocalStorageSet(AUTO_SAVE_KEY, JSON.stringify(snapshot));
            
            if (!saved) {
                console.warn("⚠️ Auto-save skipped due to quota. Data is saved to cloud.");
                if (!silent) {
                    alert("Auto-save skipped (storage full). Your data is safely stored in the cloud.");
                }
                return;
            }
            
            if (!silent) alert("Work saved!");
        } catch (e) {
            // ★★★ FIX: Handle quota error gracefully ★★★
            if (e.name === 'QuotaExceededError') {
                console.warn("⚠️ Auto-save failed: localStorage quota exceeded. Data is in cloud.");
                // Clear auto-save to free space for critical data
                localStorage.removeItem(AUTO_SAVE_KEY);
                if (!silent) {
                    alert("Auto-save skipped (storage full). Your data is safely stored in the cloud.");
                }
            } else {
                console.error("Auto-save failed:", e);
                if (!silent) alert("Save failed: " + e.message);
            }
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
                    safeLocalStorageSet(key, snap[key]);
                }
            });
            
            if (snap[UNIFIED_CACHE_KEY]) {
                safeLocalStorageSet(LEGACY_GLOBAL_SETTINGS_KEY, snap[UNIFIED_CACHE_KEY]);
                safeLocalStorageSet("CAMPISTRY_LOCAL_CACHE", snap[UNIFIED_CACHE_KEY]);
                
                // Update memory cache via setCloudState
                if (typeof window.setCloudState === 'function') {
                    const state = JSON.parse(snap[UNIFIED_CACHE_KEY]);
                    
                    // Inject schedules if present in snapshot, so they sync too
                    if (snap[DAILY_DATA_KEY]) {
                        state.daily_schedules = JSON.parse(snap[DAILY_DATA_KEY]);
                    }
                    await window.setCloudState(state, true);
                }
            }
            
            alert("Auto-save restored. Reloading...");
            window.location.reload();
        } catch (e) {
            console.error("Restore error:", e);
            alert("Failed to restore backup.");
        }
    };
    
    // ★★★ NEW: Utility to clear localStorage space ★★★
    window.clearLocalStorageCache = function() {
        const keysToRemove = [AUTO_SAVE_KEY, 'CAMPISTRY_LOCAL_CACHE'];
        let freed = 0;
        
        keysToRemove.forEach(key => {
            const item = localStorage.getItem(key);
            if (item) {
                freed += item.length * 2;
                localStorage.removeItem(key);
                console.log(`🗑️ Removed ${key}`);
            }
        });
        
        console.log(`✅ Freed approximately ${(freed / 1024).toFixed(1)} KB`);
        return freed;
    };
    
    // ★★★ NEW: Diagnostic function for localStorage ★★★
    window.diagnoseLocalStorage = function() {
        let total = 0;
        const items = [];
        
        for (let key in localStorage) {
            if (localStorage.hasOwnProperty(key)) {
                const size = (localStorage[key].length * 2) / 1024;
                total += size;
                items.push({ key, size: size.toFixed(1) + ' KB' });
            }
        }
        
        items.sort((a, b) => parseFloat(b.size) - parseFloat(a.size));
        
        console.log("=== localStorage Usage ===");
        items.slice(0, 10).forEach(item => {
            console.log(`  ${item.key}: ${item.size}`);
        });
        console.log(`Total: ${(total / 1024).toFixed(2)} MB`);
        console.log(`Near quota: ${isLocalStorageNearQuota()}`);
        
        return { total: (total / 1024).toFixed(2) + ' MB', items };
    };
    
    function startAutoSaveTimer() {
        setInterval(() => performAutoSave(true), 300000); // 5 minutes
        setTimeout(() => performAutoSave(true), 5000); // Initial save after 5s
    }
    
    // ==========================================================
    // 11. INIT CALENDAR
    // ==========================================================
    function initCalendar() {
        datePicker = document.getElementById("calendar-date-picker");
        if (datePicker) {
            datePicker.value = window.currentScheduleDate;
            datePicker.addEventListener("change", onDateChanged);
        }
        setupEraseAll();
        startAutoSaveTimer();
        
        console.log("🗓️ Calendar initialized (FIXED v4.0 - DELETION FIX INTEGRATED)");
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
