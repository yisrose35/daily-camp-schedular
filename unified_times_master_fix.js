// =============================================================================
// CAMPISTRY UNIFIED TIMES MASTER FIX v1.0
// =============================================================================
//
// PROBLEM SUMMARY:
// ----------------
// On initial load, the schedule appears at wrong times because:
// 1. The scheduler generates scheduleAssignments using slot indices based on its unifiedTimes
//    (e.g., slot 2 = 11:00 AM based on skeleton block times)
// 2. On reload, unifiedTimes is rebuilt from skeleton using buildUnifiedTimesFromSkeleton()
//    which creates a generic 30-min grid (e.g., slot 2 = 9:30 AM)
// 3. The slot indices in scheduleAssignments no longer match the times → data appears wrong
//
// SOLUTION:
// ---------
// 1. Ensure unifiedTimes is ALWAYS saved to localStorage when schedule is saved
// 2. Ensure unifiedTimes is ALWAYS loaded from localStorage on initial load
// 3. Prevent buildUnifiedTimesFromSkeleton() from overwriting scheduler-generated times
//
// INSTALLATION:
// -------------
// Load this file AFTER all other Campistry scheduler modules.
// Add to your HTML: <script src="unified_times_master_fix.js"></script>
//
// =============================================================================

(function() {
    'use strict';

    console.log('═════════════════════════════════════════════════════════════════════');
    console.log('🔧 UNIFIED TIMES MASTER FIX v1.0');
    console.log('═════════════════════════════════════════════════════════════════════');

    // =========================================================================
    // CONFIGURATION
    // =========================================================================
    
    const DAILY_DATA_KEY = 'campDailyData_v1';
    const GLOBAL_SETTINGS_KEY = 'campGlobalSettings_v1';
    const DEBUG = true;

    // =========================================================================
    // UTILITIES
    // =========================================================================

    function log(msg, ...args) {
        if (DEBUG) console.log(`[UnifiedTimesFix] ${msg}`, ...args);
    }

    function getDateKey() {
        return window.currentScheduleDate || 
               document.getElementById('calendar-date-picker')?.value ||
               document.getElementById('schedule-date-input')?.value ||
               new Date().toISOString().split('T')[0];
    }

    function serializeUnifiedTimes(times) {
        if (!times || !Array.isArray(times)) return [];
        return times.map(t => {
            const startDate = t.start instanceof Date ? t.start : new Date(t.start);
            const endDate = t.end instanceof Date ? t.end : new Date(t.end);
            
            return {
                start: startDate.toISOString(),
                end: endDate.toISOString(),
                startMin: t.startMin ?? (startDate.getHours() * 60 + startDate.getMinutes()),
                endMin: t.endMin ?? (endDate.getHours() * 60 + endDate.getMinutes()),
                label: t.label || ''
            };
        });
    }

    function deserializeUnifiedTimes(times) {
        if (!times || !Array.isArray(times)) return [];
        return times.map(t => {
            const startDate = t.start instanceof Date ? t.start : new Date(t.start);
            const endDate = t.end instanceof Date ? t.end : new Date(t.end);
            
            let startMin = t.startMin;
            let endMin = t.endMin;
            
            if (startMin === undefined || startMin === null) {
                startMin = startDate.getHours() * 60 + startDate.getMinutes();
            }
            if (endMin === undefined || endMin === null) {
                endMin = endDate.getHours() * 60 + endDate.getMinutes();
            }
            
            return {
                start: startDate,
                end: endDate,
                startMin,
                endMin,
                label: t.label || ''
            };
        });
    }

    // Check if time grid is the generic 30-min grid vs scheduler-generated
    function isGeneric30MinGrid(times) {
        if (!times || times.length < 3) return false;
        
        for (let i = 1; i < times.length; i++) {
            const prevMin = times[i-1].startMin ?? 0;
            const currMin = times[i].startMin ?? 0;
            if ((currMin - prevMin) !== 30) return false;
        }
        return true;
    }

    // =========================================================================
    // FIX 1: ENSURE UNIFIEDTIMES IS SAVED TO LOCALSTORAGE
    // =========================================================================

    function saveUnifiedTimesToStorage(dateKey) {
        if (!window.unifiedTimes || window.unifiedTimes.length === 0) {
            return false;
        }

        try {
            const raw = localStorage.getItem(DAILY_DATA_KEY);
            const dailyData = raw ? JSON.parse(raw) : {};
            
            if (!dailyData[dateKey]) dailyData[dateKey] = {};
            
            dailyData[dateKey].unifiedTimes = serializeUnifiedTimes(window.unifiedTimes);
            dailyData[dateKey].slotCount = window.unifiedTimes.length;
            dailyData[dateKey]._unifiedTimesUpdatedAt = new Date().toISOString();
            
            localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(dailyData));
            
            log(`Saved unifiedTimes: ${window.unifiedTimes.length} slots for ${dateKey}`);
            return true;
        } catch (err) {
            console.error('[UnifiedTimesFix] Error saving unifiedTimes:', err);
            return false;
        }
    }

    // =========================================================================
    // FIX 2: LOAD UNIFIEDTIMES FROM LOCALSTORAGE
    // =========================================================================

    function loadUnifiedTimesFromStorage(dateKey, forceOverwrite = false) {
        try {
            const raw = localStorage.getItem(DAILY_DATA_KEY);
            if (!raw) {
                log('No localStorage data found');
                return false;
            }
            
            const dailyData = JSON.parse(raw);
            const dateData = dailyData[dateKey];
            
            if (!dateData) {
                log(`No data for date ${dateKey}`);
                return false;
            }
            
            if (!dateData.unifiedTimes || dateData.unifiedTimes.length === 0) {
                log(`No unifiedTimes stored for ${dateKey}`);
                return false;
            }
            
            const storedTimes = deserializeUnifiedTimes(dateData.unifiedTimes);
            const currentTimes = window.unifiedTimes || [];
            
            // Determine if we should replace current times
            const currentIsGeneric = isGeneric30MinGrid(currentTimes);
            const storedIsGeneric = isGeneric30MinGrid(storedTimes);
            
            const shouldReplace = forceOverwrite || 
                                  currentTimes.length === 0 ||
                                  (currentIsGeneric && !storedIsGeneric) ||
                                  currentTimes.length !== storedTimes.length;
            
            if (shouldReplace) {
                log(`Replacing unifiedTimes: ${currentTimes.length} → ${storedTimes.length} slots`);
                log(`  Current is generic: ${currentIsGeneric}, Stored is generic: ${storedIsGeneric}`);
                
                window.unifiedTimes = storedTimes;
                window._unifiedTimesFromCloud = true;
                window._unifiedTimesLoadedAt = Date.now();
                
                return true;
            } else {
                log(`Keeping existing unifiedTimes: ${currentTimes.length} slots`);
                return false;
            }
        } catch (err) {
            console.error('[UnifiedTimesFix] Error loading unifiedTimes:', err);
            return false;
        }
    }

    // =========================================================================
    // FIX 3: PATCH saveCurrentDailyData TO SAVE UNIFIEDTIMES
    // =========================================================================

    function patchSaveCurrentDailyData() {
        const original = window.saveCurrentDailyData;
        if (!original) {
            log('saveCurrentDailyData not found yet');
            return false;
        }
        
        if (original._unifiedTimesMasterPatched) {
            log('saveCurrentDailyData already patched');
            return true;
        }
        
        window.saveCurrentDailyData = function(...args) {
            const dateKey = getDateKey();
            
            // Save unifiedTimes BEFORE calling original
            // (ensures it's in localStorage for the save)
            saveUnifiedTimesToStorage(dateKey);
            
            // Call original
            return original.apply(this, args);
        };
        
        window.saveCurrentDailyData._unifiedTimesMasterPatched = true;
        log('✅ Patched saveCurrentDailyData');
        return true;
    }

    // =========================================================================
    // FIX 4: PATCH forceHydrateFromLocalStorage (SYNCPATCH)
    // =========================================================================

    function patchSyncPatch() {
        const existing = window.forceHydrateFromLocalStorage;
        
        if (!existing) {
            log('forceHydrateFromLocalStorage not found yet');
            return false;
        }
        
        if (existing._unifiedTimesMasterPatched) {
            log('forceHydrateFromLocalStorage already patched');
            return true;
        }
        
        const original = existing;
        
        window.forceHydrateFromLocalStorage = function(dateKey, forceOverwrite = false) {
            const date = dateKey || getDateKey();
            
            log(`Intercepting SyncPatch hydration for ${date}`);
            
            // Call original first (hydrates scheduleAssignments & leagueAssignments)
            const result = original.apply(this, arguments);
            
            // NOW also hydrate unifiedTimes
            loadUnifiedTimesFromStorage(date, forceOverwrite);
            
            return result;
        };
        
        window.forceHydrateFromLocalStorage._unifiedTimesMasterPatched = true;
        log('✅ Patched forceHydrateFromLocalStorage');
        return true;
    }

    // =========================================================================
    // FIX 5: HOOK INTO SCHEDULER GENERATION COMPLETE
    // =========================================================================

    function hookGenerationComplete() {
        window.addEventListener('campistry-generation-complete', () => {
            log('Generation complete, saving unifiedTimes...');
            const dateKey = getDateKey();
            saveUnifiedTimesToStorage(dateKey);
        });
        
        log('✅ Hooked generation complete event');
    }

    // =========================================================================
    // FIX 6: VERIFY AND FIX ON CLOUD HYDRATION
    // =========================================================================

    function verifyAndFixOnCloudHydration() {
        window.addEventListener('campistry-cloud-hydrated', () => {
            log('Cloud hydration complete, verifying unifiedTimes...');
            
            setTimeout(() => {
                const dateKey = getDateKey();
                const fixed = loadUnifiedTimesFromStorage(dateKey, true);
                
                if (fixed && window.updateTable) {
                    log('Triggering re-render after unifiedTimes fix...');
                    window.updateTable();
                }
            }, 200);
        });
        
        log('✅ Hooked cloud hydration event');
    }

    // =========================================================================
    // FIX 7: PERIODIC VERIFICATION
    // =========================================================================

    function schedulePeriodicVerification() {
        // After initial load, verify unifiedTimes is correct
        const checks = [500, 1500, 3000];
        
        checks.forEach(delay => {
            setTimeout(() => {
                const currentTimes = window.unifiedTimes || [];
                const currentIsGeneric = isGeneric30MinGrid(currentTimes);
                
                if (currentIsGeneric) {
                    log(`Periodic check at ${delay}ms: Found generic grid, attempting fix...`);
                    const dateKey = getDateKey();
                    const fixed = loadUnifiedTimesFromStorage(dateKey, true);
                    
                    if (fixed && window.updateTable) {
                        window.updateTable();
                    }
                }
            }, delay);
        });
    }

    // =========================================================================
    // DIAGNOSTIC FUNCTION
    // =========================================================================

    function diagnose() {
        const dateKey = getDateKey();
        
        console.log('\n═════════════════════════════════════════════════════════════════════');
        console.log('🔍 UNIFIED TIMES DIAGNOSTIC REPORT');
        console.log('═════════════════════════════════════════════════════════════════════');
        console.log(`Date: ${dateKey}`);
        console.log(`Time: ${new Date().toISOString()}`);
        
        // Window state
        const windowTimes = window.unifiedTimes || [];
        const windowIsGeneric = isGeneric30MinGrid(windowTimes);
        
        console.log(`\n📌 WINDOW STATE:`);
        console.log(`   Slots: ${windowTimes.length}`);
        console.log(`   Is Generic 30-min Grid: ${windowIsGeneric}`);
        console.log(`   From Cloud Flag: ${window._unifiedTimesFromCloud || false}`);
        
        if (windowTimes.length > 0) {
            console.log(`   First 5 slots:`);
            windowTimes.slice(0, 5).forEach((slot, i) => {
                const mins = slot.startMin ?? '?';
                const hr = Math.floor(mins / 60);
                const mn = mins % 60;
                console.log(`      [${i}] ${mins} min = ${hr}:${String(mn).padStart(2,'0')}`);
            });
        }
        
        // LocalStorage state
        try {
            const raw = localStorage.getItem(DAILY_DATA_KEY);
            if (raw) {
                const dailyData = JSON.parse(raw);
                const dateData = dailyData[dateKey] || {};
                const storedTimes = dateData.unifiedTimes || [];
                const storedIsGeneric = isGeneric30MinGrid(deserializeUnifiedTimes(storedTimes));
                
                console.log(`\n💾 LOCALSTORAGE STATE:`);
                console.log(`   Slots: ${storedTimes.length}`);
                console.log(`   Is Generic 30-min Grid: ${storedIsGeneric}`);
                console.log(`   Updated At: ${dateData._unifiedTimesUpdatedAt || 'unknown'}`);
                
                if (storedTimes.length > 0) {
                    console.log(`   First 5 slots:`);
                    storedTimes.slice(0, 5).forEach((slot, i) => {
                        const mins = slot.startMin ?? '?';
                        console.log(`      [${i}] ${mins} min`);
                    });
                }
                
                // Compare
                console.log(`\n🔄 COMPARISON:`);
                if (windowTimes.length === storedTimes.length) {
                    console.log(`   ✅ Slot counts match`);
                } else {
                    console.log(`   ⚠️ MISMATCH: Window=${windowTimes.length}, Storage=${storedTimes.length}`);
                }
                
                if (windowIsGeneric && !storedIsGeneric) {
                    console.log(`   ⚠️ Window has generic grid but storage has scheduler grid!`);
                    console.log(`   🔧 Run: UnifiedTimesMasterFix.forceFix() to repair`);
                } else if (!windowIsGeneric && storedIsGeneric) {
                    console.log(`   ℹ️ Window has scheduler grid, storage has generic (may need save)`);
                } else {
                    console.log(`   ✅ Grid types match`);
                }
            } else {
                console.log(`\n💾 LOCALSTORAGE: No daily data found`);
            }
        } catch (err) {
            console.error('Error reading localStorage:', err);
        }
        
        console.log('\n═════════════════════════════════════════════════════════════════════');
        
        return { dateKey, windowSlots: windowTimes.length, windowIsGeneric };
    }

    // =========================================================================
    // FORCE FIX FUNCTION
    // =========================================================================

    function forceFix() {
        const dateKey = getDateKey();
        log(`Force fixing unifiedTimes for ${dateKey}...`);
        
        const fixed = loadUnifiedTimesFromStorage(dateKey, true);
        
        if (fixed) {
            if (window.updateTable) {
                window.updateTable();
            }
            console.log('✅ Force fix applied successfully');
            return true;
        } else {
            console.log('⚠️ No valid stored unifiedTimes to restore');
            return false;
        }
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    function initialize() {
        log('Initializing...');
        
        // Patch functions
        const patchAll = () => {
            patchSaveCurrentDailyData();
            patchSyncPatch();
        };
        
        patchAll();
        setTimeout(patchAll, 100);
        setTimeout(patchAll, 500);
        setTimeout(patchAll, 1000);
        setTimeout(patchAll, 2000);
        
        // Hook events
        hookGenerationComplete();
        verifyAndFixOnCloudHydration();
        
        // Schedule verification
        schedulePeriodicVerification();
        
        log('✅ Initialization complete');
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    window.UnifiedTimesMasterFix = {
        version: '1.0',
        
        // Manual operations
        save: () => saveUnifiedTimesToStorage(getDateKey()),
        load: () => loadUnifiedTimesFromStorage(getDateKey(), true),
        forceFix: forceFix,
        diagnose: diagnose,
        
        // Utilities
        getDateKey: getDateKey,
        isGenericGrid: isGeneric30MinGrid,
        
        // State inspection
        getState: () => ({
            dateKey: getDateKey(),
            windowSlots: (window.unifiedTimes || []).length,
            fromCloud: window._unifiedTimesFromCloud || false,
            isGeneric: isGeneric30MinGrid(window.unifiedTimes || [])
        })
    };

    // =========================================================================
    // STARTUP
    // =========================================================================

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        setTimeout(initialize, 50);
    }

    console.log('═════════════════════════════════════════════════════════════════════');
    console.log('🔧 UNIFIED TIMES MASTER FIX v1.0 LOADED');
    console.log('');
    console.log('   Commands:');
    console.log('   - UnifiedTimesMasterFix.diagnose()  → Check current state');
    console.log('   - UnifiedTimesMasterFix.forceFix()  → Force reload from storage');
    console.log('   - UnifiedTimesMasterFix.getState()  → Quick state summary');
    console.log('');
    console.log('═════════════════════════════════════════════════════════════════════');

})();
